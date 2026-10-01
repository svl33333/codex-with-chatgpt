import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeReviewerResponse,
  deriveActiveCanonicalBinding,
  createWorkflowAuthorizationIssuer,
  issueDeliveryAuthorization,
  markSending,
  prepareAuthorizedDelivery,
  readDeliveryReceipt,
  recordBrowserObservation,
  recordTeamAiAuthObservation,
  revokeDeliveryAuthorization,
  reconcileDelivery,
  type TransportBindingIdentity,
} from "../src/conversation/authorization.js";
import { buildC2cEnvelope } from "../src/conversation/envelope.js";
import { deliverMessage, type MessageAdapter } from "../src/conversation/delivery.js";
import { createTeamAiCapabilityProvider, resolveTeamAiAuthResult, type TeamAiCapabilityProvider } from "../src/conversation/teamai.js";
import { readWorktreeIdentity } from "../src/connection/identity.js";
import { cleanup, isolateStateDir } from "./helpers.js";

function binding(eventKey = "c2c_test1"): TransportBindingIdentity {
  const root = process.env.C2C_STATE_DIR ?? "C:/workspace";
  const worktree = readWorktreeIdentity({ workspaceRoot: root });
  return {
    workspaceId: "workspace-a",
    workspaceName: "a0",
    ...worktree,
    workstreamId: "a0-reliable-c2c-transport-core",
    endpointFingerprint: "endpoint-hash",
    connectorName: "a0-connector",
    mcpAppId: "app-a0",
    mcpVersionId: "version-a0",
    projectId: "project-a0",
    chatId: "chat-a0",
    codexSessionId: "session-a0",
    taskId: eventKey,
    checkpoint: eventKey,
    stage: "Implementation + C2C Review",
    eventKey,
  };
}

function issuerFor(exact: TransportBindingIdentity, stateDir: string, messageType: "INIT" | "HANDOFF" | "PLAN" | "EXECUTED" | "REVIEW" | "RE_REVIEW" = "EXECUTED") {
  const statePath = path.join(stateDir, ".harness", exact.workstreamId!, "state.yaml");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `schema_version: "1.1"\nworkflow:\n  step: 5\n  stage: Implementation + C2C Review\n  status: RUNNING\n  step4_approval:\n    approved: true\nrunner_preflight:\n  workspace_id: ${exact.workspaceId}\n  workspace_root: ${exact.workspaceRoot}\n  verified_workspace_name: ${exact.workspaceName}\n  canonical_repository: ${exact.canonicalRepository}\n  worktree_root: ${exact.worktreeRoot}\n  verified_branch: ${exact.branch}\n  verified_commit: ${exact.observedCommit}\n  dirty_state: ${exact.dirtyState}\n  installation_id: ${exact.installationId}\n  endpoint_fingerprint: ${exact.endpointFingerprint}\n  connector_name: ${exact.connectorName}\n  connector_app_id: ${exact.mcpAppId}\n  connector_version_id: ${exact.mcpVersionId}\n  project_id: ${exact.projectId}\n  chat_id: ${exact.chatId}\n  codex_session_id: ${exact.codexSessionId}\nc2c:\n  checkpoint: ${exact.checkpoint}\n  task_id: ${exact.taskId}\n  event_key: ${exact.eventKey}\n  authorized_action: ${messageType}\n  review_stage: post_implementation\n`
  );
  const active = deriveActiveCanonicalBinding({ workspaceRoot: stateDir, workspaceId: exact.workspaceId, candidate: exact });
  return createWorkflowAuthorizationIssuer({ workflowStep: 5, stage: exact.stage, issuerId: "step5", messageType, binding: active });
}

function teamAiResult(classification: "healthy" | "credential_context_unavailable" | "auth_invalid_or_expired" | "human_security_boundary" | "capability_unavailable", correlationId: string, expectedAccount?: string) {
  const provider: TeamAiCapabilityProvider = createTeamAiCapabilityProvider({
    source: "teamai",
    skillName: "github-cli-auth",
    capabilityVersion: "github-cli-auth@current",
    classify: () => ({ classification, correlationId, expectedAccount }),
  });
  return resolveTeamAiAuthResult(provider, { correlationId, expectedAccount, authAttemptId: correlationId, restrictedContextError: "hosts.yml: Access is denied" });
}

