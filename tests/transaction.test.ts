import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurableTransportTransaction } from "../src/conversation/transaction.js";
import { createTeamAiCapabilityProvider, resolveTeamAiAuthResult, type TeamAiCapabilityProvider } from "../src/conversation/teamai.js";
import type { TransportBindingIdentity } from "../src/conversation/authorization.js";
import type { MessageAdapter } from "../src/conversation/delivery.js";
import { readWorktreeIdentity } from "../src/connection/identity.js";
import { cleanup, isolateStateDir } from "./helpers.js";

function binding(stateDir: string): TransportBindingIdentity {
  const worktree = readWorktreeIdentity({ workspaceRoot: stateDir });
  return {
    workspaceId: "workspace-transaction",
    ...worktree,
    workspaceName: "transaction",
    workstreamId: "a0-reliable-c2c-transport-core",
    endpointFingerprint: "endpoint-transaction",
    connectorName: "connector-transaction",
    mcpAppId: "app-transaction",
    mcpVersionId: "version-transaction",
    projectId: "project-transaction",
    chatId: "chat-transaction",
    codexSessionId: "session-transaction",
    taskId: "c2c_transaction",
    checkpoint: "c2c_transaction",
    stage: "Implementation + C2C Review",
    eventKey: "c2c_transaction",
  };
}

function writeCanonicalState(exact: TransportBindingIdentity): void {
  const file = path.join(exact.workspaceRoot!, ".harness", exact.workstreamId!, "state.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `schema_version: "1.1"\nworkflow:\n  step: 5\n  stage: Implementation + C2C Review\n  status: RUNNING\n  step4_approval:\n    approved: true\nrunner_preflight:\n  workspace_id: ${exact.workspaceId}\n  workspace_root: ${exact.workspaceRoot}\n  verified_workspace_name: ${exact.workspaceName}\n  canonical_repository: ${exact.canonicalRepository}\n  worktree_root: ${exact.worktreeRoot}\n  verified_branch: ${exact.branch}\n  verified_commit: ${exact.observedCommit}\n  dirty_state: ${exact.dirtyState}\n  installation_id: ${exact.installationId}\n  endpoint_fingerprint: ${exact.endpointFingerprint}\n  connector_name: ${exact.connectorName}\n  connector_app_id: ${exact.mcpAppId}\n  connector_version_id: ${exact.mcpVersionId}\n  project_id: ${exact.projectId}\n  chat_id: ${exact.chatId}\n  codex_session_id: ${exact.codexSessionId}\nc2c:\n  checkpoint: ${exact.checkpoint}\n  task_id: ${exact.taskId}\n  event_key: ${exact.eventKey}\n  authorized_action: EXECUTED\n  review_stage: post_implementation\n`);
}

describe("durable transport transaction surface", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("executes prepare, TeamAI pass-through, browser observation, and one response through the runtime seam", async () => {
    const exact = binding(stateDir);
    writeCanonicalState(exact);
    const transaction = createDurableTransportTransaction();
    const prepared = transaction.beginAndPrepare({
      workflowStep: 5,
      stage: exact.stage,
      issuerId: "transaction-test",
      messageType: "EXECUTED",
      binding: exact,
      sourceCheckpoint: exact.checkpoint,
      sourceStage: exact.stage,
      eventKey: exact.eventKey,
      payloadHash: "payload-transaction",
    });
    expect(prepared.receipt.state).toBe("PREPARED");

    const provider: TeamAiCapabilityProvider = createTeamAiCapabilityProvider({
      source: "teamai",
      skillName: "github-cli-auth",
      capabilityVersion: "github-cli-auth@test",
      classify: () => ({ classification: "healthy", correlationId: "transaction-auth" }),
    });
    const authReceipt = transaction.observeTeamAi({
      authorization: prepared.authorization,
      binding: exact,
      state: "AUTH_HEALTHY",
      capabilityResult: resolveTeamAiAuthResult(provider, { correlationId: "transaction-auth" }),
    });
    expect(authReceipt.authRecovery?.classification).toBe("healthy");

    class Adapter implements MessageAdapter {
      sends = 0;
      async sendMessage() {
        this.sends += 1;
        return { remoteId: "transaction-bubble" };
      }
      async observeVisibleBubble() {
        return { visible: true, remoteId: "transaction-bubble", evidenceHash: "transaction-proof", observedEventKey: exact.eventKey, observedPayloadHash: "payload-transaction" };
      }
      async getMessageStatus() {
        return "accepted" as const;
      }
    }
    const adapter = new Adapter();
    const delivered = await transaction.deliver({
      taskId: exact.taskId,
      iteration: 1,
      messageId: exact.eventKey,
      text: "[C2C] bounded transaction",
      workspaceId: exact.workspaceId,
      workstreamId: exact.workstreamId,
      binding: exact,
      authorization: prepared.authorization,
      messageType: "EXECUTED",
      payloadHash: "payload-transaction",
    }, adapter);
    expect(delivered.receipt?.state).toBe("DELIVERED_VISIBLE");
    expect(adapter.sends).toBe(1);
    expect(transaction.consumeResponse({
      authorization: prepared.authorization,
      binding: exact,
      responseKey: "response-transaction",
      responseHash: "response-hash",
    }).state).toBe("RESPONSE_RECEIVED");
  });
});
