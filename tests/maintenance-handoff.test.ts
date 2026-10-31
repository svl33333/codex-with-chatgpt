import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { createMaintenanceHandoffTransaction } from "../src/conversation/transaction.js";
import { claimMaintenanceSendOwnedLease, readMaintenanceReceipt, withOwnedEventLease } from "../src/conversation/authorization.js";
import { loadMaintenanceGrant, reserveMaintenanceReturn } from "../src/conversation/delegation.js";
import { deliverMaintenanceNotice } from "../src/conversation/delivery.js";
import { CONTINUATION_KEYS, maintenanceGoalSchema } from "../src/runner/goal.js";
import { runnerFiles, withMaintenanceGoalLease } from "../src/runner/state.js";
import { acquireLease } from "../src/config/lease.js";
import { MAINTENANCE_HANDOFF_PROFILE, maintenanceEventKey, parseMaintenanceInstruction, renderMaintenanceResult, resolveMaintenanceAuthority,
  type MaintenanceHost, type MaintenanceProviderTurn, type MaintenanceTarget } from "../src/conversation/maintenance-handoff.js";

describe("Maintenance owner handoff fixtures (not real Browser or two-cycle E2E)", () => {
  let stateDir: string;
  let root: string;
  let target: MaintenanceTarget;
  let host: MaintenanceHost;
  let provider: MaintenanceProviderTurn;
  let goal: ReturnType<typeof maintenanceGoalSchema.parse>;
  const send = vi.fn(async (_input: { idempotencyKey: string; text: string }): Promise<{ remoteId?: string }> => ({ remoteId: "fixture-bubble" }));
  const observe = vi.fn(async ({ eventKey, payloadHash }: { eventKey: string; payloadHash: string }) => ({ visible: true, observedEventKey: eventKey, observedPayloadHash: payloadHash }));

  function recordTarget(next: MaintenanceTarget): void {
    appendExecutionRecord(next.workspaceId, { taskId: next.operationId, iteration: 1, changedFiles: 0, tests: "fixture", exitStatus: "success",
      timestamp: new Date().toISOString(), outputId: next.result.outputId, outputAvailable: true,
      maintenance: { profile: MAINTENANCE_HANDOFF_PROFILE, goalRef: next.goalId, planRef: next.planRef, operationId: next.operationId, sessionId: next.sessionId, turnId: next.turnId, head: next.head, resultSha256: next.result.sha256 } });
  }
  function saveResult(operationId = "operation-a", turnId = "turn-a"): MaintenanceTarget {
    const output = saveExecutionOutput("maintenance-fixture", { command: "fixture result", raw: `Saved ${operationId}: tests passed`, exitCode: 0 });
    const readable = readExecutionOutput("maintenance-fixture", output.id);
    if (!readable.ok) throw new Error("fixture output unavailable");
    const next = { workspaceId: "maintenance-fixture", workspaceRoot: root, repository: "https://github.com/example/runtime", worktreeRoot: root,
      branch: "main", head: git(root, "rev-parse", "HEAD").trim(), workstream: "maintenance-fixture", goalId: "goal-fixture", planRef: "plan:fixture-v2",
      operationId, sessionId: "session-fixture", turnId, projectId: "project-fixture", chatId: "chat-fixture", replyRef: "binding:fixture-chat",
      mode: "chat" as const, role: "builder" as const, result: { outputId: output.id, sha256: createHash("sha256").update(readable.text).digest("hex") } };
    recordTarget(next);
    return next;
  }
  function pending() { return withMaintenanceGoalLease(goal, target, (checkpoint) => structuredClone(checkpoint.pending)); }
  function nextInstruction(operationId = "operation-b") {
    return `[CHATGPT-GENERATED TASK INSTRUCTION]\nprovenance: chatgpt\npurpose: task_instruction\nworkflow_authority: none\nrecipient: codex\nhandoff_profile: ${MAINTENANCE_HANDOFF_PROFILE}\ngoal_ref: ${goal.id}\nplan_ref: ${goal.planRef}\nworkstream: ${target.workstream}\noperation_id: ${operationId}\ncodex_session: ${target.sessionId}\nreply_ref: ${target.replyRef}\n\nTASK\nEvaluate the actual prior result: ${provider.fullFinal}\n`;
  }
  function enableForward() {
    provider.status = "completed"; provider.fullFinal = "Actual fixture result A"; provider.finalRef = "provider:final-a";
    host.readInstruction = vi.fn(async (reference) => ({ source: "provider", authorKind: "assistant", projectId: target.projectId,
      chatId: target.chatId, chatTurnId: "chat-turn-b", basedOnFinalRef: "provider:final-a", instructionRef: reference,
      executionAuthorityRef: "fixture:separate-execution-authority", text: nextInstruction() }));
    host.forward = { contract: "atomic-compare-and-start-v1", compareAndStart: vi.fn(async () => ({ outcome: "started", turnId: "turn-b" })) };
  }
  beforeEach(() => {
    send.mockReset().mockImplementation(async () => ({ remoteId: "fixture-bubble" })); observe.mockClear();
    stateDir = isolateStateDir(); root = makeTmpDir("maintenance-repository"); makeGitRepo(root); target = saveResult();
    goal = maintenanceGoalSchema.parse({ schemaVersion: 1, profile: MAINTENANCE_HANDOFF_PROFILE, id: target.goalId, revision: 1,
      objective: "Fixture Goal only", createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      planRef: target.planRef, recordRef: "record:fixture", continuationKeys: CONTINUATION_KEYS,
      selection: { repository: target.repository, workspaceId: target.workspaceId, workspaceRoot: root, worktreeRoot: root, workstream: target.workstream, branch: target.branch } });
    provider = { sessionId: target.sessionId, turnId: target.turnId, operationId: target.operationId, inputRef: "provider:input-a",
      status: "active", fullFinal: null, finalRef: null, contentOmitted: false, sessionRevision: "revision-a" };
    host = { readContext: vi.fn(async (requested) => ({ binding: structuredClone(requested),
      approval: { source: "provider", authorKind: "human", messageRef: "provider:human-goal-plan", goalId: target.goalId,
        planRef: target.planRef, projectId: target.projectId, chatId: target.chatId, action: "maintenance_handoff" },
      sendAuthorized: true, notBefore: goal.createdAt, expiresAt: goal.expiresAt })),
      readTurn: vi.fn(async () => structuredClone(provider)), browser: { sendMessage: send, observeVisibleBubble: observe } };
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(root); cleanup(stateDir); });

  it("binds the saved result to its worktree despite an inherited foreign Git directory", async () => {
    const foreign = makeTmpDir("maintenance-foreign"); makeGitRepo(foreign); git(foreign, "checkout", "-b", "foreign");
    const previous = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = path.join(foreign, ".git");
      expect((await createMaintenanceHandoffTransaction(host).prepare(goal, target)).state).toBe("PREPARED");
      expect(send).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      cleanup(foreign);
    }
  });

  it("saves a pending notice while A is active and requires Codex to end its turn", async () => {
    const result = await createMaintenanceHandoffTransaction(host).send(goal, target);
    expect(result.outcome).toBe("END_TURN_REQUIRED"); expect(result.receipt.state).toBe("DELIVERED_VISIBLE");
    expect(send).toHaveBeenCalledTimes(1); expect(host.readTurn).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].text).toContain("terminal is not yet confirmed"); expect(pending()?.turnId).toBe("turn-a");
  });
  it("allows only one caller after two callers prepare the same event", async () => {
    const first = createMaintenanceHandoffTransaction(host), second = createMaintenanceHandoffTransaction(host);
    await Promise.all([first.prepare(goal, target), second.prepare(goal, target)]);
    const results = await Promise.all([first.send(goal, target), second.send(goal, target)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["END_TURN_REQUIRED", "RECONCILE_ONLY"]);
    expect(send).toHaveBeenCalledTimes(1); expect(loadMaintenanceGrant(maintenanceEventKey(target))?.useCount).toBe(1);
  });
  it("refuses late callers and a serialized SENDING receipt after the first send", async () => {
    const transaction = createMaintenanceHandoffTransaction(host);
    await transaction.send(goal, target); expect((await transaction.send(goal, target)).outcome).toBe("RECONCILE_ONLY");
    const stored = readMaintenanceReceipt(maintenanceEventKey(target))!;
    await expect(deliverMaintenanceNotice({ ...stored, state: "SENDING" }, host.browser!)).rejects.toThrow(/atomic claim/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps SENDING after process recovery without minting another claim", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.prepare(goal, target);
    const authority = await resolveMaintenanceAuthority(host, target);
    const claim = withOwnedEventLease(maintenanceEventKey(target), () => claimMaintenanceSendOwnedLease(authority, reserveMaintenanceReturn(authority)));
    expect(claim.claimed).toBe(true);
    const moduleUrl = pathToFileURL(path.resolve("src/conversation/authorization.ts")).href;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import {readMaintenanceReceipt,consumeMaintenanceSendClaim} from ${JSON.stringify(moduleUrl)}; const receipt=readMaintenanceReceipt(process.argv[1]); try { consumeMaintenanceSendClaim(receipt); process.exit(2); } catch { console.log(receipt.state); }`, maintenanceEventKey(target)], { encoding: "utf8", env: process.env });
    expect(child.status, child.stderr).toBe(0); expect(child.stdout.trim()).toBe("SENDING");
    expect((await transaction.send(goal, target)).outcome).toBe("RECONCILE_ONLY"); expect(send).not.toHaveBeenCalled();
  });
  it("preserves UNKNOWN after a Browser exception and reconciles without resending", async () => {
    send.mockRejectedValueOnce(new Error("lost after submit"));
    const transaction = createMaintenanceHandoffTransaction(host);
    expect((await transaction.send(goal, target)).receipt.state).toBe("AMBIGUOUS");
    expect((await transaction.send(goal, target)).outcome).toBe("RECONCILE_ONLY");
    expect((await transaction.reconcile(goal, target)).state).toBe("DELIVERED_VISIBLE"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects changed session or payload for the existing operation instead of creating another event", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.prepare(goal, target);
    expect(maintenanceEventKey({ ...target, sessionId: "different" })).toBe(maintenanceEventKey(target));
    await expect(transaction.prepare(goal, { ...target, sessionId: "different" })).rejects.toThrow();
    await expect(transaction.prepare(goal, { ...target, result: { ...target.result, sha256: "0".repeat(64) } })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("fails closed without an adopted host or Browser and does not mutate installed state", async () => {
    await expect(createMaintenanceHandoffTransaction().send(goal, target)).rejects.toThrow(/CAPABILITY_UNAVAILABLE/);
    delete host.browser; await expect(createMaintenanceHandoffTransaction(host).send(goal, target)).rejects.toThrow(/CAPABILITY_UNAVAILABLE/);
    expect(readMaintenanceReceipt(maintenanceEventKey(target))).toBeNull(); expect(pending()).toBeNull();
  });
  it.each(["chat", "human", "grant", "expiry"])("rejects a mismatched %s observation before a send", async (boundary) => {
    const original = host.readContext;
    host.readContext = async (requested) => {
      const context = await original(requested);
      if (boundary === "chat") context.binding.chatId = "wrong-chat";
      if (boundary === "human") context.approval.authorKind = "assistant" as "human";
      if (boundary === "grant") context.sendAuthorized = false;
      if (boundary === "expiry") context.expiresAt = "2000-01-01T00:00:00.000Z";
      return context;
    };
    await expect(createMaintenanceHandoffTransaction(host).send(goal, target)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(readMaintenanceReceipt(maintenanceEventKey(target))).toBeNull();
  });
  it("does not hold the Goal lease across Browser work and refuses other Goal operations", async () => {
    send.mockImplementationOnce(async () => { const lease = acquireLease(runnerFiles(root, target.workstream).lease); lease.release(); return {}; });
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target);
    const unrelated = saveResult("unrelated", "turn-c");
    await expect(transaction.prepare(goal, unrelated)).rejects.toThrow(/pending/); expect(pending()?.operationId).toBe(target.operationId);
  });
  it("retains pending and performs zero forwards without an atomic host contract", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target);
    enableForward(); delete host.forward;
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/atomic compare-and-start/);
    expect(pending()?.operationId).toBe(target.operationId);
  });
  it.each(["active", "failed", "interrupted", "unknown", "systemError"] as const)("refuses forward while provider turn is %s", async (status) => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward(); provider.status = status;
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/completed provider/);
    expect(host.forward!.compareAndStart).not.toHaveBeenCalled(); expect(pending()?.next).toBeUndefined();
  });
  it("refuses omitted or missing full final despite a completed terminal", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward(); provider.contentOmitted = true;
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/full final/);
    provider.contentOmitted = false; provider.fullFinal = null;
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/full final/); expect(host.forward!.compareAndStart).not.toHaveBeenCalled();
  });
  it("rejects an intervening provider turn at the atomic forward without queue or steer", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward();
    let revision = provider.sessionRevision;
    const read = host.readInstruction!;
    host.readInstruction = async (reference) => { const result = await read(reference); revision = "intervening-turn-c"; return result; };
    host.forward!.compareAndStart = vi.fn(async (request) => request.expectedRevision === revision ? { outcome: "started", turnId: "turn-b" } : { outcome: "conflict" });
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("conflict");
    expect(pending()?.next?.state).toBe("CONFLICT");
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("RECONCILE_ONLY"); expect(host.forward!.compareAndStart).toHaveBeenCalledTimes(1);
  });
  it("admits B once from the actual A final and then permits B's separate saved-result notice", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward();
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("started");
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("RECONCILE_ONLY");
    expect(vi.mocked(host.forward!.compareAndStart).mock.calls[0][0].instruction).toContain(provider.fullFinal);
    const resultB = saveResult("operation-b", "turn-b"); await transaction.send(goal, resultB);
    expect(send).toHaveBeenCalledTimes(2); expect(pending()?.operationId).toBe("operation-b");
  });
  it("retains UNKNOWN after a forward disconnect and never calls the provider again", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward();
    host.forward!.compareAndStart = vi.fn(async () => { throw new Error("provider disconnected"); });
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("unknown"); expect(pending()?.next?.state).toBe("UNKNOWN");
    await transaction.forward(goal, target, "instruction:b"); expect(host.forward!.compareAndStart).toHaveBeenCalledTimes(1);
  });
  it("rejects unsafe references, quoted or duplicate headers, Work mode and path traversal", () => {
    enableForward(); const header = nextInstruction();
    expect(parseMaintenanceInstruction(header).operation_id).toBe("operation-b");
    expect(() => parseMaintenanceInstruction(`> ${header}`)).toThrow();
    expect(() => parseMaintenanceInstruction(header.replace("recipient: codex", "recipient: codex\nrecipient: chatgpt"))).toThrow();
    expect(() => renderMaintenanceResult({ ...target, planRef: "api_key=synthetic-secret" })).toThrow(/safe references/);
    expect(() => renderMaintenanceResult({ ...target, mode: "work" as "chat" })).toThrow();
    expect(() => renderMaintenanceResult({ ...target, workspaceId: "../auth" })).toThrow();
  });

  it("keeps the CLI closed to serialized host or adapter injection", () => {
    const requestFile = path.join(root, "maintenance-request.json");
    fs.writeFileSync(requestFile, JSON.stringify({ goal, target, host: { sendAuthorized: true } }));
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "maintenance-handoff", "prepare", "--request-file", requestFile], { encoding: "utf8", env: process.env });
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).toContain("unsupported Maintenance request fields");
    fs.writeFileSync(requestFile, JSON.stringify({ goal, target }));
    const unavailable = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "maintenance-handoff", "prepare", "--request-file", requestFile], { encoding: "utf8", env: process.env });
    expect(unavailable.status).toBe(1); expect(unavailable.stdout + unavailable.stderr).toContain("MAINTENANCE_CAPABILITY_UNAVAILABLE");
    expect(readMaintenanceReceipt(maintenanceEventKey(target))).toBeNull();
  });

  it.each(["reply", "session", "result"])("refuses a changed %s on reconcile and forward before external calls", async (boundary) => {
    const transaction = createMaintenanceHandoffTransaction(host);
    await transaction.send(goal, target); enableForward(); observe.mockClear();
    if (boundary === "reply") target = { ...target, chatId: "different-chat", replyRef: "binding:different-chat" };
    if (boundary === "session") { target = { ...target, sessionId: "different-session" }; recordTarget(target); }
    if (boundary === "result") target = saveResult();
    await expect(transaction.reconcile(goal, target)).rejects.toThrow(/prepared target changed|execution record mismatch/);
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/prepared target changed|execution record mismatch/);
    expect(observe).not.toHaveBeenCalled(); expect(host.forward!.compareAndStart).not.toHaveBeenCalled();
    expect(pending()?.next).toBeUndefined();
  });

  it.each(["started", "conflict", "unknown"] as const)("records a %s provider result after the reserved Goal expires", async (outcome) => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward();
    host.forward!.compareAndStart = vi.fn(async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(goal.expiresAt) + 1);
      return outcome === "started" ? { outcome, turnId: "turn-b" } : { outcome };
    });
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe(outcome);
    const stored = JSON.parse(fs.readFileSync(runnerFiles(root, target.workstream).checkpoint, "utf8"));
    expect(stored.pending.next.state).toBe(outcome === "started" ? "STARTED" : outcome.toUpperCase());
    if (outcome === "started") expect(stored.pending.next.turnId).toBe("turn-b");
    await expect(transaction.forward(goal, target, "instruction:b")).rejects.toThrow(/Goal is not active/);
    expect(host.forward!.compareAndStart).toHaveBeenCalledTimes(1);
  });

  it.each(["submit", "observe"] as const)("keeps sanitized %s refusal reasons without treating them as non-acceptance", async (phase) => {
    const denied = new Error("host safety review denied: selected target; api_key=fixture-secret-value");
    if (phase === "submit") send.mockRejectedValueOnce(denied); else observe.mockRejectedValueOnce(denied);
    const transaction = createMaintenanceHandoffTransaction(host);
    const result = await transaction.send(goal, target);
    expect(result.receipt.state).toBe("AMBIGUOUS"); expect(result.receipt.errorPhase).toBe(phase);
    expect(result.receipt.reason).toContain("host safety review denied"); expect(result.receipt.reason).not.toContain("fixture-secret-value");
    expect(readMaintenanceReceipt(maintenanceEventKey(target))?.reason).toBe(result.receipt.reason);
    expect((await transaction.send(goal, target)).outcome).toBe("RECONCILE_ONLY"); expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not report a malformed provider started response as a successful turn", async () => {
    const transaction = createMaintenanceHandoffTransaction(host); await transaction.send(goal, target); enableForward();
    host.forward!.compareAndStart = vi.fn(async () => ({ outcome: "started", turnId: "" }));
    expect((await transaction.forward(goal, target, "instruction:b")).outcome).toBe("unknown");
    expect(pending()?.next?.state).toBe("UNKNOWN");
  });
});
