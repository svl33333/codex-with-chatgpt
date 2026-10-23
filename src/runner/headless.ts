import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { acquireLease, type AcquiredLease } from "../config/lease.js";
import { bindingMatches, deriveCanonical28Binding, readDeliveryAuthorization, readDeliveryReceipt, type TransportBindingIdentity } from "../conversation/authorization.js";
import { createDurableTransportTransaction } from "../conversation/transaction.js";
import { buildC2cEnvelope } from "../conversation/envelope.js";
import { evaluateDelegationProof, loadDelegationGrant, loadDelegationReservation, normalizeDelegationTarget, recoverDelegatedTransport, type DelegationRequest } from "../conversation/delegation.js";
import type { AuthorizedMessageAdapter } from "../conversation/delivery.js";
import { canonicalMessageType, classifyCanonical, parseCanonicalYaml, readBoundedText, readCanonicalSelection, type RunnerOutcome, type CanonicalSelection } from "./canonical.js";
import { readDurableGoal } from "./goal.js";
import { loadRunnerCheckpoint, observeRunnerCanonical, runnerFiles, saveRunnerCheckpoint, type RunnerCheckpoint, type RunnerAuditKind, type RunnerAuditObservation } from "./state.js";

export type RunnerAction = { kind: "transport" | "workspace_read" | "operation_reconcile"; delegation: DelegationRequest } | { kind: "validation" | "source_remediation" | "none" };
export interface RunnerInvocation {
  workspaceRoot: string;
  workstream: string;
  workflowCheckout: string;
  goalPath: string;
  action?: RunnerAction;
  adapter?: AuthorizedMessageAdapter | (() => Promise<AuthorizedMessageAdapter>);
  now?: number;
  afterPrepared?: () => void;
  afterOwnerAction?: () => void;
}
export interface RunnerResult { outcome: RunnerOutcome; reason: string; iteration: number; executed: boolean }

export function parseRunnerAction(value: unknown): RunnerAction {
  return z.union([
    z.object({ kind: z.enum(["transport", "workspace_read", "operation_reconcile"]), delegation: z.record(z.unknown()) }).strict(),
    z.object({ kind: z.enum(["validation", "source_remediation", "none"]) }).strict(),
  ]).parse(value) as RunnerAction;
}

function activeRecoveryGrant(request: DelegationRequest, authorization: NonNullable<ReturnType<typeof readDeliveryAuthorization>>, binding: TransportBindingIdentity) {
  const reference = authorization.delegation;
  if (!reference || request.grantId !== reference.grantId) throw new Error("live recovery grant missing");
  const grant = loadDelegationGrant(reference.grantId);
  const reservation = loadDelegationReservation(reference.reservationId);
  if (!grant || !reservation || grant.status !== "APPROVED_ACTIVE" || grant.revokedAt || grant.supersededBy || Date.now() < Date.parse(grant.notBefore) || Date.now() >= Date.parse(grant.expiresAt) || grant.generation !== reservation.grantGeneration || grant.useCount > grant.maxUses || !["CONSUMED", "RESERVED"].includes(reservation.state) || reservation.state === "CONSUMED" && reservation.commitReference !== authorization.authorityId || authorization.revokedAt || authorization.expiresAt && Date.parse(authorization.expiresAt) <= Date.now() || !bindingMatches(authorization.binding, binding)) throw new Error("live recovery grant unavailable");
  const recovered = recoverDelegatedTransport({ ...request, activeBinding: binding }, reference);
  if (!recovered?.permit) throw new Error("live recovery target mismatch");
  return recovered;
}

