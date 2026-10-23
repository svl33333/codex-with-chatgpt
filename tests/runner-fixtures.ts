import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { git, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { readCanonicalSelection, WORKFLOW_REPOSITORY } from "../src/runner/canonical.js";
import { CONTINUATION_KEYS } from "../src/runner/goal.js";
import { deriveCanonical28Binding } from "../src/conversation/authorization.js";
import { readWorktreeIdentity, writeConnectionBinding } from "../src/connection/identity.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeSession } from "../src/session/state.js";
import { appendExecutionRecord, bindExecutionToCanonicalReview, captureExecutionInputDigest } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { createDelegationGrant, delegationApprovalDigest, delegationScopeDigest, delegationTargetDigest, normalizeDelegationScope } from "../src/conversation/delegation.js";
import { runnerTransportTarget } from "../src/runner/headless.js";

// Synthetic contract fixtures exercise consumption, never publication readiness.
export function makeWorkflowFixture(): string {
  const root = makeTmpDir("runner-workflow");
  makeGitRepo(root);
  git(root, "remote", "add", "origin", WORKFLOW_REPOSITORY);
  write(root, "VERSION", "2.8.0\n");
  write(root, "schema/state.schema.json", JSON.stringify({ properties: {
    workflow: { properties: { status: { enum: ["READY", "RUNNING", "C2C_WAITING", "HUMAN_WAITING", "BLOCKED", "PUSH_WAITING", "DONE", "ABANDONED"] } } },
    c2c: { properties: { review_stage: { enum: ["pre_implementation", "post_implementation", "final", null] }, verdict: { enum: ["PASS", "FIX_REQUIRED", "HUMAN_DECISION_REQUIRED", "REQUIRED_CAPABILITY_UNAVAILABLE", null] }, last_action: { enum: ["REVIEW", "REMEDIATE", "VALIDATE", "HUMAN_GATE", "BLOCK", "PROCEED", null] } } },
  } }));
  write(root, "schema/c2c-review-contract.json", JSON.stringify({ verdicts: { PASS: { transition: "PROCEED", status: "READY" }, FIX_REQUIRED: { transition: "REMEDIATE", status: "RUNNING", human_waiting: false }, HUMAN_DECISION_REQUIRED: { transition: "HUMAN_GATE", human_waiting: true }, REQUIRED_CAPABILITY_UNAVAILABLE: { transition: "BLOCK" } } }));
  git(root, "add", "."); git(root, "commit", "-m", "synthetic workflow fixture");
  return root;
}

export function makeRunnerFixture(workflowCheckout: string) {
  const root = makeTmpDir("runner-workspace");
  makeGitRepo(root); git(root, "remote", "add", "origin", "https://github.com/example/runner-fixture");
  const workstream = "partial-a2";
  const harness = path.join(root, ".harness", workstream);
  const stateFile = write(root, `.harness/${workstream}/state.yaml`, "");
  write(root, `.harness/${workstream}/02-plan.md`, "Synthetic partial plan\n");
  const workspaceId = new Workspace(root).id;
  const state: Record<string, any> = { schema_version: "1.1", workflow: { profile: "codex-c2c-v2", spec_repository: WORKFLOW_REPOSITORY, spec_version: "2.8.0", spec_commit: git(workflowCheckout, "rev-parse", "HEAD").trim(), review_contract: "schema/c2c-review-contract.json", step: 5, stage: "Implementation + C2C Review", status: "RUNNING", step4_approval: { route: "direct", artifact: "02-plan.md", approved: true, approved_at: new Date().toISOString() } }, issue: { number: 10, url: "https://github.com/example/runner-fixture/issues/10" }, git: { branch: "main" }, c2c: { checkpoint: "fixture-checkpoint", review_stage: "post_implementation", verdict: null, cycle: 1, last_action: "REVIEW", human_action_queue: [] } };
  const goalPath = path.join(harness, "goal.json");
  const goal = { schemaVersion: 1, id: "partial-foundation", revision: 1, objective: "Bounded synthetic invocation", createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), selection: { repository: "https://github.com/example/runner-fixture", workspaceRoot: root, workstream, branch: "main", statePath: "state.yaml" }, continuationKeys: [...CONTINUATION_KEYS] };
  const input = { workspaceRoot: root, workstream, workflowCheckout, goalPath };
  const saveState = () => fs.writeFileSync(stateFile, stringify(state));
  const saveGoal = () => fs.writeFileSync(goalPath, JSON.stringify(goal));
  function ownerContext() {
    const identity = readWorktreeIdentity({ workspaceRoot: root });
    writeConnectionBinding({ schemaVersion: 1, workspaceId, workspace: root, canonicalRepository: goal.selection.repository, installationId: identity.installationId, endpointMode: "local", endpointFingerprint: "fixture-endpoint", connectorName: "fixture-connector", projectId: "g-p-fixture", updatedAt: new Date().toISOString() });
    writeSession(workspaceId, { taskId: "fixture-runtime-task", iteration: 7, url: "https://chatgpt.com/c/fixture-chat", projectUrl: "https://chatgpt.com/g/g-p-fixture/project", savedAt: new Date().toISOString(), transport: { workspaceId, workspaceRoot: root, repository: goal.selection.repository, worktreeRoot: root, branch: "main", checkpoint: state.c2c.checkpoint, stage: state.workflow.stage, mcpAppId: "fixture-app", mcpVersionId: "fixture-version", projectId: "g-p-fixture", chatId: "fixture-chat", codexSessionId: "fixture-codex", connectorName: "fixture-connector" } });
    const output = saveExecutionOutput(workspaceId, { command: "synthetic test", raw: "synthetic tests passed", exitCode: 0, taskId: "fixture-runtime-task", iteration: 7 });
    const canonicalReview = state.workflow.step === 5 ? bindExecutionToCanonicalReview({ ...input, beforeInputDigest: captureExecutionInputDigest(root) }) : undefined;
    appendExecutionRecord(workspaceId, { taskId: "fixture-runtime-task", iteration: 7, changedFiles: [], tests: "synthetic tests passed", exitStatus: "ok", timestamp: new Date().toISOString(), outputId: output.id, outputAvailable: true, canonicalReview });
  }
  function request(action: "c2c_transport" | "workspace_read" | "operation_reconcile" = "c2c_transport", maxUses = 1) {
    const selection = readCanonicalSelection(input);
    const binding = deriveCanonical28Binding(input);
    const scope = normalizeDelegationScope({ workspaceId, workstreamId: workstream, workspaceRoot: root, canonicalRepository: goal.selection.repository, worktreeRoot: root, branch: "main", stage: state.workflow.stage, canonicalAction: action }, action);
    const target = action === "c2c_transport" ? runnerTransportTarget(selection, binding) : action === "workspace_read" ? { kind: "workspace_read" as const, operation: "status" as const, maxBytes: 1024 } : { kind: "operation_reconcile" as const, operationKey: "unknown-fixture-operation" };
    const notBefore = new Date(Date.now() - 1000).toISOString();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const approvedAt = new Date().toISOString();
    const approvedDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action, scope, target, notBefore, expiresAt, maxUses });
    const approvals = state.delegation_approvals ?? [];
    const decisionId = `fixture-human-decision-${approvals.length + 1}`;
    state.delegation_approvals = [...approvals, { decision_id: decisionId, approved_digest: approvedDigest, action, scope_digest: delegationScopeDigest(scope), target_digest: delegationTargetDigest(target), approved_at: approvedAt, approver_identity_ref: "human:fixture" }];
    saveState();
    const grant = createDelegationGrant({ action, scope, target, notBefore, expiresAt, maxUses, approval: { workflowStatePath: stateFile, checkpoint: state.c2c.checkpoint, decisionId, approverIdentityRef: "human:fixture", approvedAt, approvedDigest } });
    return { action, scope, target, grantId: grant.grantId };
  }
  saveState(); saveGoal(); ownerContext();
  return { root, harness, stateFile, workspaceId, input, state, goal, goalPath, saveState, saveGoal, ownerContext, request };
}
