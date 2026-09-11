import { createHash } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type DeliveryState = "prepared" | "sending" | "confirmed" | "ambiguous";
export type RemoteMessageState = "accepted" | "pending" | "reasoning" | "in_progress" | "missing" | "failed" | "unknown";
export type DeliveryResult = "CONFIRMED" | "WAITING" | "BLOCKED";

export interface MessageIntent {
  taskId: string;
  iteration: number;
  messageId: string;
  text: string;
}

export interface MessageAdapter {
  sendMessage(input: { idempotencyKey: string; text: string }): Promise<{ remoteId?: string }>;
  getMessageStatus(idempotencyKey: string): Promise<RemoteMessageState>;
}

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
  updatedAt: string;
}

export interface DeliveryOutcome {
  result: DeliveryResult;
  state: DeliveryState;
  idempotencyKey: string;
  remoteState?: RemoteMessageState;
  reason?: string;
  checkpoint: DeliveryCheckpoint;
}

export function messageIdempotencyKey(intent: Pick<MessageIntent, "taskId" | "iteration" | "messageId">): string {
  return createHash("sha256")
    .update(`${intent.taskId}\0${intent.iteration}\0${intent.messageId}`)
    .digest("hex")
    .slice(0, 32);
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

/** Deliver one control message at most once; ambiguous transport never triggers a blind resend. */
export async function deliverMessage(intent: MessageIntent, adapter: MessageAdapter): Promise<DeliveryOutcome> {
  const key = messageIdempotencyKey(intent);
  const checkpoint = loadCheckpoint(intent, key);
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
