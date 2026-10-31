import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  connectionOperationKey,
  reconcileConnection,
  type ConnectionAdapter,
  type ConnectorRecord,
  type ConnectorVerification,
} from "../src/connection/reconciler.js";
import {
  canonicalRepositoryFor,
  bindingMatches,
  endpointFingerprint,
  getInstallationIdentity,
  makeConnectionBinding,
  readConnectionBinding,
  writeConnectionBinding,
  type ConnectionBinding,
} from "../src/connection/identity.js";
import {
  deliverMessage,
  messageIdempotencyKey,
  type MessageAdapter,
  type RemoteMessageState,
} from "../src/conversation/delivery.js";
import { bindConversation, readConversationBinding } from "../src/conversation/registry.js";
import { isAppSelectionVerifiedForIntent, readAppSelection, recordAppSelection } from "../src/conversation/app-selection.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";
import { writeSecureFile, writeSecureJson, writeAtomicSecureJson } from "../src/config/paths.js";
import { acquireLease, type AcquiredLease } from "../src/config/lease.js";

describe("lease recovery ownership", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = isolateStateDir(); });
  afterEach(() => { vi.restoreAllMocks(); cleanup(stateDir); });
  const dead = { schemaVersion: 1, leaseId: "dead-owner", pid: 999999, acquiredAt: new Date(0).toISOString() };
  const options = { staleAfterMs: 0, attempts: 4, processIsAlive: (pid: number) => pid !== dead.pid };

  it("admits only one owner when two stale reclaimers interleave before removal", () => {
    const file = path.join(stateDir, "owner.lock"); fs.writeFileSync(file, JSON.stringify(dead));
    const originalRead = fs.readFileSync;
    let reads = 0; let outer: AcquiredLease | undefined; let inner: AcquiredLease | undefined;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const bytes = Reflect.apply(originalRead, fs, args);
      if (args[0] === file && ++reads === 2) {
        try { inner = acquireLease(file, options); } catch (error) { expect(String(error)).toMatch(/locked/); }
      }
      return bytes;
    });
    try {
      try { outer = acquireLease(file, options); } catch (error) { expect(String(error)).toMatch(/locked/); }
      expect([outer, inner].filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(originalRead(file, "utf8")).leaseId).toBe((outer ?? inner)!.record.leaseId);
    } finally { vi.restoreAllMocks(); outer?.release(); inner?.release(); }
  });

  it("does not reclaim an owner whose liveness observation is denied", () => {
    const file = path.join(stateDir, "owner.lock"); const before = JSON.stringify(dead); fs.writeFileSync(file, before);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("synthetic denied observation"), { code: "EPERM" }); });
    expect(() => acquireLease(file, { staleAfterMs: 0, attempts: 2 })).toThrow(/locked/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each(["EACCES", "EOPNOTSUPP"])("preserves a dead lease when atomic recovery claim creation fails with %s", code => {
    const file = path.join(stateDir, "owner.lock"); const before = JSON.stringify(dead); fs.writeFileSync(file, before);
    vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("synthetic link failure"), { code }); });
    expect(() => acquireLease(file, options)).toThrow(/locked/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("retains an orphaned recovery claim for explicit reconciliation", () => {
    const file = path.join(stateDir, "owner.lock"); const before = JSON.stringify(dead); fs.writeFileSync(file, before);
    const claim = file + ".reclaim." + Buffer.from(dead.leaseId).toString("base64url"); fs.linkSync(file, claim);
    expect(() => acquireLease(file, options)).toThrow(/locked/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readFileSync(claim, "utf8")).toBe(before);
  });
});

