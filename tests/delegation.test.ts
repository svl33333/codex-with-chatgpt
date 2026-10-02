import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createDelegationGrant,
  delegationApprovalDigest,
  delegationRevocationDigest,
  delegationScopeDigest,
  delegationTargetDigest,
  assertAuthoritativeRevocation,
  assertDelegationReservationCommitReady,
  evaluateC2cTransport,
  evaluateOperationReconcile,
  evaluateWorkspaceRead,
  loadDelegationGrant,
  normalizeDelegationScope,
  readDelegationAudit,
  recordDelegationAudit,
  recoverDelegationReservation,
  releaseGrant,
  reserveGrant,
  consumeGrant,
  revokeDelegationGrant,
  type DelegationScope,
} from "../src/conversation/delegation.js";
import { writeAtomicSecureJson } from "../src/config/paths.js";
import { parseStrictJson, readStrictJsonFile } from "../src/config/strict-json.js";
import { operationKey, prepareGitHubOperation, readKnownLogicalOperation } from "../src/conversation/operation.js";
import { deriveActiveCanonicalBinding, readDeliveryReceiptForOperation } from "../src/conversation/authorization.js";
import { readWorktreeIdentity } from "../src/connection/identity.js";
import { Workspace } from "../src/workspace/manager.js";
import { deriveOperationEvidencePath } from "../src/conversation/delegation-policy.js";
import { createTeamAiCapabilityProvider, resolveTeamAiAuthResult, type TeamAiCapabilityProvider } from "../src/conversation/teamai.js";
import { cleanup, isolateStateDir, makeGitRepo } from "./helpers.js";

function scope(root: string, action: "c2c_transport" | "workspace_read" | "operation_reconcile") {
  const workspace = new Workspace(root);
  const identity = readWorktreeIdentity({ workspaceRoot: root });
  return normalizeDelegationScope({
    workspaceId: workspace.id,
    workstreamId: "a1-delegated-authorization",
    workspaceRoot: identity.workspaceRoot,
    canonicalRepository: identity.canonicalRepository,
    worktreeRoot: identity.worktreeRoot,
    branch: identity.branch,
    stage: "Implementation + C2C Review",
    canonicalAction: action,
  }, action);
}

function activeBinding(value: DelegationScope) {
  const root = value.workspaceRoot ?? value.worktreeRoot;
  const identity = readWorktreeIdentity({ workspaceRoot: root });
  const candidate = {
    workspaceId: value.workspaceId,
    workstreamId: value.workstreamId,
    workspaceName: value.workspaceName ?? new Workspace(root).name,
    workspaceRoot: root,
    canonicalRepository: value.canonicalRepository,
    worktreeRoot: value.worktreeRoot,
    branch: value.branch,
    observedCommit: identity.observedCommit,
    dirtyState: identity.dirtyState,
    installationId: value.installationId ?? identity.installationId,
    endpointFingerprint: value.endpointFingerprint ?? "fixture-endpoint",
    connectorName: value.connectorName ?? "fixture-connector",
    mcpAppId: value.mcpAppId ?? "fixture-app",
    mcpVersionId: value.mcpVersionId ?? "fixture-version",
    projectId: value.projectId ?? "fixture-project",
    chatId: value.chatId ?? "fixture-chat",
    codexSessionId: "fixture-session",
    stage: value.stage,
    taskId: value.taskId ?? "a1-test-task",
    checkpoint: value.checkpoint ?? "a1-test",
    eventKey: value.eventKey ?? "a1-event",
  };
  return deriveActiveCanonicalBinding({ workspaceRoot: root, workspaceId: value.workspaceId, candidate });
}

