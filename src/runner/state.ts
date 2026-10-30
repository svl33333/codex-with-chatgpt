import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getStateDir, writeAtomicSecureJson } from "../config/paths.js";
import { parseStrictJson } from "../config/strict-json.js";
import { readBoundedText, type RunnerOutcome } from "./canonical.js";
import { assertMaintenanceGoalIdentity, assertMaintenanceGoalTarget, type GoalObservation, type MaintenanceGoal } from "./goal.js";
import { withLease } from "../config/lease.js";
import { MAINTENANCE_HANDOFF_PROFILE, maintenanceEventKey, type MaintenanceTarget } from "../conversation/maintenance-handoff.js";
import fs from "node:fs";

const actionReferenceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalObservationSchema = z.object({
  pin: z.string().regex(/^[a-f0-9]{40}$/), step: z.number().int().min(1).max(7),
  status: z.enum(["RUNNING", "READY", "C2C_WAITING", "HUMAN_WAITING", "PUSH_WAITING", "BLOCKED", "DONE", "ABANDONED"]),
  checkpoint: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).nullable(),
  cycle: z.number().int().nonnegative().nullable(),
  reviewStage: z.enum(["pre_implementation", "post_implementation", "final"]).nullable(),
  verdict: z.enum(["PASS", "FIX_REQUIRED", "HUMAN_DECISION_REQUIRED", "REQUIRED_CAPABILITY_UNAVAILABLE"]).nullable(),
  lastAction: z.enum(["REVIEW", "REMEDIATE", "VALIDATE", "HUMAN_GATE", "BLOCK", "PROCEED"]).nullable(),
}).strict();
const ownerEvidenceSchema = z.discriminatedUnion("owner", [
  z.object({ owner: z.literal("a0"), eventKey: z.string().regex(/^[a-f0-9]{32}$/), receiptState: z.enum(["PREPARED", "SENDING", "DELIVERED_VISIBLE", "WAITING_RESPONSE", "RESPONSE_RECEIVED", "RECONCILING", "FAILED_DEFINITE", "AMBIGUOUS", "BLOCKED"]).nullable(), sendAttempts: z.number().int().nonnegative() }).strict(),
  z.object({ owner: z.literal("a1"), reservationId: z.union([z.string().uuid(), actionReferenceSchema]), reservationState: z.enum(["RESERVED", "CONSUMED", "RELEASED"]) }).strict(),
]);
const executionObservationSchema = z.enum(["NOT_ENTERED", "PREPARED", "COMPLETED", "INCOMPLETE", "UNKNOWN"]);
const pendingSchema = z.object({ action: actionReferenceSchema, kind: z.enum(["transport", "workspace_read", "operation_reconcile"]), iteration: z.number().int().positive(), before: canonicalObservationSchema.optional() }).strict();
const auditObservationSchema = z.object({ before: canonicalObservationSchema.nullable(), after: canonicalObservationSchema.nullable(), action: actionReferenceSchema.nullable(), evidence: z.array(ownerEvidenceSchema).max(2), execution: executionObservationSchema }).strict();
const checkpointSchema = z.object({ schemaVersion: z.literal(1), goalId: z.string(), revision: z.number().int().positive(), digest: actionReferenceSchema, iteration: z.number().int().nonnegative(), pending: pendingSchema.nullable(), completed: z.array(actionReferenceSchema).max(256), audit: z.array(z.object({ iteration: z.number(), outcome: z.enum(["CONTINUED", "NO_ACTION_AVAILABLE", "HUMAN_GATE_REQUIRED", "CAPABILITY_BLOCKED", "RECOVERABLE_FAILURE", "TERMINAL"]), kind: z.enum(["none", "transport", "workspace_read", "operation_reconcile", "validation", "source_remediation"]), observation: auditObservationSchema.optional() }).strict()).max(32) }).strict();
export type RunnerCheckpoint = z.infer<typeof checkpointSchema>;
export type RunnerAuditKind = RunnerCheckpoint["audit"][number]["kind"];
export type RunnerAuditObservation = z.infer<typeof auditObservationSchema>;
export type RunnerOwnerEvidence = z.infer<typeof ownerEvidenceSchema>;

export function observeRunnerCanonical(pin: string, state: Record<string, any>): RunnerAuditObservation["before"] {
  const logicalCheckpoint = canonicalObservationSchema.shape.checkpoint.safeParse(state.c2c?.checkpoint ?? null);
  const observation = canonicalObservationSchema.safeParse({ pin, step: state.workflow?.step, status: state.workflow?.status, checkpoint: logicalCheckpoint.success ? logicalCheckpoint.data : null, cycle: state.c2c?.cycle ?? null, reviewStage: state.c2c?.review_stage ?? null, verdict: state.c2c?.verdict ?? null, lastAction: state.c2c?.last_action ?? null });
  return observation.success ? observation.data : null;
}

export function runnerFiles(root: string, workstream: string): { checkpoint: string; lease: string } {
  const key = createHash("sha256").update(`${root}\0${workstream}`).digest("hex");
  const base = path.join(getStateDir(), "runner", key);
  return { checkpoint: `${base}.json`, lease: `${base}.lock` };
}