describe("atomic state persistence compatibility", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = isolateStateDir(); });
  afterEach(() => { vi.restoreAllMocks(); cleanup(stateDir); });

  it("keeps legacy saves atomic without fsync and requests file durability only on the explicit route", () => {
    const file = path.join(stateDir, "state.json");
    const fsync = vi.spyOn(fs, "fsyncSync");
    writeSecureFile(file, "legacy bytes");
    writeSecureJson(file, { legacy: true });
    expect(fsync).not.toHaveBeenCalled();
    writeAtomicSecureJson(file, { durable: true });
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ durable: true });
    expect(fs.readdirSync(stateDir)).toEqual(["state.json"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each(["writeFileSync", "fsyncSync", "closeSync", "renameSync"] as const)("preserves old raw bytes and removes its temporary after %s failure", operation => {
    const file = path.join(stateDir, "state.json");
    const before = Buffer.from([0, 255, 13, 10, 7]);
    fs.writeFileSync(file, before);
    vi.spyOn(fs, operation).mockImplementationOnce(() => { throw new Error("synthetic save failure"); });
    expect(() => writeAtomicSecureJson(file, { replacement: true })).toThrow("synthetic save failure");
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(stateDir)).toEqual(["state.json"]);
  });

  it("preserves another writer's temporary when exclusive creation fails", () => {
    const file = path.join(stateDir, "state.json");
    fs.writeFileSync(file, "old bytes");
    let foreignTemporary = "";
    vi.spyOn(fs, "openSync").mockImplementationOnce(temporary => {
      foreignTemporary = String(temporary);
      fs.writeFileSync(foreignTemporary, "foreign bytes");
      throw new Error("synthetic exclusive-create collision");
    });
    expect(() => writeAtomicSecureJson(file, { replacement: true })).toThrow("synthetic exclusive-create collision");
    expect(fs.readFileSync(file, "utf8")).toBe("old bytes");
    expect(fs.readFileSync(foreignTemporary, "utf8")).toBe("foreign bytes");
  });
});

