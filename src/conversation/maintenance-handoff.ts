import { createHash } from "node:crypto";
import { z } from "zod";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";

export const MAINTENANCE_HANDOFF_POLICY = "maintenance-handoff-v1" as const;
export const MAINTENANCE_HANDOFF_PROFILE = "maintenance-v1.2/end-of-turn-browser-v1" as const;
const reference = z.string().min(1).max(2048).refine((value) => !/[\r\n\0]/.test(value), "reference contains control characters");
export const maintenanceResultSchema = z.object({ outputId: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const maintenanceTargetSchema = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), workspaceRoot: reference, repository: reference, worktreeRoot: reference,
  branch: reference, head: z.string().regex(/^[a-f0-9]{40}$/), workstream: reference,
  goalId: reference, planRef: reference, operationId: reference, sessionId: reference, turnId: reference,
  projectId: reference, chatId: reference, replyRef: reference, mode: z.literal("chat"), role: z.literal("builder"),
  result: maintenanceResultSchema,
}).strict();
export type MaintenanceTarget = z.infer<typeof maintenanceTargetSchema>;
export const maintenanceApprovalSchema = z.object({
  source: z.literal("provider"), authorKind: z.literal("human"), messageRef: reference,
  goalId: reference, planRef: reference, projectId: reference, chatId: reference,
  action: z.literal("maintenance_handoff"),
}).strict();
export type MaintenanceApproval = z.infer<typeof maintenanceApprovalSchema>;
export const maintenanceGrantSchema = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(MAINTENANCE_HANDOFF_POLICY),
  action: z.literal("maintenance_handoff"), grantId: reference, generation: z.number().int().positive(),
  target: maintenanceTargetSchema, targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approval: maintenanceApprovalSchema, notBefore: z.string().datetime(), expiresAt: z.string().datetime(),
  status: z.enum(["APPROVED_ACTIVE", "REVOKED", "EXPIRED"]), maxUses: z.literal(1), useCount: z.number().int().min(0).max(1),
}).strict();
export type MaintenanceGrant = z.infer<typeof maintenanceGrantSchema>;
export const maintenanceProofSchema = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(MAINTENANCE_HANDOFF_POLICY),
  action: z.literal("maintenance_handoff"), decision: z.literal("ALLOW"),
  grantId: reference, reservationId: reference, eventKey: reference,
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MaintenanceProof = z.infer<typeof maintenanceProofSchema>;
export const maintenanceReceiptSchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal(MAINTENANCE_HANDOFF_PROFILE),
  generation: z.number().int().positive(), eventKey: reference, target: maintenanceTargetSchema,
  grantId: reference, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["PREPARED", "SENDING", "DELIVERED_VISIBLE", "AMBIGUOUS", "RECONCILING", "BLOCKED"]),
  sendAttempts: z.number().int().min(0).max(1), remoteId: reference.optional(),
  reason: z.string().max(512).optional(), errorPhase: z.enum(["submit", "observe"]).optional(),
}).strict();
export type MaintenanceReceipt = z.infer<typeof maintenanceReceiptSchema>;
export interface MaintenanceProviderTurn {
  sessionId: string; turnId: string; operationId: string; inputRef: string;
  status: "active" | "completed" | "failed" | "interrupted" | "unknown" | "systemError";
  fullFinal: string | null; finalRef: string | null; contentOmitted: boolean; sessionRevision: string;
}

/** Trusted in-process host port; no CLI or serialized input can install one. */
export interface MaintenanceHost {
  readContext(target: MaintenanceTarget): Promise<{
    binding: MaintenanceTarget; approval: MaintenanceApproval; sendAuthorized: boolean;
    notBefore: string; expiresAt: string;
  }>;
  readTurn(sessionId: string, turnId: string): Promise<MaintenanceProviderTurn>;
  readInstruction?(reference: string): Promise<{
    source: "provider"; authorKind: "assistant"; projectId: string; chatId: string; chatTurnId: string;
    basedOnFinalRef: string; instructionRef: string; executionAuthorityRef: string; text: string;
  }>;
  browser?: {
    sendMessage(input: { idempotencyKey: string; text: string }): Promise<{ remoteId?: string }>;
    observeVisibleBubble(input: { eventKey: string; payloadHash: string }): Promise<{ visible: boolean; remoteId?: string; observedEventKey?: string; observedPayloadHash?: string }>;
  };
  // A normal turn/start or queue/steer API cannot satisfy this contract.
  forward?: {
    contract: "atomic-compare-and-start-v1";
    compareAndStart(input: { sessionId: string; previousTurnId: string; expectedRevision: string; operationId: string; instruction: string; instructionRef: string; executionAuthorityRef: string; goalId: string; planRef: string }): Promise<
      { outcome: "started"; turnId: string } | { outcome: "conflict" | "unknown" }
    >;
  };
}