export function loadRunnerCheckpoint(file: string, observation: GoalObservation): RunnerCheckpoint {
  const { goal, digest } = observation;
  if (!fs.existsSync(file)) return { schemaVersion: 1, goalId: goal.id, revision: goal.revision, digest, iteration: 0, pending: null, completed: [], audit: [] };
  const prior = checkpointSchema.parse(parseStrictJson(readBoundedText(file, 128 * 1024)));
  if (prior.goalId !== goal.id || prior.revision > goal.revision || prior.revision === goal.revision && prior.digest !== digest) throw new Error("goal revision changed or rolled back");
  return { ...prior, revision: goal.revision, digest };
}

export function saveRunnerCheckpoint(file: string, checkpoint: RunnerCheckpoint, outcome?: RunnerOutcome, kind: RunnerAuditKind = "none", observation?: RunnerAuditObservation): void {
  if (outcome) checkpoint.audit = [...checkpoint.audit, { iteration: checkpoint.iteration, outcome, kind, ...(observation ? { observation } : {}) }].slice(-32);
  writeAtomicSecureJson(file, checkpointSchema.parse(checkpoint));
}

const maintenanceCheckpointSchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal(MAINTENANCE_HANDOFF_PROFILE), goalId: z.string(),
  revision: z.number().int().positive(), goalDigest: actionReferenceSchema, generation: z.number().int().nonnegative(),
  completed: z.array(z.string()).max(256), pending: z.object({
    operationId: z.string(), eventKey: z.string(), sessionId: z.string(), turnId: z.string(),
    next: z.object({ operationId: z.string(), state: z.enum(["RESERVED", "STARTED", "CONFLICT", "UNKNOWN"]), turnId: z.string().optional() }).strict().optional(),
  }).strict().nullable(),
}).strict();
export type MaintenanceCheckpoint = z.infer<typeof maintenanceCheckpointSchema>;

export function withMaintenanceGoalLease<T>(goal: MaintenanceGoal, target: MaintenanceTarget, action: (checkpoint: MaintenanceCheckpoint, save: () => void) => T): T {
  const parsedGoal = assertMaintenanceGoalTarget(goal, target);
  return withMaintenanceCheckpointLease(parsedGoal, action);
}

function withMaintenanceCheckpointLease<T>(parsedGoal: MaintenanceGoal, action: (checkpoint: MaintenanceCheckpoint, save: () => void) => T): T {
  const files = runnerFiles(parsedGoal.selection.workspaceRoot, parsedGoal.selection.workstream);
  return withLease(files.lease, () => {
    const goalDigest = createHash("sha256").update(JSON.stringify(parsedGoal)).digest("hex");
    const checkpoint: MaintenanceCheckpoint = fs.existsSync(files.checkpoint)
      ? maintenanceCheckpointSchema.parse(parseStrictJson(readBoundedText(files.checkpoint, 128 * 1024)))
      : { schemaVersion: 1, profile: MAINTENANCE_HANDOFF_PROFILE, goalId: parsedGoal.id, revision: parsedGoal.revision, goalDigest, generation: 0, completed: [], pending: null };
    if (checkpoint.goalId !== parsedGoal.id || checkpoint.revision !== parsedGoal.revision || checkpoint.goalDigest !== goalDigest) throw new Error("maintenance Goal changed; reconcile existing pending");
    return action(checkpoint, () => { checkpoint.generation += 1; writeAtomicSecureJson(files.checkpoint, maintenanceCheckpointSchema.parse(checkpoint)); });
  });
}

export function recordMaintenanceForwardResult(goal: MaintenanceGoal, target: MaintenanceTarget, operationId: string, result: { outcome: "started"; turnId: string } | { outcome: "conflict" | "unknown" }): void {
  // Expiry stops new work, but cannot erase the result of an already reserved call.
  const parsedGoal = assertMaintenanceGoalIdentity(goal, target);
  withMaintenanceCheckpointLease(parsedGoal, (checkpoint, save) => {
    const pending = checkpoint.pending;
    const next = pending?.next;
    if (!pending || pending.operationId !== target.operationId || pending.sessionId !== target.sessionId || pending.turnId !== target.turnId || !next || next.operationId !== operationId || next.state !== "RESERVED") throw new Error("maintenance forward pending changed; reconcile only");
    const validStart = result.outcome === "started" && typeof result.turnId === "string" && result.turnId.length > 0 && result.turnId !== target.turnId;
    next.state = validStart ? "STARTED" : result.outcome === "conflict" ? "CONFLICT" : "UNKNOWN";
    if (result.outcome === "started" && validStart) next.turnId = result.turnId;
    save();
  });
}

export function prepareMaintenancePending(checkpoint: MaintenanceCheckpoint, target: MaintenanceTarget): void {
  const previous = checkpoint.pending;
  if (checkpoint.completed.includes(target.operationId)) throw new Error("maintenance operation already completed; reconcile only");
  if (previous && previous.operationId !== target.operationId) {
    if (previous.next?.state !== "STARTED" || previous.next.operationId !== target.operationId || previous.next.turnId !== target.turnId || previous.sessionId !== target.sessionId) throw new Error("maintenance Goal already has pending work");
    checkpoint.completed = [...checkpoint.completed, previous.operationId].slice(-256);
  } else if (previous && (previous.eventKey !== maintenanceEventKey(target) || previous.sessionId !== target.sessionId || previous.turnId !== target.turnId)) {
    throw new Error("maintenance pending identity changed");
  }
  if (!previous || previous.operationId !== target.operationId) checkpoint.pending = { operationId: target.operationId, eventKey: maintenanceEventKey(target), sessionId: target.sessionId, turnId: target.turnId };
}