describe("durable authorized C2C delivery", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("persists a monotonic receipt and consumes one response exactly once", () => {
    const exact = binding();
    const envelope = buildC2cEnvelope({
      type: "EXECUTED",
      taskId: exact.taskId,
      iteration: 0,
      checkpoint: exact.checkpoint,
      stage: exact.stage,
      workspaceId: exact.workspaceId,
      eventKey: exact.eventKey,
      intent: "Review the bounded implementation evidence",
    });
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "EXECUTED",
      eventKey: exact.eventKey,
      payloadHash: envelope.payloadHash,
      binding: exact,
    });
    expect(prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "EXECUTED", eventKey: exact.eventKey, payloadHash: envelope.payloadHash }).state).toBe("PREPARED");
    expect(markSending(authorization, exact, "process-a", "session-a").state).toBe("SENDING");
    expect(() => recordBrowserObservation({ authorization, binding: exact, outcome: "visible", remoteId: "bubble-missing-proof", evidenceHash: "visible-hash" })).toThrow(/exact remote bubble/);
    const visible = recordBrowserObservation({
      authorization,
      binding: exact,
      outcome: "visible",
      remoteId: "bubble-1",
      evidenceHash: "visible-hash",
      observedEventKey: exact.eventKey,
      observedPayloadHash: envelope.payloadHash,
    });
    expect(visible.state).toBe("DELIVERED_VISIBLE");
    const response = consumeReviewerResponse({ authorization, binding: exact, responseKey: "response-1", responseHash: "response-hash" });
    expect(response.state).toBe("RESPONSE_RECEIVED");
    expect(consumeReviewerResponse({ authorization, binding: exact, responseKey: "response-1", responseHash: "response-hash" }).responseConsumedAt).toBe(response.responseConsumedAt);
    expect(readDeliveryReceipt(exact.eventKey)?.history.map((entry) => entry.state)).toEqual([
      "PREPARED",
      "SENDING",
      "DELIVERED_VISIBLE",
      "RESPONSE_RECEIVED",
    ]);
  });

  it("rejects same-key payload changes and requires reconciliation after ambiguity", () => {
    const exact = binding("c2c_test2");
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir, "REVIEW"),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "REVIEW",
      eventKey: exact.eventKey,
      payloadHash: "payload-a",
      binding: exact,
    });
    prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "REVIEW", eventKey: exact.eventKey, payloadHash: "payload-a" });
    expect(() => prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "REVIEW", eventKey: exact.eventKey, payloadHash: "payload-b" })).toThrow(/payload hash/);
    markSending(authorization, exact);
    expect(recordBrowserObservation({ authorization, binding: exact, outcome: "ambiguous", reason: "timeout" }).state).toBe("AMBIGUOUS");
    expect(() => markSending(authorization, exact)).toThrow(/reconciliation/);
    expect(reconcileDelivery({ authorization, binding: exact, outcome: "definite_not_accepted", reason: "exact remote target is absent" }).state).toBe("FAILED_DEFINITE");
    expect(markSending(authorization, exact).state).toBe("SENDING");
  });

  it("records TeamAI credential-context results without classifying the observation locally", () => {
    const exact = binding("c2c_auth1");
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "EXECUTED",
      eventKey: exact.eventKey,
      payloadHash: "payload-auth",
      binding: exact,
    });
    prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "EXECUTED", eventKey: exact.eventKey, payloadHash: "payload-auth" });
    expect(() => recordTeamAiAuthObservation({
      authorization,
      binding: exact,
      state: "AUTH_CONTEXT_RECONCILING",
      capabilityResult: {
        classifier: "github-cli-auth",
        source: "teamai",
        capabilityVersion: "github-cli-auth@current",
        classification: "credential_context_unavailable",
        correlationId: "forged",
      } as never,
    })).toThrow(/unverified TeamAI/);
    const observation = recordTeamAiAuthObservation({
      authorization,
      binding: exact,
      state: "AUTH_CONTEXT_RECONCILING",
      capabilityResult: teamAiResult("credential_context_unavailable", "c2c_auth1-attempt", "expected@example.com"),
      expectedAccount: "expected@example.com",
      reason: "hosts.yml: Access is denied",
    });
    expect(observation.authRecovery?.classifier).toBe("github-cli-auth");
    expect(observation.authRecovery?.classification).toBe("credential_context_unavailable");
    expect(observation.reason).toContain("hosts.yml");
  });

  it("fails closed for a forged or revoked in-memory authority", () => {
    const exact = binding("c2c_forge1");
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir, "REVIEW"),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "REVIEW",
      eventKey: exact.eventKey,
      payloadHash: "payload-forge",
      binding: exact,
    });
    prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "REVIEW", eventKey: exact.eventKey, payloadHash: "payload-forge" });
    expect(() => markSending({ ...authorization, authorityId: "foreign" }, exact)).toThrow(/persisted canonical/);
    expect(() => markSending({ ...authorization, generation: authorization.generation - 1 }, exact)).toThrow(/persisted canonical/);
    revokeDeliveryAuthorization(authorization);
    expect(() => markSending(authorization, exact)).toThrow(/revoked/);
  });

  it("binds the issuer to the actual canonical state schema and current Step 5 action", () => {
    const exact = binding("c2c_issuer_schema");
    const issuer = issuerFor(exact, stateDir, "REVIEW");
    expect(issuer.authorizedAction).toBe("REVIEW");

    const statePath = path.join(stateDir, ".harness", exact.workstreamId!, "state.yaml");
    const state = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(statePath, state.replace("stage: Implementation + C2C Review", "stage: Step 4 / HUMAN_WAITING"));
    expect(() => createWorkflowAuthorizationIssuer({
      workflowStep: 5,
      stage: exact.stage,
      issuerId: "step5",
      messageType: "REVIEW",
      binding: exact,
    })).toThrow(/canonical workflow|active canonical/);
    fs.writeFileSync(statePath, state.replace(`workspace_root: ${exact.workspaceRoot}`, "workspace_root: C:/forged-workspace"));
    expect(() => createWorkflowAuthorizationIssuer({
      workflowStep: 5,
      stage: exact.stage,
      issuerId: "step5",
      messageType: "REVIEW",
      binding: exact,
    })).toThrow(/canonical workflow|active canonical/);
  });

  it("derives the active workstream and checkpoint from the harness, not binding metadata", () => {
    const exact = binding("c2c_active_binding");
    issuerFor(exact, stateDir);
    const derived = deriveActiveCanonicalBinding({ workspaceRoot: stateDir, workspaceId: exact.workspaceId, candidate: exact });
    expect(derived.workspaceRoot).toBe(path.resolve(stateDir));
    expect(derived.workspaceId).toBe(exact.workspaceId);
    expect(derived.workstreamId).toBe(exact.workstreamId);
    expect(derived.checkpoint).toBe(exact.checkpoint);
    expect(derived.stage).toBe(exact.stage);
    expect(() => deriveActiveCanonicalBinding({
      workspaceRoot: stateDir,
      workspaceId: exact.workspaceId,
      candidate: { ...exact, workspaceRoot: path.join(stateDir, "other") },
    })).toThrow(/active workspace/);
    expect(() => deriveActiveCanonicalBinding({
      workspaceRoot: stateDir,
      workspaceId: exact.workspaceId,
      candidate: { ...exact, mcpAppId: undefined },
    })).toThrow(/incomplete/);
  });

  it("refreshes commit and dirty evidence after publication-only state changes", () => {
    const exact = binding("c2c_event_time_refresh");
    const before = issuerFor(exact, stateDir);
    const statePath = path.join(stateDir, ".harness", exact.workstreamId!, "state.yaml");
    const staleDirtyState = exact.dirtyState === "clean" ? "dirty" : "clean";
    const state = fs.readFileSync(statePath, "utf8")
      .replace(`verified_commit: ${exact.observedCommit}`, "verified_commit: stale-publication-commit")
      .replace(`dirty_state: ${exact.dirtyState}`, `dirty_state: ${staleDirtyState}`);
    fs.writeFileSync(statePath, state);

    const refreshed = deriveActiveCanonicalBinding({ workspaceRoot: stateDir, workspaceId: exact.workspaceId, candidate: exact });
    const activeWorktree = readWorktreeIdentity({ workspaceRoot: stateDir });
    expect(refreshed.observedCommit).toBe(activeWorktree.observedCommit);
    expect(refreshed.dirtyState).toBe(activeWorktree.dirtyState);
    expect(refreshed.observedCommit).not.toBe("stale-publication-commit");

    const after = createWorkflowAuthorizationIssuer({
      workflowStep: 5,
      stage: exact.stage,
      issuerId: "step5",
      messageType: "EXECUTED",
      binding: refreshed,
    });
    expect(after.bindingDigest).toBe(before.bindingDigest);
    expect(() => deriveActiveCanonicalBinding({
      workspaceRoot: stateDir,
      workspaceId: exact.workspaceId,
      candidate: { ...exact, branch: "forged-publication-branch" },
    })).toThrow(/canonical transport binding mismatch|active workspace worktree identity/);
  });

  it("does not let a valid Step 5 checkpoint mint a caller-selected action", () => {
    const exact = binding("c2c_action_binding");
    const statePath = path.join(stateDir, ".harness", exact.workstreamId!, "state.yaml");
    issuerFor(exact, stateDir, "EXECUTED");
    const active = deriveActiveCanonicalBinding({ workspaceRoot: stateDir, workspaceId: exact.workspaceId, candidate: exact });
    expect(() => createWorkflowAuthorizationIssuer({
      workflowStep: 5,
      stage: exact.stage,
      issuerId: "caller-selected",
      messageType: "REVIEW",
      binding: active,
    })).toThrow(/action does not authorize/);
    expect(fs.readFileSync(statePath, "utf8")).toContain("authorized_action: EXECUTED");
  });

  it("requires a TeamAI-branded provider before resolving a classification", () => {
    expect(() => resolveTeamAiAuthResult({
      source: "teamai",
      skillName: "github-cli-auth",
      capabilityVersion: "github-cli-auth@forged",
      classify: () => ({ classification: "healthy" }),
    } as never, { correlationId: "forged-provider" })).toThrow(/runtime boundary/);
  });

  it("passes through every TeamAI classification and rejects stale auth callbacks", () => {
    const cases = [
      ["healthy", "AUTH_HEALTHY"],
      ["auth_invalid_or_expired", "INTERRUPTED_AUTH_PENDING"],
      ["human_security_boundary", "WAITING_HUMAN_SECURITY_BOUNDARY"],
      ["capability_unavailable", "AUTH_CONTEXT_RECONCILING"],
    ] as const;
    for (const [classification, state] of cases) {
      const exact = binding(`c2c_auth_${classification}`);
      const authorization = issueDeliveryAuthorization({
        issuer: issuerFor(exact, stateDir),
        sourceCheckpoint: exact.checkpoint,
        sourceStage: exact.stage,
        messageType: "EXECUTED",
        eventKey: exact.eventKey,
        payloadHash: `payload-${classification}`,
        binding: exact,
      });
      prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "EXECUTED", eventKey: exact.eventKey, payloadHash: `payload-${classification}` });
      const receipt = recordTeamAiAuthObservation({
        authorization,
        binding: exact,
        state,
        capabilityResult: teamAiResult(classification, "attempt-current"),
      });
      expect(receipt.authRecovery?.classification).toBe(classification);
      expect(receipt.authRecovery?.state).toBe(state);
    }

    const exact = binding("c2c_auth_stale");
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "EXECUTED",
      eventKey: exact.eventKey,
      payloadHash: "payload-stale",
      binding: exact,
    });
    prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "EXECUTED", eventKey: exact.eventKey, payloadHash: "payload-stale" });
    recordTeamAiAuthObservation({ authorization, binding: exact, state: "TEAMAI_RECOVERY_ACTIVE", capabilityResult: teamAiResult("auth_invalid_or_expired", "attempt-new") });
    expect(() => recordTeamAiAuthObservation({ authorization, binding: exact, state: "AUTH_HEALTHY", capabilityResult: teamAiResult("healthy", "attempt-old") })).toThrow(/stale authentication attempt/);
  });

  it("requires operation-specific evidence before accepting a GitHub continuation", () => {
    const exact = binding("c2c_operation_delivery");
    const target = {
      kind: "push" as const,
      repository: exact.canonicalRepository!,
      logicalOperationId: "c2c_operation_delivery",
      ref: "refs/heads/main",
      expectedCommit: "abc123",
    };
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "EXECUTED",
      eventKey: exact.eventKey,
      payloadHash: "payload-operation",
      binding: exact,
      operationTarget: target,
    });
    prepareAuthorizedDelivery({ authorization, binding: exact, messageType: "EXECUTED", eventKey: exact.eventKey, payloadHash: "payload-operation" });
    markSending(authorization, exact);
    expect(reconcileDelivery({ authorization, binding: exact, outcome: "accepted" }).state).toBe("AMBIGUOUS");
    expect(
      reconcileDelivery({
        authorization,
        binding: exact,
        outcome: "accepted",
        operationObservation: { observedRepository: exact.canonicalRepository, observedRef: "refs/heads/main", observedCommit: "abc123" },
      }).state
    ).toBe("WAITING_RESPONSE");
  });

  it("requires visible evidence in the authorized delivery integration and never resends", async () => {
    const exact = binding("c2c_delivery1");
    const envelope = buildC2cEnvelope({
      type: "EXECUTED",
      taskId: exact.taskId,
      iteration: 1,
      checkpoint: exact.checkpoint,
      stage: exact.stage,
      workspaceId: exact.workspaceId,
      eventKey: exact.eventKey,
      intent: "bounded execution evidence is ready",
    });
    const authorization = issueDeliveryAuthorization({
      issuer: issuerFor(exact, stateDir),
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      messageType: "EXECUTED",
      eventKey: exact.eventKey,
      payloadHash: envelope.payloadHash,
      binding: exact,
    });
    class Adapter implements MessageAdapter {
      sendCalls = 0;
      status: "unknown" | "accepted" = "unknown";
      visible = false;
      async sendMessage() {
        this.sendCalls += 1;
        return { remoteId: "bubble-transport" };
      }
      async getMessageStatus() {
        return this.status;
      }
      async observeVisibleBubble() {
        return this.visible
          ? { visible: true, remoteId: "bubble-visible", evidenceHash: "visible-proof", observedEventKey: exact.eventKey, observedPayloadHash: envelope.payloadHash }
          : { visible: false };
      }
    }
    const adapter = new Adapter();
    const intent = {
      taskId: exact.taskId,
      iteration: 1,
      messageId: exact.eventKey,
      text: envelope.text,
      workspaceId: exact.workspaceId,
      workstreamId: "a0-reliable-c2c-transport-core",
      binding: exact,
      authorization,
      messageType: "EXECUTED" as const,
      payloadHash: envelope.payloadHash,
    };
    const first = await deliverMessage(intent, adapter);
    expect(first.result).toBe("WAITING");
    expect(first.receipt?.state).toBe("AMBIGUOUS");
    expect(adapter.sendCalls).toBe(1);
    const second = await deliverMessage(intent, adapter);
    expect(second.result).toBe("WAITING");
    expect(adapter.sendCalls).toBe(1);
    adapter.status = "accepted";
    const reconciled = await deliverMessage(intent, adapter);
    expect(reconciled.result).toBe("WAITING");
    expect(reconciled.receipt?.state).toBe("WAITING_RESPONSE");
    expect(reconciled.state).toBe("ambiguous");
    expect(adapter.sendCalls).toBe(1);
    expect(() => consumeReviewerResponse({ authorization, binding: exact, responseKey: "response-before-visible", responseHash: "hash" })).toThrow(/exact visible/);
    adapter.visible = true;
    const visible = await deliverMessage(intent, adapter);
    expect(visible.receipt?.state).toBe("DELIVERED_VISIBLE");
    expect(visible.state).toBe("confirmed");
    expect(adapter.sendCalls).toBe(1);
    expect(consumeReviewerResponse({ authorization, binding: exact, responseKey: "response-after-visible", responseHash: "hash" }).state).toBe("RESPONSE_RECEIVED");
  });
});
