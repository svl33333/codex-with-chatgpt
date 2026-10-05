import { createHash } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { messageIdempotencyKey, type MessageIntent } from "./delivery.js";
import { validateReviewerProof, validateReviewerProofIntegrity, type ReviewerProof, type ReviewerProofIdentity } from "../provisioning/reviewer-proof.js";

export type AppSelectionMethod = "mention" | "composer" | "product_equivalent";
export type AppInvocationState = "pending" | "succeeded" | "failed";

export interface AppSelectionRecord {
  schemaVersion: 1 | 2;
  workspaceId: string;
  targetWorkstream: string;
  projectBinding?: string;
  reviewerBinding?: string;
  connectorName: string;
  messageKey: string;
  requestedApp: string;
  selectionMethod: AppSelectionMethod;
  currentMessageAvailable: boolean;
  invocation: AppInvocationState;
  workspaceVerified: boolean;
  readOnlyCapability?: "read-only";
  reviewerProof?: ReviewerProof;
  reviewerProofExpected?: ReviewerProofIdentity;
  failure?: "app_unavailable" | "workspace_mismatch" | "read_only_mismatch" | "unknown";
  updatedAt: string;
}

export interface AppSelectionInput {
  workspaceId: string;
  targetWorkstream: string;
  projectBinding?: string;
  reviewerBinding?: string;
  connectorName: string;
  intent: Pick<MessageIntent, "taskId" | "iteration" | "messageId">;
  requestedApp: string;
  selectionMethod: AppSelectionMethod;
  currentMessageAvailable: boolean;
  invocation: AppInvocationState;
  workspaceVerified: boolean;
  readOnlyCapability?: "read-only";
  reviewerProof?: ReviewerProof;
  reviewerProofExpected?: ReviewerProofIdentity;
  failure?: AppSelectionRecord["failure"];
}

export type AppSelectionIntent = Pick<MessageIntent, "taskId" | "iteration" | "messageId">;

function selectionFile(workspaceId: string, messageKey: string): string {
  const fileKey = createHash("sha256").update(`${workspaceId}\0${messageKey}`).digest("hex").slice(0, 32);
  return path.join(getStateDir(), "app-selections", `${fileKey}.json`);
}

/** Persist only the current-message app evidence, keyed by delivery identity. */
export function recordAppSelection(input: AppSelectionInput): AppSelectionRecord {
  const messageKey = messageIdempotencyKey(input.intent);
  const existing = readJsonIfExists<AppSelectionRecord>(selectionFile(input.workspaceId, messageKey));
  if (
    existing &&
    (existing.schemaVersion !== 1 && existing.schemaVersion !== 2 ||
      existing.workspaceId !== input.workspaceId ||
      existing.messageKey !== messageKey ||
      existing.targetWorkstream !== input.targetWorkstream ||
      existing.connectorName !== input.connectorName ||
      existing.requestedApp !== input.requestedApp)
  ) {
    throw new Error("app selection message identity mismatch");
  }
  if (input.reviewerProof && input.reviewerProof.messageKey !== messageKey) {
    throw new Error("reviewer proof message identity mismatch");
  }
  if (input.readOnlyCapability === "read-only" && !input.reviewerProof) {
    throw new Error("read-only app selection requires structured reviewer proof");
  }
  if (input.reviewerProof && input.reviewerProof.appIdentity.workspaceId !== input.workspaceId) {
    throw new Error("reviewer proof workspace identity mismatch");
  }
  if (input.invocation === "succeeded" && input.reviewerProofExpected) {
    if (!input.reviewerProof || !input.reviewerProofExpected) {
      throw new Error("WORKSPACE_MISMATCH: succeeded app selection requires exact reviewer proof identity");
    }
    const validation = validateReviewerProofIntegrity(input.reviewerProof);
    if (!validation.ok) throw new Error(`WORKSPACE_MISMATCH: ${validation.reason}`);
    const expectedValidation = validateReviewerProof(input.reviewerProof, input.reviewerProofExpected);
    if (!expectedValidation.ok) throw new Error(`WORKSPACE_MISMATCH: ${expectedValidation.reason}`);
  }
  const record: AppSelectionRecord = {
    schemaVersion: input.reviewerProof ? 2 : 1,
    workspaceId: input.workspaceId,
    targetWorkstream: input.targetWorkstream,
    ...(input.projectBinding ? { projectBinding: input.projectBinding } : {}),
    ...(input.reviewerBinding ? { reviewerBinding: input.reviewerBinding } : {}),
    connectorName: input.connectorName,
    messageKey,
    requestedApp: input.requestedApp,
    selectionMethod: input.selectionMethod,
    currentMessageAvailable: input.currentMessageAvailable,
    invocation: input.invocation,
    workspaceVerified: input.workspaceVerified,
    ...(input.readOnlyCapability ? { readOnlyCapability: input.readOnlyCapability } : {}),
    ...(input.reviewerProof ? { reviewerProof: input.reviewerProof } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeSecureJson(selectionFile(input.workspaceId, messageKey), record);
  return record;
}

export function readAppSelection(
  workspaceId: string,
  intent: AppSelectionIntent
): AppSelectionRecord | null {
  const messageKey = messageIdempotencyKey(intent);
  const record = readJsonIfExists<AppSelectionRecord>(selectionFile(workspaceId, messageKey));
  if (!record || (record.schemaVersion !== 1 && record.schemaVersion !== 2) || record.workspaceId !== workspaceId || record.messageKey !== messageKey) return null;
  return record;
}

export function isAppSelectionVerified(record: AppSelectionRecord | null): boolean {
  if (!record || !record.currentMessageAvailable || record.invocation !== "succeeded" || !record.workspaceVerified) return false;
  if (!record.reviewerProof) return true;
  return record.readOnlyCapability === "read-only" &&
    record.reviewerProof.messageKey === record.messageKey &&
    validateReviewerProofIntegrity(record.reviewerProof).ok;
}

/** Require the successful, current-message record for a specific delivery. */
export function isAppSelectionVerifiedForIntent(workspaceId: string, intent: AppSelectionIntent): boolean {
  return isAppSelectionVerified(readAppSelection(workspaceId, intent));
}
