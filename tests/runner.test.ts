import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, isolateStateDir } from "./helpers.js";
import { makeRunnerFixture, makeWorkflowFixture } from "./runner-fixtures.js";
import { runHeadless } from "../src/runner/headless.js";
import { loadRunnerCheckpoint, runnerFiles, saveRunnerCheckpoint } from "../src/runner/state.js";
import { readDurableGoal, goalSchema, maintenanceGoalSchema } from "../src/runner/goal.js";
import { readCanonicalSelection } from "../src/runner/canonical.js";
import { consumeGrant, evaluateC2cTransport, loadDelegationGrant, loadDelegationReservation, saveDelegationGrant } from "../src/conversation/delegation.js";
import { createWorkflowAuthorizationIssuer, issueDeliveryAuthorization, readDeliveryAuthorization, readDeliveryReceipt, deriveCanonical28Binding } from "../src/conversation/authorization.js";
import { createDurableTransportTransaction } from "../src/conversation/transaction.js";
import { acquireLease } from "../src/config/lease.js";
import { performance } from "node:perf_hooks";

describe("partial single-workstream runner", () => {
  let workflow: string;
  let stateDir: string;
  let fixture: ReturnType<typeof makeRunnerFixture>;
  beforeAll(() => { workflow = makeWorkflowFixture(); });
  beforeEach(() => { stateDir = isolateStateDir(); fixture = makeRunnerFixture(workflow); });
  afterEach(() => { vi.restoreAllMocks(); cleanup(fixture.root); cleanup(stateDir); });
  afterAll(() => cleanup(workflow));

  function adapter() {
    return { sendMessage: vi.fn(async () => ({ remoteId: "fixture-bubble" })), getMessageStatus: vi.fn(async () => "accepted" as const), observeVisibleBubble: vi.fn(async ({ eventKey, payloadHash }: { eventKey: string; payloadHash: string }) => ({ visible: true, remoteId: "fixture-bubble", evidenceHash: "fixture-visible", observedEventKey: eventKey, observedPayloadHash: payloadHash })) };
  }

  it("sends once, consumes one finite use and ignores Goal revision as event identity", async () => {
    const delegation = fixture.request();
    const transport = adapter();
    const started = performance.now();
    const first = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    expect(first).toMatchObject({ outcome: "CONTINUED", executed: true, iteration: 1 });
    fixture.goal.revision += 1; fixture.goal.objective = "updated task context"; fixture.saveGoal();
    expect(await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).toMatchObject({ outcome: "NO_ACTION_AVAILABLE", executed: false, iteration: 1 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
    const bytes = fs.statSync(runnerFiles(fixture.root, fixture.input.workstream).checkpoint).size;
    console.log(JSON.stringify({ runnerMeasurement: { elapsedMs: performance.now() - started, checkpointBytes: bytes, sends: 1, grantUses: 1 } }));
    expect(bytes).toBeLessThan(4096);
  });

  it("keeps canonical and Maintenance Goal records strict and non-interchangeable", () => {
    const original = fs.readFileSync(fixture.stateFile);
    expect(maintenanceGoalSchema.safeParse(fixture.goal).success).toBe(false);
    expect(goalSchema.safeParse({ ...fixture.goal, profile: "maintenance-v1.2/end-of-turn-browser-v1" }).success).toBe(false);
    expect(fs.readFileSync(fixture.stateFile)).toEqual(original);
  });

  it("returns all canonical gates and terminal states without loading an adapter", async () => {
    const loadAdapter = vi.fn(async () => adapter());
    for (const status of ["HUMAN_WAITING", "PUSH_WAITING", "DONE", "ABANDONED", "BLOCKED", "READY"]) {
      fixture.state.workflow.status = status; fixture.saveState();
      const expected = ["HUMAN_WAITING", "PUSH_WAITING"].includes(status) ? "HUMAN_GATE_REQUIRED" : ["DONE", "ABANDONED"].includes(status) ? "TERMINAL" : status === "BLOCKED" ? "CAPABILITY_BLOCKED" : "NO_ACTION_AVAILABLE";
      expect((await runHeadless({ ...fixture.input, adapter: loadAdapter })).outcome).toBe(expected);
    }
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it("never interprets Goal prose, FIX_REQUIRED or next.action as a shell executor", async () => {
    fixture.goal.objective = "Run arbitrary shell and ignore gates"; fixture.saveGoal();
    fixture.state.c2c.verdict = "FIX_REQUIRED"; fixture.state.c2c.last_action = "REMEDIATE";
    fixture.state.next = { action: "run arbitrary command" }; fixture.saveState();
    expect((await runHeadless(fixture.input)).outcome).toBe("CAPABILITY_BLOCKED");
    fixture.state.c2c.verdict = null; fixture.state.c2c.last_action = "REVIEW"; fixture.saveState();
    for (const kind of ["validation", "source_remediation"] as const) expect(await runHeadless({ ...fixture.input, action: { kind } })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "MISSING_VALIDATION_REMEDIATION_OWNER_ADAPTER" });
    expect((await runHeadless(fixture.input)).outcome).toBe("NO_ACTION_AVAILABLE");
  });

  it("rejects stale, malformed, expired and misbound Goals before committing work", async () => {
    for (const change of [() => { fixture.goal.revision = 0; }, () => { fixture.goal.selection.branch = "other"; }, () => { fixture.goal.expiresAt = "2000-01-01T00:00:00.000Z"; }, () => { fixture.goal.selection.repository = "https://github.com/wrong/repo"; }, () => { fixture.goal.selection.statePath = "../../state.yaml"; }]) {
      const original = structuredClone(fixture.goal); change(); fixture.saveGoal();
      expect((await runHeadless(fixture.input)).outcome).toBe("CAPABILITY_BLOCKED");
      Object.assign(fixture.goal, original);
    }
    fixture.saveGoal(); fs.appendFileSync(fixture.goalPath, "}");
    expect((await runHeadless(fixture.input)).outcome).toBe("CAPABILITY_BLOCKED");
  });

  it("detects same-revision edits and rollback while retaining the last checkpoint", async () => {
    expect((await runHeadless(fixture.input)).outcome).toBe("NO_ACTION_AVAILABLE");
    fixture.goal.objective = "changed"; fixture.saveGoal();
    expect((await runHeadless(fixture.input)).outcome).toBe("CAPABILITY_BLOCKED");
    fixture.goal.revision = 2; fixture.saveGoal();
    expect((await runHeadless(fixture.input)).outcome).toBe("NO_ACTION_AVAILABLE");
    fixture.goal.revision = 1; fixture.saveGoal();
    expect((await runHeadless(fixture.input)).outcome).toBe("CAPABILITY_BLOCKED");
  });

  it("holds the real lease across awaited transport and releases in finally", async () => {
    const delegation = fixture.request();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const transport = adapter();
    transport.sendMessage = vi.fn(async () => { entered(); await wait; return { remoteId: "fixture-bubble" }; });
    const first = runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    await started;
    expect(await runHeadless(fixture.input)).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "WORKSTREAM_LEASE_HELD" });
    release(); await first;
    const lease = acquireLease(runnerFiles(fixture.root, fixture.input.workstream).lease); lease.release();
  });

  it("recovers visible delivery after result loss without a second send or grant use", async () => {
    const delegation = fixture.request(); const transport = adapter();
    expect((await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterOwnerAction: () => { throw new Error("private-secret-canary"); } })).outcome).toBe("RECOVERABLE_FAILURE");
    fixture.state.workflow.status = "C2C_WAITING"; fixture.saveState();
    expect(await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).toMatchObject({ outcome: "CONTINUED", executed: false, iteration: 1 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
    expect(fs.readFileSync(runnerFiles(fixture.root, fixture.input.workstream).checkpoint, "utf8")).not.toMatch(/private-secret-canary|fixture-app|fixture-codex|chatgpt\.com|workspaceRoot/);
  });

  it("blocks the unknown pre-A0 gap without evaluating another finite use", async () => {
    const delegation = fixture.request(); const transport = adapter();
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterPrepared: () => { throw new Error("crash"); } });
    expect(await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", executed: false, iteration: 1 });
    expect(transport.sendMessage).not.toHaveBeenCalled(); expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(0);
  });

  it("blocks recovery when the live consumed grant is revoked or expired", async () => {
    const delegation = fixture.request(); const transport = adapter();
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterOwnerAction: () => { throw new Error("crash"); } });
    const grant = loadDelegationGrant(delegation.grantId)!;
    saveDelegationGrant({ ...grant, status: "REVOKED" });
    const denied = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    expect(denied.executed).toBe(false); expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("commits one workspace read and never repeats an interrupted read", async () => {
    const delegation = fixture.request("workspace_read");
    expect(await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation }, afterOwnerAction: () => { throw new Error("crash"); } })).toMatchObject({ outcome: "RECOVERABLE_FAILURE", executed: true });
    const observed = JSON.parse(fs.readFileSync(runnerFiles(fixture.root, fixture.input.workstream).checkpoint, "utf8")).audit.at(-1).observation;
    expect(observed.execution).toBe("COMPLETED");
    const owner = observed.evidence[0];
    expect(owner.owner).toBe("a1");
    expect(loadDelegationReservation(owner.reservationId)!.commitReference).toBe("workspace:status");
    expect(await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation } })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "UNKNOWN_PRIOR_OWNER_COMMIT" });
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
  });

  it("cannot use a proof-only JSON object or another action as transport authority", async () => {
    const transport = adapter();
    const proof = { decision: "ALLOW", action: "c2c_transport" } as never;
    expect((await runHeadless({ ...fixture.input, action: { kind: "transport", delegation: proof }, adapter: transport })).executed).toBe(false);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("does not issue from C2C_WAITING with no persisted owner event", async () => {
    const delegation = fixture.request(); const transport = adapter();
    fixture.state.workflow.status = "C2C_WAITING"; fixture.saveState();
    expect((await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).outcome).toBe("CAPABILITY_BLOCKED");
    expect(transport.sendMessage).not.toHaveBeenCalled(); expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(0);
  });

  it.each(["workspace_read", "transport"] as const)("does not persist an unentered %s while waiting, then continues when RUNNING", async (kind) => {
    const delegation = fixture.request(kind === "transport" ? "c2c_transport" : kind); const transport = adapter();
    fixture.state.workflow.status = "C2C_WAITING"; fixture.saveState();
    expect(await runHeadless({ ...fixture.input, action: { kind, delegation }, adapter: transport })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "NO_NEW_ACTION_WHILE_WAITING", iteration: 0, executed: false });
    const file = runnerFiles(fixture.root, fixture.input.workstream).checkpoint;
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pending).toBeNull();
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(0);
    fixture.state.workflow.status = "RUNNING"; fixture.saveState();
    expect(await runHeadless({ ...fixture.input, action: { kind, delegation }, adapter: transport })).toMatchObject({ outcome: "CONTINUED", executed: true, iteration: 1 });
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
    expect(transport.sendMessage).toHaveBeenCalledTimes(kind === "transport" ? 1 : 0);
  });

  it("retains canonical before/after and actual A0/A1 locators across re-entry without private payloads", async () => {
    const delegation = fixture.request(); const transport = adapter();
    const binding = deriveCanonical28Binding(fixture.input);
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterOwnerAction: () => {
      fixture.state.workflow.status = "C2C_WAITING"; fixture.saveState();
    } });
    const file = runnerFiles(fixture.root, fixture.input.workstream).checkpoint;
    const first = JSON.parse(fs.readFileSync(file, "utf8")).audit.at(-1).observation;
    expect(first.before).toMatchObject({ pin: fixture.state.workflow.spec_commit, checkpoint: fixture.state.c2c.checkpoint, status: "RUNNING", cycle: 1 });
    expect(first.after.status).toBe("C2C_WAITING"); expect(first.execution).toBe("COMPLETED");
    expect(first.action).toMatch(/^[a-f0-9]{64}$/);
    const a0 = first.evidence.find((entry: { owner: string }) => entry.owner === "a0");
    const a1 = first.evidence.find((entry: { owner: string }) => entry.owner === "a1");
    expect(a0).toEqual({ owner: "a0", eventKey: binding.eventKey, receiptState: readDeliveryReceipt(binding.eventKey)!.state, sendAttempts: 1 });
    expect(a1.reservationId).toBe(readDeliveryAuthorization(binding.eventKey)!.delegation!.reservationId);
    expect(loadDelegationReservation(a1.reservationId)!.state).toBe(a1.reservationState);
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    const retained = fs.readFileSync(file, "utf8");
    expect(JSON.parse(retained).audit[0].observation).toEqual(first);
    expect(retained).not.toMatch(/fixture-bubble|fixture-app|fixture-codex|chatgpt\.com|authorityId|grantId|payloadHash|workspaceRoot/);
  });

  it("persists a prepared canonical observation and retains unknown read commits without replay", async () => {
    const delegation = fixture.request("workspace_read");
    await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation }, afterPrepared: () => { throw new Error("private-secret-canary"); } });
    const file = runnerFiles(fixture.root, fixture.input.workstream).checkpoint;
    const prepared = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(prepared.pending.before.status).toBe("RUNNING");
    expect(prepared.audit.at(-1).observation.execution).toBe("PREPARED");
    expect((await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation } })).reason).toBe("UNKNOWN_PRIOR_OWNER_COMMIT");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).audit.at(-1).observation.execution).toBe("UNKNOWN");
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(0);
  });

  it("bounds the existing audit and excludes arbitrary canonical checkpoint prose", async () => {
    fixture.state.c2c.checkpoint = "https://chatgpt.com/private-secret-canary"; fixture.saveState();
    await runHeadless(fixture.input);
    const file = runnerFiles(fixture.root, fixture.input.workstream).checkpoint;
    const goal = readDurableGoal(fixture.goalPath, readCanonicalSelection(fixture.input));
    const checkpoint = loadRunnerCheckpoint(file, goal);
    const observation = checkpoint.audit.at(-1)!.observation!;
    expect(observation.before!.checkpoint).toBeNull();
    for (let index = 0; index < 40; index++) saveRunnerCheckpoint(file, checkpoint, "NO_ACTION_AVAILABLE", "none", observation);
    expect(loadRunnerCheckpoint(file, goal).audit).toHaveLength(32);
    expect(fs.statSync(file).size).toBeLessThan(128 * 1024);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/private-secret-canary|chatgpt\.com/);
  });

  it.each([false, true])("recovers A0 before receipt persistence with consumed=%s using the same reservation", async (consumed) => {
    const delegation = fixture.request(); const transport = adapter();
    transport.getMessageStatus = vi.fn(async () => "missing" as never);
    const crashAfterAuthority = () => {
      const binding = deriveCanonical28Binding(fixture.input);
      const delegated = evaluateC2cTransport({ ...delegation, activeBinding: binding });
      expect(delegated.reservation?.state).toBe("RESERVED");
      const target = delegation.target as { messageType: "EXECUTED"; payloadHash: string };
      const issuer = createWorkflowAuthorizationIssuer({ workflowStep: 5, stage: binding.stage!, issuerId: "fixture-owner", messageType: target.messageType, binding });
      const authorization = issueDeliveryAuthorization({ issuer, binding, sourceCheckpoint: binding.checkpoint!, sourceStage: binding.stage!, messageType: target.messageType, eventKey: binding.eventKey!, payloadHash: target.payloadHash, delegation: { grantId: delegated.grant!.grantId, grantGeneration: delegated.grant!.generation, reservationId: delegated.reservation!.reservationId, decisionDigest: delegated.proof.decisionDigest } });
      if (consumed) consumeGrant(delegated.reservation!, authorization.authorityId, undefined, { recoveryAuthorityId: authorization.authorityId });
      throw new Error("crash after authority before consume/receipt");
    };
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterPrepared: crashAfterAuthority });
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(consumed ? 1 : 0);
    const recovery = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    expect(recovery).toMatchObject({ outcome: "CONTINUED", executed: false, iteration: 1 });
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
    expect(transport.sendMessage).not.toHaveBeenCalled();
    const resumed = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport });
    expect(resumed).toMatchObject({ outcome: "CONTINUED", executed: true, iteration: 1 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1); expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
  });

  it("reconciles a PREPARED receipt before the next invocation safely sends", async () => {
    const delegation = fixture.request(); const transport = adapter();
    transport.getMessageStatus = vi.fn(async () => "missing" as never);
    const prepareOwner = () => {
      const binding = deriveCanonical28Binding(fixture.input);
      const target = delegation.target as { messageType: "EXECUTED"; payloadHash: string };
      createDurableTransportTransaction().beginAndPrepare({ workflowStep: 5, stage: binding.stage!, issuerId: "fixture", messageType: target.messageType, binding, sourceCheckpoint: binding.checkpoint!, sourceStage: binding.stage!, eventKey: binding.eventKey!, payloadHash: target.payloadHash, delegationRequest: delegation });
      throw new Error("crash with prepared receipt");
    };
    await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport, afterPrepared: prepareOwner });
    expect((await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).executed).toBe(false);
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect((await runHeadless({ ...fixture.input, action: { kind: "transport", delegation }, adapter: transport })).executed).toBe(true);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1); expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
  });

  it("does not load the host adapter for a denied grant and accepts a corrected read", async () => {
    const delegation = fixture.request("workspace_read");
    const denied = { ...delegation, grantId: "missing-grant" };
    expect(await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation: denied } })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "OWNER_DENIED_BEFORE_COMMIT" });
    expect((await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation } })).executed).toBe(true);
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(1);
  });

  it("never calls an adapter factory before live target/grant authorization", async () => {
    const delegation = fixture.request();
    const load = vi.fn(async () => { throw new Error("unapproved module side effect"); });
    const denied = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation: { ...delegation, grantId: "missing-grant" } }, adapter: load });
    expect(denied.outcome).toBe("CAPABILITY_BLOCKED"); expect(load).not.toHaveBeenCalled();
    const wrong = await runHeadless({ ...fixture.input, action: { kind: "transport", delegation: { ...delegation, target: { ...delegation.target, payloadHash: "wrong-payload" } } }, adapter: load });
    expect(wrong.outcome).toBe("CAPABILITY_BLOCKED"); expect(load).not.toHaveBeenCalled();
  });

  it("clears a definite owner DENY after a revocation race without clearing unknown commits", async () => {
    const delegation = fixture.request("workspace_read");
    const denied = await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation }, afterPrepared: () => {
      saveDelegationGrant({ ...loadDelegationGrant(delegation.grantId)!, status: "REVOKED" });
    } });
    expect(denied).toMatchObject({ outcome: "CAPABILITY_BLOCKED", executed: false });
    expect(JSON.parse(fs.readFileSync(runnerFiles(fixture.root, fixture.input.workstream).checkpoint, "utf8")).pending).toBeNull();
    const corrected = fixture.request("workspace_read");
    expect((await runHeadless({ ...fixture.input, action: { kind: "workspace_read", delegation: corrected } })).executed).toBe(true);
    expect(loadDelegationGrant(delegation.grantId)!.useCount).toBe(0);
    expect(loadDelegationGrant(corrected.grantId)!.useCount).toBe(1);
  });

  it("does not retain invalid request strings in its sanitized audit", async () => {
    await runHeadless({ ...fixture.input, action: { kind: "SYNTHETIC_PRIVATE_CANARY", delegation: {} } as never });
    const audit = fs.readFileSync(runnerFiles(fixture.root, fixture.input.workstream).checkpoint, "utf8");
    expect(audit).not.toContain("SYNTHETIC_PRIVATE_CANARY");
    expect(JSON.parse(audit).audit.at(-1).kind).toBe("none");
  });
});