function grant(root: string, action: "c2c_transport" | "workspace_read" | "operation_reconcile", now = 1_000, scopedValue = scope(root, action)) {
  const value = scopedValue;
  const target = action === "c2c_transport"
    ? { kind: "c2c_transport" as const, checkpoint: "a1-test", eventKey: "a1-event", messageType: "REVIEW" as const, payloadHash: "hash" }
    : { kind: "workspace_read" as const, operation: "read" as const, path: "bounded.txt", maxBytes: 1024 };
  const notBefore = new Date(now).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const maxUses = action === "c2c_transport" ? 64 : 256;
  const approvalDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action, scope: value, target, notBefore, expiresAt, maxUses });
  const approvalStatePath = writeApprovalState(root, now, { action, scopeDigest: delegationScopeDigest(value), targetDigest: delegationTargetDigest(target), decisionId: "step4-test", approvedDigest: approvalDigest, approverIdentityRef: "human:step4" }, value);
  return createDelegationGrant({
    action,
    scope: value,
    target,
    approval: {
      workflowStatePath: approvalStatePath,
      checkpoint: value.checkpoint ?? "a1-test",
      decisionId: "step4-test",
      approverIdentityRef: "human:step4",
      approvedAt: new Date(now).toISOString(),
      approvedDigest: approvalDigest,
    },
    notBefore,
    expiresAt,
    maxUses,
    clock: () => now,
  });
}