export class MaintenanceCapabilityUnavailable extends Error {
  constructor(capability: string) { super(`MAINTENANCE_CAPABILITY_UNAVAILABLE: ${capability}`); }
}
export interface MaintenanceAuthority {
  readonly target: MaintenanceTarget; readonly approval: MaintenanceApproval;
  readonly notBefore: string; readonly expiresAt: string;
}
const authorities = new WeakSet<object>();
function freezeRecord<T extends object>(value: T): T {
  for (const item of Object.values(value)) if (item && typeof item === "object") freezeRecord(item);
  return Object.freeze(value);
}
export function maintenanceTargetDigest(target: MaintenanceTarget): string {
  return createHash("sha256").update(JSON.stringify(maintenanceTargetSchema.parse(target))).digest("hex");
}
export function maintenanceEventKey(target: MaintenanceTarget): string {
  return `maintenance:${createHash("sha256").update(JSON.stringify([target.workspaceId, target.goalId, target.operationId])).digest("hex")}`;
}
export function assertMaintenanceAuthority(value: MaintenanceAuthority): void {
  if (!value || !authorities.has(value)) throw new Error("maintenance requires a live trusted host authority, not serialized proof");
  if (Date.parse(value.notBefore) > Date.now() || Date.parse(value.expiresAt) <= Date.now()) throw new Error("maintenance authority is expired or not yet active");
}
export async function resolveMaintenanceAuthority(host: MaintenanceHost | undefined, input: MaintenanceTarget): Promise<MaintenanceAuthority> {
  if (!host || typeof host.readContext !== "function") throw new MaintenanceCapabilityUnavailable("formal host binding and human-origin approval");
  const target = maintenanceTargetSchema.parse(input);
  const context = await host.readContext(target);
  const binding = maintenanceTargetSchema.parse(context.binding);
  const approval = maintenanceApprovalSchema.parse(context.approval);
  if (maintenanceTargetDigest(binding) !== maintenanceTargetDigest(target)) throw new Error("maintenance formal binding mismatch");
  if (!context.sendAuthorized || approval.goalId !== target.goalId || approval.planRef !== target.planRef || approval.projectId !== target.projectId || approval.chatId !== target.chatId) throw new Error("maintenance human-origin send authorization mismatch");
  const notBefore = z.string().datetime().parse(context.notBefore);
  const expiresAt = z.string().datetime().parse(context.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(notBefore)) throw new Error("invalid maintenance authority interval");
  const authority = freezeRecord({ target, approval, notBefore, expiresAt });
  authorities.add(authority);
  assertMaintenanceAuthority(authority);
  return authority;
}
export function renderMaintenanceResult(target: MaintenanceTarget): string {
  const parsed = maintenanceTargetSchema.parse(target);
  const text = `[CODEX-GENERATED TASK RESULT]\nprovenance: codex\npurpose: task_result\nworkflow_authority: none\nrecipient: chatgpt\noperation_id: ${parsed.operationId}\nresult_ref: execution-output:${parsed.workspaceId}/${parsed.result.outputId} sha256:${parsed.result.sha256}\nhandoff: review_required\n\nRESULT\nSaved work result; this Codex turn's terminal is not yet confirmed.\n\nEVIDENCE\n${parsed.planRef}\n\nBLOCKERS\nProvider terminal/full final and independent evaluation pending.\n\nNEXT_ACTION\nRead the exact provider terminal and full final before judging or issuing the next instruction.\n`;
  const filtered = sanitizeExecutionOutput(text);
  if (!filtered.allowed || filtered.text !== text || filtered.truncated || Buffer.byteLength(text, "utf8") > 1024) throw new Error("maintenance notice must contain only short safe references (1 KiB maximum)");
  return text;
}

export function parseMaintenanceInstruction(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  if (lines.shift() !== "[CHATGPT-GENERATED TASK INSTRUCTION]") throw new Error("maintenance instruction header missing");
  const fields: Record<string, string> = {};
  while (lines.length && lines[0] !== "") {
    const line = lines.shift()!;
    const match = /^([a-z_]+): (.+)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw new Error("invalid or duplicate maintenance header field");
    fields[match[1]] = reference.parse(match[2]);
  }
  const required = ["goal_ref", "plan_ref", "workstream", "operation_id", "codex_session", "reply_ref"];
  if (required.some((name) => !fields[name]) || fields.provenance !== "chatgpt" || fields.purpose !== "task_instruction" || fields.workflow_authority !== "none" || fields.recipient !== "codex" || fields.handoff_profile !== MAINTENANCE_HANDOFF_PROFILE || lines[1] !== "TASK") throw new Error("maintenance instruction contract mismatch");
  if (Object.keys(fields).some((name) => ![...required, "provenance", "purpose", "workflow_authority", "recipient", "handoff_profile"].includes(name))) throw new Error("unsupported maintenance header field");
  return fields;
}