function binding(overrides: Partial<ConnectionBinding> = {}): ConnectionBinding {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-a",
    workspace: "demo",
    canonicalRepository: "https://github.com/example/demo",
    installationId: "11111111-1111-4111-8111-111111111111",
    endpointMode: "ephemeral",
    endpointFingerprint: endpointFingerprint("https://one.example/mcp", "ephemeral"),
    connectorName: "Codex with ChatGPT · demo · 11111111",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeConnectors implements ConnectionAdapter {
  connectors: ConnectorRecord[] = [];
  createCalls = 0;
  deleteCalls = 0;
  createMode: "success" | "timeout-after-create" | "timeout" = "success";
  deleteMode: "success" | "timeout-after-delete" | "timeout" = "success";
  listAvailable = true;
  listFailuresRemaining = 0;
  workspaceInfoFailuresRemaining = 0;
  verification: Partial<ConnectorVerification> = {};

  async listConnectors(): Promise<ConnectorRecord[]> {
    if (!this.listAvailable) throw new Error("list unavailable");
    if (this.listFailuresRemaining > 0) {
      this.listFailuresRemaining -= 1;
      throw new Error("transient list failure");
    }
    return [...this.connectors];
  }

  async createConnector(next: ConnectionBinding): Promise<ConnectorRecord> {
    this.createCalls++;
    const record: ConnectorRecord = {
      id: `connector-${this.createCalls}`,
      name: next.connectorName,
      workspace: next.workspace,
      repository: next.canonicalRepository,
      installationId: next.installationId,
      endpointMode: next.endpointMode,
      endpointFingerprint: next.endpointFingerprint,
    };
    if (this.createMode !== "timeout") this.connectors.push(record);
    if (this.createMode !== "success") throw new Error("transport timeout");
    return record;
  }

  async deleteConnector(id: string): Promise<void> {
    this.deleteCalls++;
    if (this.deleteMode !== "timeout") this.connectors = this.connectors.filter((connector) => connector.id !== id);
    if (this.deleteMode !== "success") throw new Error("transport timeout");
  }

  async workspaceInfo(connector: ConnectorRecord) {
    if (this.workspaceInfoFailuresRemaining > 0) {
      this.workspaceInfoFailuresRemaining -= 1;
      throw new Error("transient workspace_info failure");
    }
    return {
      workspace: connector.workspace,
      repository: connector.repository,
      ok: true,
      ...this.verification,
    };
  }
}

describe("connection identity and connector reconciliation", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("persists one installation identity and refuses credential-bearing repository remotes", () => {
    const repo = makeTmpDir("identity-repo");
    makeGitRepo(repo);
    git(repo, "remote", "add", "origin", "https://user:secret@GitHub.com/Example/demo.git");
    const first = getInstallationIdentity();
    const second = getInstallationIdentity();
    expect(second.installationId).toBe(first.installationId);
    expect(() => canonicalRepositoryFor(repo)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
    git(repo, "remote", "set-url", "origin", "https://github.com/Example/demo.git");
    expect(canonicalRepositoryFor(repo)).toBe("https://github.com/example/demo");
    const saved = makeConnectionBinding({
      workspaceId: "workspace-a",
      workspace: "demo",
      workspaceRoot: repo,
      endpoint: "https://one.example/mcp",
      endpointMode: "ephemeral",
    });
    writeConnectionBinding(saved);
    expect(readConnectionBinding("workspace-a")?.connectorName).toBe(saved.connectorName);
    cleanup(repo);
  });

  it("rejects the old binding when shared selection switches from origin to an upstream repository", () => {
    const repo = makeTmpDir("upstream-binding"); makeGitRepo(repo);
    try {
      git(repo, "remote", "add", "origin", "https://github.com/example/fork");
      const previous = makeConnectionBinding({ workspaceId: "shared-selector", workspace: "demo", workspaceRoot: repo });
      git(repo, "remote", "add", "upstream", "https://github.com/example/source");
      git(repo, "config", "branch.main.remote", "upstream"); git(repo, "config", "branch.main.merge", "refs/heads/main");
      const current = makeConnectionBinding({ workspaceId: "shared-selector", workspace: "demo", workspaceRoot: repo });
      expect(bindingMatches(previous, current)).toBe(false);
      expect(previous.canonicalRepository).toBe("https://github.com/example/fork");
      expect(current.canonicalRepository).toBe("https://github.com/example/source");
    } finally { cleanup(repo); }
  });

  it("reuses an existing connector with zero mutations", async () => {
    const b = binding();
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(result.mutations).toEqual({ create: 0, delete: 0 });
  });

  it("retries transient connector reads before waiting for the user", async () => {
    const b = binding();
    const adapter = new FakeConnectors();
    adapter.listFailuresRemaining = 1;
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(result.mutations).toEqual({ create: 0, delete: 0 });
  });

  it("retries transient workspace verification before converting to waiting", async () => {
    const b = binding();
    const adapter = new FakeConnectors();
    adapter.workspaceInfoFailuresRemaining = 1;
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(result.phase).toBe("REUSE");
  });

  it("waits when account proof is missing and blocks on an account mismatch", async () => {
    const b = binding({ accountFingerprint: "account-a" });
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    expect((await reconcileConnection(b, adapter)).status).toBe("CONNECTION_WAITING");
    adapter.verification = { accountFingerprint: "account-b" };
    expect((await reconcileConnection(b, adapter)).status).toBe("BLOCKED");
  });

  it("waits when Project proof is missing and blocks on a Project mismatch", async () => {
    const b = binding({ projectId: "project-a" });
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    expect((await reconcileConnection(b, adapter)).status).toBe("CONNECTION_WAITING");
    adapter.verification = { projectBinding: "project-b" };
    expect((await reconcileConnection(b, adapter)).status).toBe("BLOCKED");
  });

  it("waits for read-only proof, blocks non-read-only connectors, and reuses exact proof", async () => {
    const b = binding({ readOnlyRequired: true });
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    expect((await reconcileConnection(b, adapter)).status).toBe("CONNECTION_WAITING");
    adapter.verification = { readOnly: false };
    expect((await reconcileConnection(b, adapter)).status).toBe("BLOCKED");
    adapter.verification = { readOnly: true };
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(result.mutations).toEqual({ create: 0, delete: 0 });
  });

  it("reuses a connector only when all configured account, Project, and read-only proofs match", async () => {
    const b = binding({ accountFingerprint: "account-a", projectId: "project-a", readOnlyRequired: true });
    const adapter = new FakeConnectors();
    adapter.verification = { accountFingerprint: "account-a", projectBinding: "project-a", readOnly: true };
    adapter.connectors = [{
      id: "existing",
      name: b.connectorName,
      workspace: b.workspace,
      repository: b.canonicalRepository,
      installationId: b.installationId,
      endpointMode: b.endpointMode,
      endpointFingerprint: b.endpointFingerprint,
    }];
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(result.mutations).toEqual({ create: 0, delete: 0 });
  });

  it("creates and verifies a missing connector exactly once", async () => {
    const adapter = new FakeConnectors();
    const result = await reconcileConnection(binding(), adapter);
    expect(result.status).toBe("READY");
    expect(adapter.createCalls).toBe(1);
    expect(result.mutations.create).toBe(1);
  });

  it("reconciles a create timeout that actually created without retrying", async () => {
    const adapter = new FakeConnectors();
    adapter.createMode = "timeout-after-create";
    const b = binding();
    const result = await reconcileConnection(b, adapter);
    expect(result.status).toBe("READY");
    expect(adapter.createCalls).toBe(1);
    expect(result.checkpoint.createAttempts).toBe(1);
  });

  it("does not delete a same-name unrelated connector", async () => {
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "foreign",
      name: binding().connectorName,
      workspace: "other",
      repository: "https://github.com/other/repo",
      installationId: "22222222-2222-4222-8222-222222222222",
      endpointMode: "ephemeral",
      endpointFingerprint: endpointFingerprint("https://other.example/mcp", "ephemeral"),
    }];
    const result = await reconcileConnection(binding(), adapter);
    expect(result.status).toBe("CONNECTION_WAITING");
    expect(adapter.deleteCalls).toBe(0);
    expect(adapter.createCalls).toBe(0);
  });

  it("deletes only the owned old endpoint, verifies absence, then creates once", async () => {
    const old = binding();
    const next = binding({ endpointFingerprint: endpointFingerprint("https://two.example/mcp", "ephemeral") });
    const adapter = new FakeConnectors();
    adapter.connectors = [{
      id: "old",
      name: old.connectorName,
      workspace: old.workspace,
      repository: old.canonicalRepository,
      installationId: old.installationId,
      endpointMode: old.endpointMode,
      endpointFingerprint: old.endpointFingerprint,
    }];
    const result = await reconcileConnection(next, adapter);
    expect(result.status).toBe("READY");
    expect(adapter.deleteCalls).toBe(1);
    expect(adapter.createCalls).toBe(1);
  });

  it("stops after an uncertain delete and never creates", async () => {
    const old = binding();
    const next = binding({ endpointFingerprint: endpointFingerprint("https://two.example/mcp", "ephemeral") });
    const adapter = new FakeConnectors();
    adapter.deleteMode = "timeout";
    adapter.connectors = [{
      id: "old",
      name: old.connectorName,
      workspace: old.workspace,
      repository: old.canonicalRepository,
      installationId: old.installationId,
      endpointMode: old.endpointMode,
      endpointFingerprint: old.endpointFingerprint,
    }];
    const result = await reconcileConnection(next, adapter);
    expect(result.status).toBe("CONNECTION_WAITING");
    expect(adapter.createCalls).toBe(0);
  });

  it("keeps two installations independent even for the same workspace", async () => {
    const one = binding();
    const two = binding({
      workspaceId: "workspace-b",
      installationId: "22222222-2222-4222-8222-222222222222",
      connectorName: "Codex with ChatGPT · demo · 22222222",
    });
    expect(connectionOperationKey(one)).not.toBe(connectionOperationKey(two));
    const adapter = new FakeConnectors();
    const first = await reconcileConnection(one, adapter);
    const second = await reconcileConnection(two, adapter);
    expect(first.status).toBe("READY");
    expect(second.status).toBe("READY");
    expect(adapter.deleteCalls).toBe(0);
    expect(adapter.connectors).toHaveLength(2);
  });

  it("resumes a partially verified approved connection and the same selected message without recreating or resending", async () => {
    const b = binding({ accountFingerprint: "synthetic-account", readOnlyRequired: true });
    const firstAdapter = new FakeConnectors();
    firstAdapter.createMode = "timeout-after-create";
    firstAdapter.workspaceInfoFailuresRemaining = 2;
    firstAdapter.verification = { accountFingerprint: b.accountFingerprint, readOnly: true };
    const first = await reconcileConnection(b, firstAdapter);
    expect(first.status).toBe("CONNECTION_WAITING");
    expect(firstAdapter.createCalls).toBe(1);

    const intent = { taskId: "resume-approved-task", iteration: 4, messageId: "resume-selected-message", text: "synthetic bounded task" };
    const selection = {
      workspaceId: b.workspaceId, targetWorkstream: "c2c-consent-temporary-codes", connectorName: b.connectorName,
      intent, requestedApp: b.connectorName, selectionMethod: "composer" as const,
    };
    recordAppSelection({ ...selection, currentMessageAvailable: true, invocation: "pending", workspaceVerified: false });
    writeSession(b.workspaceId, mergeSession(null, {
      url: "https://chatgpt.com/c/synthetic-resume", taskId: intent.taskId, iteration: intent.iteration,
      checkpoint: { protocolState: "EXECUTING", waitingFor: "none", nextExpectedStep: "verify current connection" },
    }));

    const resumedAdapter = new FakeConnectors();
    resumedAdapter.connectors = [...firstAdapter.connectors];
    resumedAdapter.verification = { ...firstAdapter.verification };
    expect(readSession(b.workspaceId)?.checkpoint?.taskId).toBe(intent.taskId);
    expect(isAppSelectionVerifiedForIntent(b.workspaceId, intent)).toBe(false);
    const resumed = await reconcileConnection(b, resumedAdapter);
    expect(resumed).toMatchObject({ status: "READY", phase: "REUSE", mutations: { create: 0, delete: 0 } });
    expect(resumed.operationKey).toBe(first.operationKey);
    expect(resumed.checkpoint.createAttempts).toBe(1);
    recordAppSelection({ ...selection, currentMessageAvailable: true, invocation: "succeeded", workspaceVerified: true });
    expect(readAppSelection(b.workspaceId, intent)?.messageKey).toBe(messageIdempotencyKey(intent));
    expect(isAppSelectionVerifiedForIntent(b.workspaceId, intent)).toBe(true);

    let sendCalls = 0;
    const messages: MessageAdapter = {
      async sendMessage() { sendCalls += 1; throw new Error("synthetic ambiguous transport"); },
      async getMessageStatus() { return "accepted"; },
    };
    expect((await deliverMessage(intent, messages)).result).toBe("CONFIRMED");
    writeSession(b.workspaceId, mergeSession(readSession(b.workspaceId), {
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    }));
    expect((await deliverMessage(intent, messages)).result).toBe("CONFIRMED");
    expect(sendCalls).toBe(1);
    expect(readSession(b.workspaceId)?.checkpoint).toMatchObject({ taskId: intent.taskId, protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" });
    expect(fs.readFileSync(path.join(stateDir, "messages", `${messageIdempotencyKey(intent)}.json`), "utf8")).not.toContain(intent.text);
  });
});

describe("message delivery idempotency", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  class FakeMessages implements MessageAdapter {
    status: RemoteMessageState = "missing";
    sendCalls = 0;
    statusCalls = 0;
    sendMode: "success" | "timeout" = "success";
    async sendMessage() {
      this.sendCalls++;
      if (this.status === "accepted" && this.sendMode === "success") return { remoteId: "remote-1" };
      throw new Error("transport timeout");
    }
    async getMessageStatus() {
      this.statusCalls++;
      return this.status;
    }
  }

  const intent = { taskId: "task-1", iteration: 2, messageId: "message-1", text: "bounded task" };

  it("refuses unreadable checkpoints without using them as an absent record", async () => {
    const key = messageIdempotencyKey(intent); const file = path.join(stateDir, "messages", `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "retained private bytes");
    const adapter = new FakeMessages();
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw Object.assign(new Error("synthetic denied read"), { code: "EACCES" }); });
    try { await expect(deliverMessage(intent, adapter)).rejects.toThrow(/checkpoint/); }
    finally { read.mockRestore(); }
    expect(adapter.sendCalls).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("retained private bytes");
  });

  it.each(["payload", "identity", "schema", "state", "malformed"])("retains a rejected %s checkpoint without sending or replacing its bytes", variant => {
    const key = messageIdempotencyKey(intent);
    const file = path.join(stateDir, "messages", `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const saved = {
      schemaVersion: 1, idempotencyKey: key, taskId: intent.taskId, iteration: intent.iteration, messageId: intent.messageId,
      messageHash: createHash("sha256").update(intent.text).digest("hex").slice(0, 24),
      state: "sending", sendAttempts: 1, updatedAt: "2026-10-12T00:00:00.000Z",
    };
    const before = variant === "malformed" ? Buffer.from("{incomplete") : Buffer.from(JSON.stringify({
      ...saved, ...(variant === "payload" ? { messageHash: "other-payload" } : {}),
      ...(variant === "identity" ? { idempotencyKey: "other-key" } : {}),
      ...(variant === "schema" ? { schemaVersion: 99 } : {}), ...(variant === "state" ? { state: "UNKNOWN_NEW_STATE" } : {}),
    }));
    fs.writeFileSync(file, before);
    const adapter = new FakeMessages();
    return expect(deliverMessage(intent, adapter)).rejects.toThrow(/checkpoint/).then(() => {
      expect(adapter.sendCalls).toBe(0);
      expect(adapter.statusCalls).toBe(0);
      expect(fs.readFileSync(file)).toEqual(before);
    });
  });

  it("confirms a successful send and remains idempotent on restart", async () => {
    const adapter = new FakeMessages();
    adapter.status = "accepted";
    const first = await deliverMessage(intent, adapter);
    const second = await deliverMessage(intent, adapter);
    expect(first.result).toBe("CONFIRMED");
    expect(second.result).toBe("CONFIRMED");
    expect(adapter.sendCalls).toBe(1);
  });

  it("confirms a timeout that was accepted remotely without resend", async () => {
    const adapter = new FakeMessages();
    adapter.status = "accepted";
    adapter.sendMode = "timeout";
    const result = await deliverMessage(intent, adapter);
    expect(result.result).toBe("CONFIRMED");
    expect(adapter.sendCalls).toBe(1);
    expect(adapter.statusCalls).toBe(1);
  });

  it("blocks ambiguous delivery and does not blind resend", async () => {
    const adapter = new FakeMessages();
    adapter.status = "unknown";
    const first = await deliverMessage(intent, adapter);
    const second = await deliverMessage(intent, adapter);
    expect(first.result).toBe("WAITING");
    expect(second.result).toBe("WAITING");
    expect(adapter.sendCalls).toBe(1);
  });

  it("waits for long reasoning rather than treating it as failure", async () => {
    const adapter = new FakeMessages();
    adapter.status = "reasoning";
    const result = await deliverMessage(intent, adapter);
    expect(result.result).toBe("WAITING");
    expect(result.remoteState).toBe("reasoning");
    expect(adapter.sendCalls).toBe(1);
  });

  it("derives a deterministic key from task, iteration and message ID", () => {
    expect(messageIdempotencyKey(intent)).toBe(messageIdempotencyKey(intent));
    expect(messageIdempotencyKey(intent)).not.toBe(messageIdempotencyKey({ ...intent, iteration: 3 }));
  });

  it.each(["prepared", "sending", "ambiguous", "confirmed"] as const)("reconciles a saved %s delivery without blindly resending", async (state) => {
    const key = messageIdempotencyKey(intent);
    const file = path.join(stateDir, "messages", `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, idempotencyKey: key, taskId: intent.taskId, iteration: intent.iteration,
      messageId: intent.messageId, messageHash: createHash("sha256").update(intent.text).digest("hex").slice(0, 24),
      state, sendAttempts: state === "prepared" ? 0 : 1, updatedAt: "2026-10-12T00:00:00.000Z",
    }));
    const adapter = new FakeMessages();
    adapter.status = "accepted";
    expect((await deliverMessage(intent, adapter)).result).toBe("CONFIRMED");
    expect(adapter.sendCalls).toBe(state === "prepared" ? 1 : 0);
    expect(adapter.statusCalls).toBe(state === "sending" || state === "ambiguous" ? 1 : 0);
  });

  it.each(["pending", "in_progress", "reasoning", "failed", "unknown", "missing"] as const)("rechecks a %s remote result without sending again", async (remoteState) => {
    const adapter = new FakeMessages();
    adapter.status = remoteState;
    const first = await deliverMessage(intent, adapter);
    const resumed = await deliverMessage(intent, adapter);
    expect(first.result).toBe(remoteState === "failed" ? "BLOCKED" : "WAITING");
    expect(resumed.result).toBe(first.result);
    expect(adapter.sendCalls).toBe(1);
    expect(adapter.statusCalls).toBe(2);
  });
});

describe("conversation registry identity", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("separates planning and review conversations and rejects mismatched resumes", () => {
    const workspaceId = "workspace-a";
    const common = {
      projectId: "project-1",
      conversationId: "conversation-plan",
      workspace: "demo",
      repository: "https://github.com/example/demo",
      workId: "issue-42",
      role: "planner",
    } as const;
    bindConversation(workspaceId, { ...common, stage: "planning", updatedAt: new Date().toISOString() });
    bindConversation(workspaceId, { ...common, conversationId: "conversation-review", stage: "plan_review", role: "reviewer", updatedAt: new Date().toISOString() });
    expect(readConversationBinding(workspaceId, { ...common, stage: "planning" })?.conversationId).toBe("conversation-plan");
    expect(readConversationBinding(workspaceId, { ...common, stage: "plan_review", role: "reviewer" })?.conversationId).toBe("conversation-review");
    expect(() => readConversationBinding(workspaceId, { ...common, stage: "planning", workspace: "wrong" })).toThrow(/identity mismatch/);
  });

  it("keeps an operation target bound to the exact review conversation", () => {
    const workspaceId = "workspace-operation";
    const target = {
      kind: "issue_update" as const,
      repository: "https://github.com/example/demo",
      logicalOperationId: "issue-update-6",
      issueNumber: 6,
      expectedRevision: "revision-6",
    };
    bindConversation(workspaceId, {
      projectId: "project-1",
      conversationId: "conversation-review",
      workspace: "demo",
      repository: target.repository,
      workId: "issue-6",
      stage: "pr_review",
      role: "reviewer",
      checkpoint: "c2c_operation",
      eventKey: "c2c_operation",
      operationKey: "operation-a",
      operationTarget: target,
      updatedAt: new Date().toISOString(),
    });
    expect(
      readConversationBinding(workspaceId, {
        repository: target.repository,
        workId: "issue-6",
        stage: "pr_review",
        role: "reviewer",
        checkpoint: "c2c_operation",
        eventKey: "c2c_operation",
        operationKey: "operation-a",
        operationTarget: target,
      })?.operationTarget
    ).toEqual(target);
    expect(() => readConversationBinding(workspaceId, {
      repository: target.repository,
      workId: "issue-6",
      stage: "pr_review",
      role: "reviewer",
      checkpoint: "c2c_operation",
      eventKey: "c2c_operation",
      operationKey: "operation-a",
      operationTarget: { ...target, expectedRevision: "other" },
    })).toThrow(/identity mismatch/);
  });
});
