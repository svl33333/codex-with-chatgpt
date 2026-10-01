import { createHash } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import {
  DeliveryMessageType,
  type C2cDeliveryAuthorization,
  type C2cDeliveryReceipt,
  markSending,
  prepareAuthorizedDelivery,
  reconcileDelivery,
  recordBrowserObservation,
} from "./authorization.js";
import { recordTeamAiAuthObservation, type TeamAiAuthObservationInput } from "./authorization.js";
import { operationTargetsMatch, type GitHubOperationObservation, type GitHubOperationTarget } from "./operation.js";
import type { IabAdapter } from "./iab-adapter.js";

export type DeliveryState = "prepared" | "sending" | "confirmed" | "ambiguous";
export type RemoteMessageState = "accepted" | "pending" | "reasoning" | "in_progress" | "missing" | "failed" | "unknown";
export type DeliveryResult = "CONFIRMED" | "WAITING" | "BLOCKED";

export interface MessageIntent {
  taskId: string;
  iteration: number;
  messageId: string;
  text: string;
  /** Optional exact transport binding. Legacy callers intentionally omit it. */
  workspaceId?: string;
  workstreamId?: string;
  binding?: import("./authorization.js").TransportBindingIdentity;
  authorization?: C2cDeliveryAuthorization;
  messageType?: DeliveryMessageType;
  payloadHash?: string;
  processId?: string;
  sessionId?: string;
  operationTarget?: GitHubOperationTarget;
  authObservation?: Omit<TeamAiAuthObservationInput, "authorization" | "binding">;
  reasoningEvidence?: import("./authorization.js").ReasoningEvidence;
  envelopeEvidence?: import("./authorization.js").EnvelopeEvidence;
}

export interface MessageAdapter {
  sendMessage(input: { idempotencyKey: string; text: string }): Promise<{ remoteId?: string }>;
  getMessageStatus(idempotencyKey: string): Promise<RemoteMessageState>;
  observeVisibleBubble?(input: { eventKey: string; payloadHash: string }): Promise<{
    visible: boolean;
    remoteId?: string;
    evidenceHash?: string;
    observedEventKey?: string;
    observedPayloadHash?: string;
  }>;
  classifyTimeout?(error: unknown): "definite_failure" | "ambiguous";
  getOperationObservation?(input: {
    eventKey: string;
    target: GitHubOperationTarget;
    payloadHash: string;
  }): Promise<Omit<GitHubOperationObservation, "target" | "payloadHash">>;
}

export type AuthorizedMessageAdapter = MessageAdapter & Partial<IabAdapter>;

export interface DeliveryCheckpoint {
  schemaVersion: 1;
  idempotencyKey: string;
  taskId: string;
  iteration: number;
  messageId: string;
  messageHash: string;
  state: DeliveryState;
  sendAttempts: number;
  remoteId?: string;
  eventKey?: string;
  receiptState?: import("./authorization.js").DeliveryReceiptState;
  updatedAt: string;
}

export interface DeliveryOutcome {
  result: DeliveryResult;
  state: DeliveryState;
  idempotencyKey: string;
  remoteState?: RemoteMessageState;
  reason?: string;
  checkpoint: DeliveryCheckpoint;
  receipt?: C2cDeliveryReceipt;
}

