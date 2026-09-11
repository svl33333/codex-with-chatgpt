import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectionOperationKey,
  reconcileConnection,
  type ConnectionAdapter,
  type ConnectorRecord,
} from "../src/connection/reconciler.js";
import {
  canonicalRepositoryFor,
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
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

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

  async listConnectors(): Promise<ConnectorRecord[]> {
    if (!this.listAvailable) throw new Error("list unavailable");
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
    return { workspace: connector.workspace, repository: connector.repository, ok: true };
  }
}

describe("connection identity and connector reconciliation", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("persists one installation identity and strips credentials from repository remotes", () => {
    const repo = makeTmpDir("identity-repo");
    makeGitRepo(repo);
    git(repo, "remote", "add", "origin", "https://user:secret@GitHub.com/Example/demo.git");
    const first = getInstallationIdentity();
    const second = getInstallationIdentity();
    expect(second.installationId).toBe(first.installationId);
    expect(canonicalRepositoryFor(repo)).toBe("https://github.com/Example/demo");
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
    async sendMessage() {
      this.sendCalls++;
      if (this.status === "accepted") return { remoteId: "remote-1" };
      throw new Error("transport timeout");
    }
    async getMessageStatus() {
      return this.status;
    }
  }

  const intent = { taskId: "task-1", iteration: 2, messageId: "message-1", text: "bounded task" };

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
    const result = await deliverMessage(intent, adapter);
    expect(result.result).toBe("CONFIRMED");
    expect(adapter.sendCalls).toBe(1);
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
});