async function transportAction(input: RunnerInvocation, selection: CanonicalSelection, binding: TransportBindingIdentity, request: DelegationRequest, recovering: boolean): Promise<{ complete: boolean; executed: boolean; outcome: RunnerOutcome }> {
  const messageType = canonicalMessageType(selection);
  const envelope = buildC2cEnvelope({ type: messageType, taskId: binding.taskId!, iteration: selection.state.c2c.cycle, checkpoint: binding.checkpoint!, stage: binding.stage!, workspaceId: binding.workspaceId, workstreamId: binding.workstreamId, eventKey: binding.eventKey!, intent: "Use C2C. Read the selected workstream plan, current source/diff, approval and recorded tests through the exact workspace; review the current owning stage." });
  const target = normalizeDelegationTarget("c2c_transport", request.target);
  if (request.action !== "c2c_transport" || JSON.stringify(target) !== JSON.stringify(normalizeDelegationTarget("c2c_transport", { kind: "c2c_transport", checkpoint: binding.checkpoint, eventKey: binding.eventKey, messageType, payloadHash: envelope.payloadHash }))) throw new Error("transport target mismatch");
  const transaction = createDurableTransportTransaction();
  const existing = readDeliveryAuthorization(binding.eventKey!);
  if (existing && (existing.payloadHash !== envelope.payloadHash || existing.messageType !== messageType)) throw new Error("conflicting persisted payload");
  const prepare = () => transaction.beginAndPrepare({ workflowStep: selection.state.workflow.step, stage: binding.stage!, issuerId: "canonical-owner", messageType, binding, sourceCheckpoint: binding.checkpoint!, sourceStage: binding.stage!, eventKey: binding.eventKey!, payloadHash: envelope.payloadHash, delegationRequest: { ...request, activeBinding: binding } });
  const send = async (authorization: NonNullable<ReturnType<typeof readDeliveryAuthorization>>, permit: NonNullable<ReturnType<typeof recoverDelegatedTransport>>["permit"], adapter: AuthorizedMessageAdapter) => {
    const before = readDeliveryReceipt(binding.eventKey!)?.sendAttempts ?? 0;
    const delivered = await transaction.deliver({ taskId: binding.taskId!, iteration: selection.state.c2c.cycle, messageId: binding.eventKey!, text: envelope.text, workspaceId: binding.workspaceId, workstreamId: binding.workstreamId, binding, authorization, messageType, payloadHash: envelope.payloadHash, delegationPermit: permit }, adapter);
    return { complete: delivered.receipt?.state === "DELIVERED_VISIBLE" || delivered.receipt?.state === "RESPONSE_RECEIVED", executed: (delivered.receipt?.sendAttempts ?? 0) > before, outcome: delivered.result === "BLOCKED" ? "CAPABILITY_BLOCKED" as const : "CONTINUED" as const };
  };
  if (recovering || selection.state.workflow.status === "C2C_WAITING" || existing) {
    if (!existing) return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
    let recovered: ReturnType<typeof activeRecoveryGrant>;
    try { recovered = activeRecoveryGrant(request, existing, binding); }
    catch { return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" }; }
    let receipt = readDeliveryReceipt(binding.eventKey!);
    if (!receipt || recovered.reservation?.state === "RESERVED") {
      if (selection.state.workflow.status !== "RUNNING") return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
      // Only the original transaction can settle the persisted A0 commit.
      receipt = prepare().receipt ?? null;
    }
    if (!receipt) return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
    if (["RESPONSE_RECEIVED", "DELIVERED_VISIBLE"].includes(receipt.state)) return { complete: true, executed: false, outcome: "CONTINUED" };
    const adapter = typeof input.adapter === "function" ? await input.adapter() : input.adapter;
    if (!adapter) return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
    if (receipt.state === "FAILED_DEFINITE" && selection.state.workflow.status === "RUNNING") return send(existing, recovered.permit, adapter);
    const remote = await adapter.getMessageStatus(binding.eventKey!);
    const outcome = remote === "accepted" ? "accepted" : ["pending", "reasoning", "in_progress"].includes(remote) ? "pending" : remote === "missing" ? "definite_not_accepted" : remote === "failed" ? "failed" : "ambiguous";
    transaction.reconcile({ authorization: existing, binding, outcome });
    if (["accepted", "pending"].includes(outcome) && adapter.observeVisibleBubble) {
      const visible = await adapter.observeVisibleBubble({ eventKey: binding.eventKey!, payloadHash: envelope.payloadHash });
      if (visible.visible) {
        transaction.observeVisible({ authorization: existing, binding, outcome: "visible", ...visible });
        return { complete: true, executed: false, outcome: "CONTINUED" };
      }
    }
    // A reconciliation invocation never resends, even when absence is proven.
    return { complete: false, executed: false, outcome: outcome === "failed" ? "CAPABILITY_BLOCKED" : "CONTINUED" };
  }
  const prepared = prepare();
  if (!prepared.authorization || !prepared.permit) return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
  const adapter = typeof input.adapter === "function" ? await input.adapter() : input.adapter;
  if (!adapter) return { complete: false, executed: false, outcome: "CAPABILITY_BLOCKED" };
  return send(prepared.authorization, prepared.permit, adapter);
}

export function runnerTransportTarget(selection: CanonicalSelection, binding: TransportBindingIdentity) {
  const messageType = canonicalMessageType(selection);
  const envelope = buildC2cEnvelope({ type: messageType, taskId: binding.taskId!, iteration: selection.state.c2c.cycle, checkpoint: binding.checkpoint!, stage: binding.stage!, workspaceId: binding.workspaceId, workstreamId: binding.workstreamId, eventKey: binding.eventKey!, intent: "Use C2C. Read the selected workstream plan, current source/diff, approval and recorded tests through the exact workspace; review the current owning stage." });
  return { kind: "c2c_transport" as const, checkpoint: binding.checkpoint!, eventKey: binding.eventKey!, messageType, payloadHash: envelope.payloadHash };
}

export async function runHeadless(input: RunnerInvocation): Promise<RunnerResult> {
  let lease: AcquiredLease | undefined;
  let checkpoint: RunnerCheckpoint | undefined;
  let checkpointFile: string | undefined;
  let auditKind: RunnerAuditKind = "none";
  let selection: CanonicalSelection | undefined;
  let ownerEvent: string | undefined;
  let ownerExecuted = false;
  const audit: RunnerAuditObservation = { before: null, after: null, action: null, evidence: [], execution: "NOT_ENTERED" };
  const finish = (outcome: RunnerOutcome, reason: string, executed = false): RunnerResult => {
    if (checkpoint && checkpointFile) {
      if (selection) {
        try {
          const after = parseCanonicalYaml(readBoundedText(selection.stateFile));
          audit.after = after.workflow?.spec_commit === selection.pin ? observeRunnerCanonical(selection.pin, after) : null;
        } catch { audit.after = null; }
      }
      if (ownerEvent) {
        try {
          const authorization = readDeliveryAuthorization(ownerEvent);
          const receipt = readDeliveryReceipt(ownerEvent);
          if (authorization) audit.evidence = [{ owner: "a0", eventKey: ownerEvent, receiptState: receipt?.state ?? null, sendAttempts: receipt?.sendAttempts ?? 0 }];
          const reservation = authorization?.delegation && loadDelegationReservation(authorization.delegation.reservationId);
          if (reservation) audit.evidence.push({ owner: "a1", reservationId: reservation.reservationId, reservationState: reservation.state });
        } catch { /* An unavailable owner store cannot establish evidence. */ }
      }
      try { saveRunnerCheckpoint(checkpointFile, checkpoint, outcome, auditKind, audit); }
      catch { return { outcome: "RECOVERABLE_FAILURE", reason: "CHECKPOINT_UNAVAILABLE", iteration: checkpoint.iteration, executed }; }
    }
    return { outcome, reason, iteration: checkpoint?.iteration ?? 0, executed };
  };
  try {
    const root = fs.realpathSync.native(input.workspaceRoot);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.workstream)) return finish("CAPABILITY_BLOCKED", "INVALID_SELECTION");
    const files = runnerFiles(root, input.workstream);
    try { lease = acquireLease(files.lease); } catch { return finish("CAPABILITY_BLOCKED", "WORKSTREAM_LEASE_HELD"); }
    selection = readCanonicalSelection({ ...input, workspaceRoot: root });
    const observation = readDurableGoal(input.goalPath, selection, input.now);
    checkpoint = loadRunnerCheckpoint(files.checkpoint, observation);
    checkpointFile = files.checkpoint;
    audit.before = observeRunnerCanonical(selection.pin, selection.state);
    const classified = classifyCanonical(selection);
    if (classified) return finish(classified, "CANONICAL_STATE");
    const action = input.action ? parseRunnerAction(input.action) : undefined;
    auditKind = action?.kind ?? "none";
    if (!action || action.kind === "none") return finish("NO_ACTION_AVAILABLE", "NO_TYPED_ACTION");
    if (action.kind === "validation" || action.kind === "source_remediation") return finish("CAPABILITY_BLOCKED", "MISSING_VALIDATION_REMEDIATION_OWNER_ADAPTER");
    if (action.kind === "transport" && !input.adapter) return finish("CAPABILITY_BLOCKED", "MISSING_CONFIGURED_TRANSPORT_ADAPTER");
    if (!("delegation" in action)) return finish("CAPABILITY_BLOCKED", "UNSUPPORTED_ACTION");
    const binding = deriveCanonical28Binding({ workspaceRoot: selection.root, workstream: selection.workstream, workflowCheckout: selection.workflowCheckout });
    const request = action.delegation;
    const requiredClass = action.kind === "transport" ? "c2c_transport" : action.kind;
    if (request.action !== requiredClass) return finish("CAPABILITY_BLOCKED", "ACTION_CLASS_MISMATCH");
    const target = action.kind === "transport" ? runnerTransportTarget(selection, binding) : normalizeDelegationTarget(requiredClass, request.target);
    if (action.kind === "transport" && JSON.stringify(normalizeDelegationTarget("c2c_transport", request.target)) !== JSON.stringify(normalizeDelegationTarget("c2c_transport", target))) return finish("CAPABILITY_BLOCKED", "CANONICAL_TRANSPORT_TARGET_MISMATCH");
    const actionReference = createHash("sha256").update(JSON.stringify([selection.pin, binding.eventKey, action.kind, target])).digest("hex");
    audit.action = actionReference;
    if (action.kind === "transport") ownerEvent = binding.eventKey;
    if (checkpoint.pending && (checkpoint.pending.action !== actionReference || checkpoint.pending.kind !== action.kind)) return finish("CAPABILITY_BLOCKED", "PENDING_ACTION_MISMATCH");
    if (checkpoint.completed.includes(actionReference)) return finish("NO_ACTION_AVAILABLE", "ALREADY_COMPLETED");
    if (checkpoint.completed.length >= 256 || checkpoint.iteration >= Number.MAX_SAFE_INTEGER) return finish("CAPABILITY_BLOCKED", "CHECKPOINT_BOUND_REACHED");
    const recovering = checkpoint.pending !== null;
    if (checkpoint.pending?.before) audit.before = checkpoint.pending.before;
    if (recovering) audit.execution = "UNKNOWN";
    if (recovering && action.kind !== "transport") return finish("CAPABILITY_BLOCKED", "UNKNOWN_PRIOR_OWNER_COMMIT");
    const existingTransport = action.kind === "transport" ? readDeliveryAuthorization(binding.eventKey!) : null;
    if (selection.state.workflow.status !== "RUNNING") {
      if (action.kind !== "transport" || !existingTransport) return finish("CAPABILITY_BLOCKED", "NO_NEW_ACTION_WHILE_WAITING");
      try { activeRecoveryGrant(request, existingTransport, binding); }
      catch { return finish("CAPABILITY_BLOCKED", "OWNER_RECOVERY_UNAVAILABLE"); }
      if (!readDeliveryReceipt(binding.eventKey!)) return finish("CAPABILITY_BLOCKED", "OWNER_RECOVERY_UNAVAILABLE");
    }
    if (!recovering && !existingTransport) {
      const query = evaluateDelegationProof({ ...request, activeBinding: binding });
      if (query.proof.decision !== "ALLOW") return finish("CAPABILITY_BLOCKED", "OWNER_DENIED_BEFORE_COMMIT");
    }
    if (!recovering) {
      checkpoint.iteration += 1;
      checkpoint.pending = { action: actionReference, kind: action.kind, iteration: checkpoint.iteration, ...(audit.before ? { before: audit.before } : {}) };
      audit.execution = "PREPARED";
      saveRunnerCheckpoint(checkpointFile, checkpoint);
      input.afterPrepared?.();
    }
    audit.execution = "UNKNOWN";
    let complete: boolean;
    let executed: boolean;
    let outcome: RunnerOutcome;
    if (action.kind === "transport") ({ complete, executed, outcome } = await transportAction(input, selection, binding, request, recovering));
    else {
      const transaction = createDurableTransportTransaction();
      const evaluation = action.kind === "workspace_read" ? transaction.evaluateWorkspaceRead({ ...request, activeBinding: binding }) : transaction.evaluateOperationReconcile({ ...request, activeBinding: binding });
      const reservation = evaluation.reservation ?? (evaluation.proof.reservationId ? loadDelegationReservation(evaluation.proof.reservationId) : null);
      if (reservation) audit.evidence = [{ owner: "a1", reservationId: reservation.reservationId, reservationState: reservation.state }];
      complete = evaluation.proof.decision === "ALLOW" && evaluation.reservation?.state === "CONSUMED" && !!evaluation.reservation.commitReference;
      if (evaluation.proof.decision === "DENY" && !evaluation.proof.reservationId && !evaluation.reservation && evaluation.proof.reason !== "LEASE_CONFLICT") checkpoint.pending = null;
      executed = complete;
      outcome = complete ? "CONTINUED" : "CAPABILITY_BLOCKED";
    }
    audit.execution = complete ? "COMPLETED" : "INCOMPLETE";
    ownerExecuted = executed;
    input.afterOwnerAction?.();
    if (complete) { checkpoint.completed.push(actionReference); checkpoint.pending = null; }
    return finish(outcome, complete ? "OWNER_ACTION_COMPLETED" : "OWNER_RECOVERY_REQUIRED", executed);
  } catch {
    // Raw owner exceptions can contain private paths or provider identifiers.
    return finish(checkpoint?.pending ? "RECOVERABLE_FAILURE" : "CAPABILITY_BLOCKED", checkpoint?.pending ? "OWNER_RESULT_UNKNOWN" : "INVALID_OR_UNAVAILABLE_CONTEXT", ownerExecuted);
  } finally { lease?.release(); }
}