function writeApprovalState(root: string, now = 1_000, record?: { action: string; scopeDigest: string; targetDigest: string; decisionId: string; approvedDigest: string; approverIdentityRef: string }, scopedValue?: DelegationScope): string {
  const file = path.join(root, ".harness", "a1-delegated-authorization", "state.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const workspace = new Workspace(root);
  const identity = readWorktreeIdentity({ workspaceRoot: root });
  const value = scopedValue ?? scope(root, "workspace_read");
  fs.writeFileSync(file, `schema_version: "1.1"\nworkflow:\n  step: 5\n  stage: ${value.stage}\n  status: RUNNING\n  workspace_id: ${value.workspaceId}\n  workspace_name: ${workspace.name}\n  workspace_root: ${identity.workspaceRoot}\n  canonical_repository: ${value.canonicalRepository}\n  worktree_root: ${value.worktreeRoot}\n  branch: ${value.branch}\n  observed_commit: ${identity.observedCommit}\n  dirty_state: ${identity.dirtyState}\n  installation_id: ${value.installationId ?? identity.installationId}\n  endpoint_fingerprint: ${value.endpointFingerprint ?? "fixture-endpoint"}\n  connector_name: ${value.connectorName ?? "fixture-connector"}\n  connector_app_id: ${value.mcpAppId ?? "fixture-app"}\n  connector_version_id: ${value.mcpVersionId ?? "fixture-version"}\n  project_id: ${value.projectId ?? "fixture-project"}\n  chat_id: ${value.chatId ?? "fixture-chat"}\n  codex_session_id: fixture-session\n  checkpoint: ${value.checkpoint ?? "a1-test"}\n  task_id: ${value.taskId ?? "a1-test-task"}\n  event_key: ${value.eventKey ?? "a1-event"}\n  authorized_action: EXECUTED\n  action_id: fixture-action\n  review_stage: post_implementation\n  step4_approval:\n    approved: true\n    approved_at: ${new Date(now).toISOString()}\n${record ? `delegation_approval:\n  decision_id: ${record.decisionId}\n  approved_digest: ${record.approvedDigest}\n  action: ${record.action}\n  scope_digest: ${record.scopeDigest}\n  target_digest: ${record.targetDigest}\n  approved_at: ${new Date(now).toISOString()}\n  approver_identity_ref: ${record.approverIdentityRef}\n` : ""}`);
  return file;
}

describe("A1 delegated authorization boundaries", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = isolateStateDir(); makeGitRepo(stateDir); fs.writeFileSync(path.join(stateDir, "bounded.txt"), "bounded workspace\n"); writeApprovalState(stateDir); });
  afterEach(() => cleanup(stateDir));

  it("evaluates bounded workspace_read without TeamAI or a GitHub provider field", () => {
    const g = grant(stateDir, "workspace_read");
    const result = evaluateWorkspaceRead({
      action: "workspace_read",
      scope: g.scope,
      activeBinding: activeBinding(g.scope),
      target: { kind: "workspace_read", operation: "read", path: "bounded.txt", maxBytes: 1024 },
      grant: g,
      clock: () => 1_000,
    });
    expect(result.proof.decision).toBe("ALLOW");
    expect(result.proof.provider).toBeUndefined();
    expect((result.result as { content: string }).content).toContain("bounded workspace");
  });

  it("rejects a caller-selected route flag and irrelevant provider fields", () => {
    const g = grant(stateDir, "workspace_read");
    expect(evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: { kind: "workspace_read", operation: "status" }, grant: g, delegationRequired: false }).proof.reason).toBe("ACTION_DENIED");
    expect(evaluateWorkspaceRead({ action: "workspace_read", scope: { ...g.scope, expectedAccount: "wrong@example.com" } as never, activeBinding: activeBinding(g.scope), target: { kind: "workspace_read", operation: "status" }, grant: g }).proof.reason).toBe("PROVIDER_FIELDS_IRRELEVANT");
    expect(evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: { kind: "workspace_read", operation: "status" }, grant: g, decisionInstanceId: "caller-selected" } as never).proof.reason).toBe("ACTION_DENIED");
    expect(evaluateC2cTransport({ action: "c2c_transport", scope: g.scope, activeBinding: activeBinding(g.scope), target: { kind: "c2c_transport", checkpoint: "a1-test", eventKey: "a1-event", messageType: "REVIEW", payloadHash: "hash", operationTarget: {} } as never, grant: grant(stateDir, "c2c_transport") }).proof.reason).toBe("TARGET_DENIED");
  });

  it("requires a fresh canonical binding and denies another worktree", () => {
    const g = grant(stateDir, "workspace_read");
    const request = { action: "workspace_read" as const, scope: g.scope, target: g.target, grant: g, clock: () => 1_000 };
    expect(evaluateWorkspaceRead(request).proof.reason).toBe("TARGET_DENIED");
    const structuralBinding = JSON.parse(JSON.stringify(activeBinding(g.scope)));
    expect(evaluateWorkspaceRead({ ...request, activeBinding: structuralBinding }).proof.reason).toBe("TARGET_DENIED");
    const otherRoot = path.join(stateDir, "other-worktree");
    const wrongBinding = { ...activeBinding(g.scope), workspaceRoot: otherRoot, worktreeRoot: otherRoot };
    expect(evaluateWorkspaceRead({ ...request, activeBinding: wrongBinding }).proof.reason).toBe("TARGET_DENIED");
    expect(evaluateWorkspaceRead({ ...request, activeBinding: { ...activeBinding(g.scope), branch: "other-branch" } }).proof.reason).toBe("TARGET_DENIED");

    const scopedScope = normalizeDelegationScope({
      ...g.scope,
      checkpoint: "scoped-checkpoint",
      taskId: "scoped-task",
      eventKey: "scoped-event",
      projectId: "scoped-project",
      chatId: "scoped-chat",
      connectorName: "scoped-connector",
      mcpAppId: "scoped-app",
      mcpVersionId: "scoped-version",
      endpointFingerprint: "scoped-endpoint",
    }, "workspace_read");
    const scopedGrant = grant(stateDir, "workspace_read", 1_000, scopedScope);
    const scopedRequest = { action: "workspace_read" as const, scope: scopedGrant.scope, activeBinding: activeBinding(scopedGrant.scope), target: scopedGrant.target, grant: scopedGrant, clock: () => 1_000 };
    expect(evaluateWorkspaceRead(scopedRequest).proof.decision).toBe("ALLOW");
    expect(evaluateWorkspaceRead({ ...scopedRequest, activeBinding: { ...activeBinding(scopedGrant.scope), projectId: "other-project" } }).proof.reason).toBe("TARGET_DENIED");
    expect(evaluateWorkspaceRead({ ...scopedRequest, activeBinding: { ...activeBinding(scopedGrant.scope), checkpoint: "other-checkpoint" } }).proof.reason).toBe("TARGET_DENIED");
  });

  it("uses exact expiry boundaries", () => {
    const g = grant(stateDir, "c2c_transport", 1_000);
    const target = { kind: "c2c_transport" as const, checkpoint: "a1-test", eventKey: "a1-event", messageType: "REVIEW" as const, payloadHash: "hash" };
    expect(evaluateC2cTransport({ action: "c2c_transport", scope: g.scope, activeBinding: activeBinding(g.scope), target, grant: g, clock: () => 1_000 }).proof.decision).toBe("ALLOW");
    expect(evaluateC2cTransport({ action: "c2c_transport", scope: g.scope, activeBinding: activeBinding(g.scope), target, grant: g, clock: () => 61_000 }).proof.reason).toBe("GRANT_EXPIRED");
  });

  it("rejects duplicate raw object keys before ordinary JSON parsing", () => {
    expect(() => parseStrictJson('{"scope":{"workspaceId":"a","workspaceId":"b"}}')).toThrow(/duplicate/);
    const file = path.join(stateDir, "bad.json");
    fs.writeFileSync(file, "{\"x\":");
    expect(readStrictJsonFile(file).status).toBe("MALFORMED");
  });

  it("uses the Workspace sensitive-file and symlink boundary for bounded reads", () => {
    fs.writeFileSync(path.join(stateDir, ".env"), "TOKEN=secret\n");
    const value = scope(stateDir, "workspace_read");
    const target = { kind: "workspace_read" as const, operation: "read" as const, path: ".env", maxBytes: 1024 };
    const notBefore = new Date(1_000).toISOString();
    const expiresAt = new Date(61_000).toISOString();
    const approvalDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: value, target, notBefore, expiresAt, maxUses: 256 });
    const approvalState = writeApprovalState(stateDir, 1_000, { action: "workspace_read", scopeDigest: delegationScopeDigest(value), targetDigest: delegationTargetDigest(target), decisionId: "sensitive-read", approvedDigest: approvalDigest, approverIdentityRef: "human:step4" });
    const grantValue = createDelegationGrant({
      action: "workspace_read", scope: value, target, notBefore, expiresAt, maxUses: 256, clock: () => 1_000,
      approval: { workflowStatePath: approvalState, checkpoint: "a1-test", decisionId: "sensitive-read", approverIdentityRef: "human:step4", approvedAt: new Date(1_000).toISOString(), approvedDigest: approvalDigest },
    });
    expect(evaluateWorkspaceRead({ action: "workspace_read", scope: value, activeBinding: activeBinding(value), target, grant: grantValue, clock: () => 1_000 }).proof.reason).toBe("TARGET_DENIED");
  });

  it("mints a new decision identity for each identical read and rejects forged grant widening", () => {
    const g = grant(stateDir, "workspace_read");
    const first = evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: g.target, grant: g, clock: () => 1_000 });
    const second = evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: g.target, grant: g, clock: () => 1_000 });
    expect(first.proof.decisionInstanceId).not.toBe(second.proof.decisionInstanceId);
    expect(loadDelegationGrant(g.grantId)?.useCount).toBe(2);
    const unpersisted = createDelegationGrant({
      action: "workspace_read", scope: g.scope, target: g.target, persist: false, notBefore: new Date(1_000).toISOString(), expiresAt: new Date(61_000).toISOString(), maxUses: 256, clock: () => 1_000,
      approval: { workflowStatePath: writeApprovalState(stateDir, 1_000, { action: "workspace_read", scopeDigest: delegationScopeDigest(g.scope), targetDigest: delegationTargetDigest(g.target), decisionId: "forged", approvedDigest: delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: g.scope, target: g.target, notBefore: new Date(1_000).toISOString(), expiresAt: new Date(61_000).toISOString(), maxUses: 256 }), approverIdentityRef: "human:step4" }), checkpoint: "a1-test", decisionId: "forged", approverIdentityRef: "human:step4", approvedAt: new Date(1_000).toISOString(), approvedDigest: delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: g.scope, target: g.target, notBefore: new Date(1_000).toISOString(), expiresAt: new Date(61_000).toISOString(), maxUses: 256 }) },
    });
    expect(evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: { ...g.target, path: "other.txt" }, grant: { ...unpersisted, target: { ...g.target, path: "other.txt" }, targetDigest: "bad" }, clock: () => 1_000 }).proof.reason).toBe("INVALID_APPROVAL");
  });

  it("keeps lifecycle audit links and accepts multiple keyed canonical approvals", () => {
    const firstTarget = { kind: "workspace_read" as const, operation: "read" as const, path: "bounded.txt", maxBytes: 1024 };
    const secondTarget = { kind: "workspace_read" as const, operation: "status" as const, maxBytes: 1024 };
    const currentScope = scope(stateDir, "workspace_read");
    const notBefore = new Date(1_000).toISOString();
    const expiresAt = new Date(61_000).toISOString();
    const firstDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: currentScope, target: firstTarget, notBefore, expiresAt, maxUses: 256 });
    const secondDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: currentScope, target: secondTarget, notBefore, expiresAt, maxUses: 256 });
    const statePath = writeApprovalState(stateDir, 1_000, undefined, currentScope);
    fs.appendFileSync(statePath, `  delegation_approvals:\n    - decision_id: first\n      approved_digest: ${firstDigest}\n      action: workspace_read\n      scope_digest: ${delegationScopeDigest(currentScope)}\n      target_digest: ${delegationTargetDigest(firstTarget)}\n      approved_at: ${new Date(1_000).toISOString()}\n      approver_identity_ref: human:step4\n    - decision_id: second\n      approved_digest: ${secondDigest}\n      action: workspace_read\n      scope_digest: ${delegationScopeDigest(currentScope)}\n      target_digest: ${delegationTargetDigest(secondTarget)}\n      approved_at: ${new Date(1_000).toISOString()}\n      approver_identity_ref: human:step4\n`);
    const first = createDelegationGrant({ action: "workspace_read", scope: currentScope, target: firstTarget, grantId: "a1-first", notBefore, expiresAt, maxUses: 256, clock: () => 1_000, approval: { workflowStatePath: statePath, checkpoint: "a1-test", decisionId: "first", approverIdentityRef: "human:step4", approvedAt: new Date(1_000).toISOString(), approvedDigest: firstDigest } });
    const second = createDelegationGrant({ action: "workspace_read", scope: currentScope, target: secondTarget, grantId: "a1-second", notBefore, expiresAt, maxUses: 256, clock: () => 1_000, approval: { workflowStatePath: statePath, checkpoint: "a1-test", decisionId: "second", approverIdentityRef: "human:step4", approvedAt: new Date(1_000).toISOString(), approvedDigest: secondDigest } });
    expect(loadDelegationGrant(first.grantId)?.grantId).toBe("a1-first");
    expect(loadDelegationGrant(second.grantId)?.grantId).toBe("a1-second");
    const evaluated = evaluateWorkspaceRead({ action: "workspace_read", scope: currentScope, activeBinding: activeBinding(currentScope), target: firstTarget, grant: first, clock: () => 1_000 });
    expect(evaluated.proof.decision).toBe("ALLOW");
    const audit = readDelegationAudit(first.grantId);
    expect(audit.some((entry) => entry.approvalDecisionId === "first" && entry.approvalDigest === firstDigest)).toBe(true);
    expect(audit.some((entry) => entry.reservationState === "CONSUMED" && entry.auditReference)).toBe(true);
  });

  it("only rehydrates an explicit unfinished reservation and keeps revoke races fail-closed", () => {
    const g = grant(stateDir, "workspace_read");
    const reservation = reserveGrant(g, "workspace_read", g.target, { clock: () => 1_000 });
    const recovered = recoverDelegationReservation(reservation.reservationId, "workspace_read", g.target, () => 1_000);
    expect(recovered.reservationId).toBe(reservation.reservationId);
    const newRequest = reserveGrant(g, "workspace_read", g.target, { clock: () => 1_000 });
    expect(newRequest.reservationId).not.toBe(reservation.reservationId);
    expect(newRequest.decisionInstanceId).not.toBe(reservation.decisionInstanceId);
    expect(releaseGrant(reservation, () => 1_000).state).toBe("RELEASED");
    revokeDelegationGrant(g, { reason: "race-test", clock: () => 1_000 });
    expect(() => reserveGrant(g, "workspace_read", g.target, { clock: () => 1_000 })).toThrow(/active|known|superseded|revoked/i);
  });

  it("rechecks a reserved grant under the commit lease before A0 and records a denial", () => {
    const g = grant(stateDir, "workspace_read");
    const reservation = reserveGrant(g, "workspace_read", g.target, { clock: () => 1_000 });
    revokeDelegationGrant(g, { reason: "before-commit", clock: () => 1_000 });
    expect(() => assertDelegationReservationCommitReady(reservation, "workspace_read", g.target, () => 1_000)).toThrow(/no longer applicable|ready/i);
    expect(() => recoverDelegationReservation(reservation.reservationId, "workspace_read", g.target, () => 1_000)).toThrow(/no longer applicable|unfinished|changed/i);
    expect(() => consumeGrant(reservation, "workspace:read", () => 1_000)).toThrow(/no longer applicable|active|consumable/i);
    const denied = evaluateWorkspaceRead({ action: "workspace_read", scope: g.scope, activeBinding: activeBinding(g.scope), target: g.target, grantId: g.grantId, clock: () => 1_000 });
    expect(denied.proof.reason).toBe("GRANT_REVOKED");
    expect(readDelegationAudit(g.grantId).some((entry) => entry.decision === "DENY" && entry.reason === "GRANT_REVOKED")).toBe(true);
  });

  it("requires an exact canonical revocation decision before grant mutation", () => {
    const g = grant(stateDir, "workspace_read");
    const statePath = path.join(stateDir, ".harness", "a1-delegated-authorization", "state.yaml");
    const reason = "approved revocation";
    const approvedAt = new Date(2_000).toISOString();
    const approval = {
      workflowStatePath: statePath,
      checkpoint: "a1-test",
      decisionId: "revoke-1",
      approverIdentityRef: "human:step4-revoke",
      approvedAt,
      approvedDigest: delegationRevocationDigest(g.grantId, reason),
      grantId: g.grantId,
      reason,
    };
    expect(() => assertAuthoritativeRevocation(g, approval)).toThrow(/no grant-specific revocation/i);
    fs.appendFileSync(statePath, `\ndelegation_revocations:\n  - decision_id: ${approval.decisionId}\n    grant_id: ${approval.grantId}\n    checkpoint: ${approval.checkpoint}\n    approved_digest: ${approval.approvedDigest}\n    approved_at: ${approval.approvedAt}\n    approver_identity_ref: ${approval.approverIdentityRef}\n    reason: ${approval.reason}\n`);
    expect(() => assertAuthoritativeRevocation(g, approval)).not.toThrow();
    expect(revokeDelegationGrant(g, { approval, reason, clock: () => 2_000 }).status).toBe("REVOKED");
  });

  it("requires branded provider evidence only for a persisted provider-bound operation", () => {
    const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "provider-bound", ref: "refs/heads/main", expectedCommit: "abc" };
    const record = prepareGitHubOperation(target, "payload");
    const known = readKnownLogicalOperation(record.operationKey)!;
    expect(deriveOperationEvidencePath(known)).toBe("provider_bound");
    expect(deriveOperationEvidencePath(known, { source: "a0-receipt", receiptAuthorityId: "authority", receiptState: "RECONCILING", operationEvidence: { outcome: "ambiguous" }, evidencePath: "local_persisted" })).toBe("local_persisted");
    const gScope = scope(stateDir, "operation_reconcile");
    const operationTarget = { kind: "operation_reconcile" as const, operationKey: record.operationKey };
    const notBefore = new Date(1000).toISOString();
    const expiresAt = new Date(61_000).toISOString();
    const providerRequirement = { source: "teamai" as const, skillName: "github-cli-auth" as const, capabilityVersion: "1.0.0", expectedAccount: "a@example.com" };
    expect(() => createDelegationGrant({
      action: "operation_reconcile", scope: gScope, target: operationTarget,
      providerRequirement: { source: "teamai", skillName: "github-cli-auth", capabilityVersion: "1.0.0" } as never,
      persistedOperation: known, notBefore, expiresAt, maxUses: 256, clock: () => 1000,
      approval: { workflowStatePath: writeApprovalState(stateDir), checkpoint: "a1-test", decisionId: "missing-account", approverIdentityRef: "human:step4", approvedAt: new Date(1000).toISOString(), approvedDigest: "bad" },
    })).toThrow(/provider contract|grant approval/);
    const providerApprovalDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action: "operation_reconcile", scope: gScope, target: operationTarget, providerRequirement, notBefore, expiresAt, maxUses: 256 });
    const providerApprovalState = writeApprovalState(stateDir, 1_000, { action: "operation_reconcile", scopeDigest: delegationScopeDigest(gScope), targetDigest: delegationTargetDigest(operationTarget), decisionId: "step4-op", approvedDigest: providerApprovalDigest, approverIdentityRef: "human:step4" });
    const g = createDelegationGrant({
      action: "operation_reconcile",
      scope: gScope,
      target: operationTarget,
      providerRequirement,
      persistedOperation: known,
      approval: {
        workflowStatePath: providerApprovalState, checkpoint: "a1-test", decisionId: "step4-op", approverIdentityRef: "human:step4", approvedAt: new Date(1000).toISOString(), approvedDigest: providerApprovalDigest,
      },
      notBefore, expiresAt, maxUses: 256, clock: () => 1000,
    });
    const request = { action: "operation_reconcile" as const, scope: g.scope, activeBinding: activeBinding(g.scope), target: { kind: "operation_reconcile" as const, operationKey: record.operationKey }, grant: g, clock: () => 1000 };
    expect(evaluateOperationReconcile(request).proof.reason).toBe("TEAMAI_UNAVAILABLE");
    const provider: TeamAiCapabilityProvider = createTeamAiCapabilityProvider({ source: "teamai", skillName: "github-cli-auth", capabilityVersion: "1.0.0", classify: () => ({ classification: "healthy", correlationId: "provider-bound" }) });
    const result = resolveTeamAiAuthResult(provider, { correlationId: "provider-bound", expectedAccount: "a@example.com" });
    expect(evaluateOperationReconcile({ ...request, providerEvidence: result }).proof.decision).toBe("ALLOW");
  });

  it("ignores receipt-shaped files outside the canonical event-key receipt path", () => {
    const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "receipt-chain" };
    const key = operationKey(target);
    const eventKey = "receipt-chain-event";
    const payloadHash = "receipt-payload";
    const authorityId = "authority-receipt-chain";
    const binding = { workspaceId: "workspace-a1", taskId: "task-a1", checkpoint: "a1-test", stage: "Implementation + C2C Review", eventKey };
    const authorization = {
      schemaVersion: 1,
      generation: 0,
      authorityId,
      issuedAt: new Date(1_000).toISOString(),
      issuer: "canonical-workflow" as const,
      issuerId: "issuer-a1",
      operationKey: key,
      operationTarget: target,
      sourceCheckpoint: "a1-test",
      sourceStage: "Implementation + C2C Review",
      messageType: "EXECUTED" as const,
      eventKey,
      payloadHash,
      binding,
    };
    const receipt = {
      schemaVersion: 1,
      generation: 1,
      authorityId,
      eventKey,
      payloadHash,
      messageType: "EXECUTED" as const,
      binding,
      state: "RECONCILING" as const,
      sendAttempts: 0,
      reconciliationAttempts: 1,
      operationKey: key,
      operationTarget: target,
      operationEvidence: { outcome: "accepted" as const, target, payloadHash },
      history: [{ state: "RECONCILING" as const, at: new Date(1_000).toISOString() }],
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(2_000).toISOString(),
    };
    const statePath = (kind: "authorizations" | "receipts", name: string) => path.join(stateDir, "transport", kind, `${createHash("sha256").update(name).digest("hex").slice(0, 48)}.json`);
    writeAtomicSecureJson(statePath("authorizations", eventKey), authorization);
    writeAtomicSecureJson(path.join(stateDir, "transport", "receipts", "misplaced-receipt.json"), receipt);
    expect(readDeliveryReceiptForOperation(key, target, payloadHash)).toBeNull();
    writeAtomicSecureJson(statePath("receipts", eventKey), receipt);
    expect(readDeliveryReceiptForOperation(key, target, payloadHash)?.authorityId).toBe(authorityId);
  });

  it("retains independent audit appends for one grant", () => {
    const g = grant(stateDir, "workspace_read");
    recordDelegationAudit({ at: new Date(1_001).toISOString(), grantId: g.grantId, action: g.action, decision: "ALLOW", reason: "independent-a" });
    recordDelegationAudit({ at: new Date(1_002).toISOString(), grantId: g.grantId, action: g.action, decision: "DENY", reason: "independent-b" });
    const audit = readDelegationAudit(g.grantId);
    expect(audit.some((entry) => entry.reason === "independent-a")).toBe(true);
    expect(audit.some((entry) => entry.reason === "independent-b")).toBe(true);
  });

  it("rejects ambiguous or timestamp-mismatched grant approval records", () => {
    const currentScope = scope(stateDir, "workspace_read");
    const target = { kind: "workspace_read" as const, operation: "read" as const, path: "bounded.txt", maxBytes: 1024 };
    const notBefore = new Date(1_000).toISOString();
    const expiresAt = new Date(61_000).toISOString();
    const approvedDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action: "workspace_read", scope: currentScope, target, notBefore, expiresAt, maxUses: 256 });
    const statePath = path.join(stateDir, ".harness", "a1-delegated-authorization", "state.yaml");
    const record = `      decision_id: duplicate\n      approved_digest: ${approvedDigest}\n      action: workspace_read\n      scope_digest: ${delegationScopeDigest(currentScope)}\n      target_digest: ${delegationTargetDigest(target)}\n      approved_at: ${notBefore}\n      approver_identity_ref: human:step4`;
    fs.writeFileSync(statePath, `workflow:\n  step: 5\n  stage: Implementation + C2C Review\n  status: RUNNING\n  step4_approval:\n    approved: true\n  delegation_approvals:\n    -\n${record.replace(/^/gm, "      ")}\n    -\n${record.replace(/^/gm, "      ")}\n`);
    const approval = { workflowStatePath: statePath, checkpoint: "a1-test", decisionId: "duplicate", approverIdentityRef: "human:step4", approvedAt: notBefore, approvedDigest };
    expect(() => createDelegationGrant({ action: "workspace_read", scope: currentScope, target, notBefore, expiresAt, maxUses: 256, approval, clock: () => 1_000 })).toThrow(/ambiguous duplicate/i);
    fs.writeFileSync(statePath, `workflow:\n  step: 5\n  stage: Implementation + C2C Review\n  status: RUNNING\n  step4_approval:\n    approved: true\n  delegation_approvals:\n    - decision_id: duplicate\n      approved_digest: ${approvedDigest}\n      action: workspace_read\n      scope_digest: ${delegationScopeDigest(currentScope)}\n      target_digest: ${delegationTargetDigest(target)}\n      approved_at: ${new Date(2_000).toISOString()}\n      approver_identity_ref: human:step4\n`);
    expect(() => createDelegationGrant({ action: "workspace_read", scope: currentScope, target, notBefore, expiresAt, maxUses: 256, approval, clock: () => 1_000 })).toThrow(/timestamp/i);
  });
});