export function messageIdempotencyKey(intent: Pick<MessageIntent, "taskId" | "iteration" | "messageId">): string {
  const workspaceIntent = intent as Pick<MessageIntent, "taskId" | "iteration" | "messageId"> & {
    workspaceId?: string;
    workstreamId?: string;
  };
  const prefix = workspaceIntent.workspaceId
    ? `${workspaceIntent.workspaceId}\0${workspaceIntent.workstreamId ?? ""}\0`
    : "";
  return createHash("sha256")
    .update(`${prefix}${intent.taskId}\0${intent.iteration}\0${intent.messageId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Stable event identity for the authorized path; it is scoped to the workspace and workstream. */
export function transportEventKey(intent: Pick<MessageIntent, "taskId" | "iteration" | "messageId" | "workspaceId" | "workstreamId">): string {
  return messageIdempotencyKey(intent);
}

function messageFile(key: string): string {
  return path.join(getStateDir(), "messages", `${key}.json`);
}

function messageHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function loadCheckpoint(intent: MessageIntent, key: string): DeliveryCheckpoint {
  const existing = readJsonIfExists<DeliveryCheckpoint>(messageFile(key));
  if (
    existing?.schemaVersion === 1 &&
    existing.idempotencyKey === key &&
    existing.taskId === intent.taskId &&
    existing.iteration === intent.iteration &&
    existing.messageId === intent.messageId &&
    existing.messageHash === messageHash(intent.text)
  ) {
    return existing;
  }
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    taskId: intent.taskId,
    iteration: intent.iteration,
    messageId: intent.messageId,
    messageHash: messageHash(intent.text),
    ...(intent.binding?.eventKey ? { eventKey: intent.binding.eventKey } : {}),
    state: "prepared",
    sendAttempts: 0,
    updatedAt: new Date().toISOString(),
  };
}

function saveCheckpoint(checkpoint: DeliveryCheckpoint): void {
  writeSecureJson(messageFile(checkpoint.idempotencyKey), { ...checkpoint, updatedAt: new Date().toISOString() });
}

function waiting(checkpoint: DeliveryCheckpoint, reason: string, remoteState?: RemoteMessageState): DeliveryOutcome {
  checkpoint.state = "ambiguous";
  saveCheckpoint(checkpoint);
  return {
    result: "WAITING",
    state: checkpoint.state,
    idempotencyKey: checkpoint.idempotencyKey,
    remoteState,
    reason,
    checkpoint,
  };
}

async function reconcileRemote(checkpoint: DeliveryCheckpoint, adapter: MessageAdapter): Promise<DeliveryOutcome | null> {
  let remoteState: RemoteMessageState;
  try {
    remoteState = await adapter.getMessageStatus(checkpoint.idempotencyKey);
  } catch {
    return waiting(checkpoint, "remote message status unavailable");
  }
  if (remoteState === "accepted") {
    checkpoint.state = "confirmed";
    saveCheckpoint(checkpoint);
    return { result: "CONFIRMED", state: checkpoint.state, idempotencyKey: checkpoint.idempotencyKey, remoteState, checkpoint };
  }
  if (remoteState === "pending" || remoteState === "reasoning" || remoteState === "in_progress") {
    return waiting(checkpoint, "remote model task is still in progress", remoteState);
  }
  if (remoteState === "failed") {
    return { result: "BLOCKED", state: checkpoint.state, idempotencyKey: checkpoint.idempotencyKey, remoteState, reason: "remote model task failed", checkpoint };
  }
  if (remoteState === "unknown") return waiting(checkpoint, "remote delivery state is unknown", remoteState);
  return null;
}

function authorizedBinding(intent: MessageIntent): import("./authorization.js").TransportBindingIdentity {
  if (!intent.binding || !intent.authorization || !intent.messageType || !intent.payloadHash) {
    throw new Error("authorized delivery requires exact binding, message type, payload hash, and authority");
  }
  return intent.binding;
}

function authorizedOutcome(
  checkpoint: DeliveryCheckpoint,
  receipt: C2cDeliveryReceipt,
  key: string,
  remoteState?: RemoteMessageState,
  reason?: string
): DeliveryOutcome {
  checkpoint.receiptState = receipt.state;
  checkpoint.eventKey = receipt.eventKey;
  if (receipt.state === "RESPONSE_RECEIVED") {
    checkpoint.state = "confirmed";
    saveCheckpoint(checkpoint);
    return { result: "CONFIRMED", state: "confirmed", idempotencyKey: key, remoteState, checkpoint, receipt };
  }
  if (receipt.state === "DELIVERED_VISIBLE") {
    checkpoint.state = "confirmed";
    checkpoint.remoteId = receipt.remoteEvidence?.remoteId;
    saveCheckpoint(checkpoint);
    return {
      result: "WAITING",
      state: "confirmed",
      idempotencyKey: key,
      remoteState: remoteState ?? "accepted",
      reason: reason ?? "control message is visible; bound reviewer response is still pending",
      checkpoint,
      receipt,
    };
  }
  if (receipt.state === "WAITING_RESPONSE") {
    checkpoint.state = "ambiguous";
    saveCheckpoint(checkpoint);
    return {
      result: "WAITING",
      state: checkpoint.state,
      idempotencyKey: key,
      remoteState: remoteState ?? "accepted",
      reason: reason ?? "remote acceptance is recorded; exact visible-bubble evidence is still pending",
      checkpoint,
      receipt,
    };
  }
  checkpoint.state = receipt.state === "FAILED_DEFINITE" ? "prepared" : "ambiguous";
  saveCheckpoint(checkpoint);
  return {
    result: receipt.state === "BLOCKED" ? "BLOCKED" : "WAITING",
    state: checkpoint.state,
    idempotencyKey: key,
    remoteState,
    reason: reason ?? receipt.nextAction ?? "authorized delivery requires reconciliation",
    checkpoint,
    receipt,
  };
}

function remoteEvidenceFor(state: RemoteMessageState): import("./authorization.js").RemoteEvidenceOutcome {
  if (state === "accepted") return "accepted";
  if (state === "pending" || state === "reasoning" || state === "in_progress") return "pending";
  if (state === "missing") return "definite_not_accepted";
  if (state === "failed") return "failed";
  return "ambiguous";
}

async function reconcileAuthorized(
  intent: MessageIntent,
  adapter: AuthorizedMessageAdapter,
  checkpoint: DeliveryCheckpoint,
  receipt: C2cDeliveryReceipt,
  key: string
): Promise<DeliveryOutcome | null> {
  if (!adapter.getMessageStatus) return authorizedOutcome(checkpoint, receipt, key, undefined, "remote evidence adapter unavailable");
  let state: RemoteMessageState;
  try {
    state = await adapter.getMessageStatus(key);
  } catch {
    return authorizedOutcome(checkpoint, receipt, key, "unknown", "remote evidence is unavailable; blind retry is prohibited");
  }
  const operationObservation = adapter.getOperationObservation && receipt.operationTarget
    ? await adapter.getOperationObservation({ eventKey: receipt.eventKey, target: receipt.operationTarget, payloadHash: receipt.payloadHash })
    : undefined;
  const reconciled = reconcileDelivery({
    authorization: intent.authorization!,
    binding: authorizedBinding(intent),
    outcome: remoteEvidenceFor(state),
    reason: `remote status: ${state}`,
    ...(operationObservation ? { operationObservation } : {}),
  });
  return authorizedOutcome(checkpoint, reconciled, key, state);
}

async function deliverAuthorizedMessage(
  intent: MessageIntent,
  adapter: AuthorizedMessageAdapter,
  key: string,
  checkpoint: DeliveryCheckpoint
): Promise<DeliveryOutcome> {
  const binding = authorizedBinding(intent);
  const authorization = intent.authorization!;
  const messageType = intent.messageType!;
  const payloadHash = intent.payloadHash!;
  if (intent.operationTarget && (!authorization.operationTarget || !operationTargetsMatch(intent.operationTarget, authorization.operationTarget))) {
    throw new Error("authorized delivery operation target does not match its persisted authority");
  }
  let receipt = prepareAuthorizedDelivery({
    authorization,
    binding,
    messageType,
    eventKey: binding.eventKey,
    payloadHash,
    processId: intent.processId,
    sessionId: intent.sessionId,
    reasoningEvidence: intent.reasoningEvidence,
    envelopeEvidence: intent.envelopeEvidence,
  });

  if (intent.authObservation) {
    receipt = recordTeamAiAuthObservation({
      authorization,
      binding,
      ...intent.authObservation,
    });
  }

  if (receipt.state === "RESPONSE_RECEIVED" || receipt.state === "DELIVERED_VISIBLE") {
    return authorizedOutcome(checkpoint, receipt, key);
  }
  if (receipt.state === "WAITING_RESPONSE") {
    if (adapter.observeVisibleBubble) {
      const observation = await adapter.observeVisibleBubble({ eventKey: binding.eventKey, payloadHash });
      if (observation.visible) {
        receipt = recordBrowserObservation({
          authorization,
          binding,
          outcome: "visible",
          remoteId: observation.remoteId,
          evidenceHash: observation.evidenceHash,
          observedEventKey: observation.observedEventKey,
          observedPayloadHash: observation.observedPayloadHash,
          reason: "exact visible-bubble evidence observed after remote acceptance",
        });
      }
    }
    return authorizedOutcome(checkpoint, receipt, key);
  }
  if (receipt.state === "AMBIGUOUS" || receipt.state === "RECONCILING") {
    const reconciled = await reconcileAuthorized(intent, adapter, checkpoint, receipt, key);
    if (reconciled) {
      receipt = reconciled.receipt!;
      if (receipt.state !== "FAILED_DEFINITE") return reconciled;
    }
  }
  try {
    receipt = markSending(authorization, binding, intent.processId, intent.sessionId);
  } catch (error) {
    return authorizedOutcome(checkpoint, receipt, key, undefined, error instanceof Error ? error.message : "delivery remains guarded");
  }
  checkpoint.state = "sending";
  checkpoint.sendAttempts = receipt.sendAttempts;
  checkpoint.receiptState = receipt.state;
  saveCheckpoint(checkpoint);
  try {
    const sent = await adapter.sendMessage({ idempotencyKey: key, text: intent.text });
    const observation = adapter.observeVisibleBubble
      ? await adapter.observeVisibleBubble({ eventKey: binding.eventKey, payloadHash })
      : { visible: false };
    receipt = recordBrowserObservation({
      authorization,
      binding,
      outcome: observation.visible ? "visible" : "ambiguous",
      remoteId: observation.remoteId ?? sent.remoteId,
      evidenceHash: observation.evidenceHash,
      observedEventKey: observation.observedEventKey,
      observedPayloadHash: observation.observedPayloadHash,
      reason: observation.visible ? undefined : "submit completed without visible remote-bubble evidence",
    });
    return authorizedOutcome(checkpoint, receipt, key, observation.visible ? "accepted" : "unknown");
  } catch (error) {
    const classification = adapter.classifyTimeout?.(error) ?? "ambiguous";
    receipt = recordBrowserObservation({
      authorization,
      binding,
      outcome: classification === "definite_failure" ? "definite_failure" : "ambiguous",
      reason: classification === "definite_failure" ? "adapter classified a pre-accept failure" : "transport result is ambiguous",
    });
    const reconciled = await reconcileAuthorized(intent, adapter, checkpoint, receipt, key);
    return reconciled ?? authorizedOutcome(checkpoint, receipt, key, "unknown");
  }
}

/** Deliver one control message at most once; ambiguous transport never triggers a blind resend. */
export async function deliverMessage(intent: MessageIntent, adapter: MessageAdapter): Promise<DeliveryOutcome> {
  const key = intent.authorization && intent.binding?.eventKey ? intent.binding.eventKey : messageIdempotencyKey(intent);
  const checkpoint = loadCheckpoint(intent, key);
  if (intent.authorization || intent.binding || intent.messageType || intent.payloadHash) {
    return deliverAuthorizedMessage(intent, adapter, key, checkpoint);
  }
  if (checkpoint.state === "confirmed") {
    return { result: "CONFIRMED", state: checkpoint.state, idempotencyKey: key, checkpoint };
  }
  if (checkpoint.state === "sending" || checkpoint.state === "ambiguous") {
    const reconciled = await reconcileRemote(checkpoint, adapter);
    if (reconciled) return reconciled;
    if (checkpoint.sendAttempts > 0) return waiting(checkpoint, "message was not confirmed; resend requires explicit reconciliation");
  }

  checkpoint.state = "prepared";
  saveCheckpoint(checkpoint);
  checkpoint.state = "sending";
  checkpoint.sendAttempts += 1;
  saveCheckpoint(checkpoint);
  try {
    const sent = await adapter.sendMessage({ idempotencyKey: key, text: intent.text });
    checkpoint.state = "confirmed";
    checkpoint.remoteId = sent.remoteId;
    saveCheckpoint(checkpoint);
    return { result: "CONFIRMED", state: checkpoint.state, idempotencyKey: key, remoteState: "accepted", checkpoint };
  } catch {
    const reconciled = await reconcileRemote(checkpoint, adapter);
    if (reconciled) return reconciled;
    return waiting(checkpoint, "transport result ambiguous; delivery must be reconciled", "unknown");
  }
}
