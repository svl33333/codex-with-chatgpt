import {
  consumeReviewerResponse,
  createWorkflowAuthorizationIssuer,
  deriveActiveCanonicalBinding,
  issueDeliveryAuthorization,
  issueOrReuseDeliveryAuthorizationOwnedLease,
  markSending,
  prepareAuthorizedDelivery,
  prepareAuthorizedDeliveryOwnedLease,
  readDeliveryAuthorization,
  recordBrowserObservation,
  recordTeamAiAuthObservation,
  reconcileDelivery,
  withOwnedEventLease,
  type BrowserObservationInput,
  type C2cDeliveryAuthorization,
  type C2cDeliveryReceipt,
  type PrepareDeliveryInput,
  type ReconcileDeliveryInput,
  type ReviewerResponseInput,
  type TeamAiAuthObservationInput,
  type TransportBindingIdentity,
  type WorkflowAuthorizationIssuerInput,
} from "./authorization.js";
import { deliverMessage, type AuthorizedMessageAdapter, type DeliveryOutcome, type MessageIntent } from "./delivery.js";
import {
  consumeGrant,
  assertDelegationReservationCommitReadyOwnedLease,
  releaseGrant,
  evaluateDelegation,
  evaluateOperationReconcile,
  evaluateWorkspaceRead,
  normalizeDelegationTarget,
  recordDelegationAudit,
  withDelegationGrantLease,
  recoverDelegatedTransport,
  type TransportDelegationTarget,
  type DelegationEvaluation,
  type DelegationGrant,
  type DelegationRequest,
  type DelegatedTransportPermit,
} from "./delegation.js";
import type { TeamAiCapabilityResult } from "./teamai.js";
import { createHash } from "node:crypto";
import { readEvidenceGit } from "../workspace/git-evidence.js";
import { readExecutionOutput } from "../execution/output.js";
import { readExecutionRecords } from "../execution/records.js";
import { assertMaintenanceGoalTarget, type MaintenanceGoal } from "../runner/goal.js";
import { prepareMaintenancePending, recordMaintenanceForwardResult, withMaintenanceGoalLease } from "../runner/state.js";
import { claimMaintenanceSendOwnedLease, observeMaintenanceSend, prepareMaintenanceReceiptOwnedLease, readMaintenanceReceipt } from "./authorization.js";
import { reserveMaintenanceReturn } from "./delegation.js";
import { MaintenanceCapabilityUnavailable, maintenanceEventKey, maintenanceTargetDigest, maintenanceTargetSchema, parseMaintenanceInstruction, resolveMaintenanceAuthority,
  type MaintenanceAuthority, type MaintenanceHost, type MaintenanceReceipt, type MaintenanceTarget } from "./maintenance-handoff.js";
import { deliverMaintenanceNotice } from "./delivery.js";

function assertMaintenanceSavedResult(target: MaintenanceTarget): void {
  const head = readEvidenceGit(target.worktreeRoot, ["rev-parse", "HEAD"], 1024).trim();
  const branch = readEvidenceGit(target.worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], 4096).trim();
  if (head !== target.head || branch !== target.branch) throw new Error("maintenance saved result Git identity mismatch");
  const output = readExecutionOutput(target.workspaceId, target.result.outputId);
  if (!output.ok || createHash("sha256").update(output.text).digest("hex") !== target.result.sha256) throw new Error("maintenance saved result is unavailable, filtered, or changed");
  const record = readExecutionRecords(target.workspaceId, 256).find((item) => item.outputId === target.result.outputId && item.maintenance?.operationId === target.operationId);
  const evidence = record?.maintenance;
  if (!evidence || evidence.goalRef !== target.goalId || evidence.planRef !== target.planRef || evidence.head !== target.head || evidence.sessionId !== target.sessionId || evidence.turnId !== target.turnId || evidence.resultSha256 !== target.result.sha256) throw new Error("maintenance execution record mismatch");
}

function beginMaintenanceReturn(goal: MaintenanceGoal, authority: MaintenanceAuthority, claim: boolean): { claimed: boolean; receipt: MaintenanceReceipt } {
  const target = authority.target;
  return withMaintenanceGoalLease(goal, target, (checkpoint, save) => {
    prepareMaintenancePending(checkpoint, target);
    return withOwnedEventLease(maintenanceEventKey(target), () => {
      const proof = reserveMaintenanceReturn(authority);
      const receipt = prepareMaintenanceReceiptOwnedLease(authority, proof);
      const result = claim ? claimMaintenanceSendOwnedLease(authority, proof) : { claimed: false, receipt };
      save();
      return result;
    });
  });
}

export function createMaintenanceHandoffTransaction(host?: MaintenanceHost) {
  function matchingReceipt(target: MaintenanceTarget): MaintenanceReceipt {
    const receipt = readMaintenanceReceipt(maintenanceEventKey(target));
    if (!receipt || maintenanceTargetDigest(receipt.target) !== maintenanceTargetDigest(target)) throw new Error("maintenance prepared target changed; reconcile the original binding");
    return receipt;
  }
  async function authorityFor(goal: MaintenanceGoal, input: MaintenanceTarget): Promise<MaintenanceAuthority> {
    const target = maintenanceTargetSchema.parse(input);
    assertMaintenanceGoalTarget(goal, target);
    const authority = await resolveMaintenanceAuthority(host, target);
    assertMaintenanceSavedResult(target);
    return authority;
  }
  return {
    async prepare(goal: MaintenanceGoal, target: MaintenanceTarget): Promise<MaintenanceReceipt> {
      return beginMaintenanceReturn(goal, await authorityFor(goal, target), false).receipt;
    },
    async send(goal: MaintenanceGoal, target: MaintenanceTarget) {
      const authority = await authorityFor(goal, target);
      if (!host?.browser) throw new MaintenanceCapabilityUnavailable("existing official in-app browser");
      const claim = beginMaintenanceReturn(goal, authority, true);
      if (!claim.claimed) return { outcome: "RECONCILE_ONLY" as const, receipt: claim.receipt };
      return deliverMaintenanceNotice(claim.receipt, host.browser);
    },
    async reconcile(goal: MaintenanceGoal, target: MaintenanceTarget): Promise<MaintenanceReceipt> {
      const authority = await authorityFor(goal, target);
      if (!host?.browser) throw new MaintenanceCapabilityUnavailable("existing browser observation");
      const receipt = matchingReceipt(authority.target);
      const observed = await host.browser.observeVisibleBubble({ eventKey: receipt.eventKey, payloadHash: receipt.payloadHash });
      return observeMaintenanceSend(receipt.eventKey, receipt.payloadHash, observed);
    },
    async forward(goal: MaintenanceGoal, input: MaintenanceTarget, instructionRef: string) {
      const authority = await authorityFor(goal, input);
      const target = authority.target;
      matchingReceipt(target);
      if (!host?.forward || host.forward.contract !== "atomic-compare-and-start-v1" || !host.readInstruction) throw new MaintenanceCapabilityUnavailable("formally authorized atomic compare-and-start and instruction reader");
      const terminal = await host.readTurn(target.sessionId, target.turnId);
      if (terminal.sessionId !== target.sessionId || terminal.turnId !== target.turnId || terminal.operationId !== target.operationId || !terminal.inputRef || terminal.status !== "completed" || terminal.contentOmitted !== false || !terminal.fullFinal?.trim() || !terminal.finalRef || !terminal.sessionRevision) throw new MaintenanceCapabilityUnavailable("exact completed provider turn and full final");
      const instruction = await host.readInstruction(instructionRef);
      const header = parseMaintenanceInstruction(instruction.text);
      if (instruction.source !== "provider" || instruction.authorKind !== "assistant" || instruction.projectId !== target.projectId || instruction.chatId !== target.chatId || !instruction.chatTurnId || instruction.basedOnFinalRef !== terminal.finalRef || instruction.instructionRef !== instructionRef || !instruction.executionAuthorityRef || header.goal_ref !== goal.id || header.plan_ref !== goal.planRef || header.workstream !== target.workstream || header.codex_session !== target.sessionId || header.reply_ref !== target.replyRef || header.operation_id === target.operationId) throw new Error("maintenance next instruction does not match the actual result and binding");
      const admitted = withMaintenanceGoalLease(goal, target, (checkpoint, save) => {
        const pending = checkpoint.pending;
        if (!pending || pending.operationId !== target.operationId || pending.turnId !== target.turnId || pending.sessionId !== target.sessionId || pending.next || checkpoint.completed.includes(header.operation_id)) return false;
        pending.next = { operationId: header.operation_id, state: "RESERVED" };
        save();
        return true;
      });
      if (!admitted) return { outcome: "RECONCILE_ONLY" as const };
      let result: Awaited<ReturnType<NonNullable<MaintenanceHost["forward"]>["compareAndStart"]>>;
      try {
        const observed = await host.forward.compareAndStart({ sessionId: target.sessionId, previousTurnId: target.turnId,
          expectedRevision: terminal.sessionRevision, operationId: header.operation_id, instruction: instruction.text,
          instructionRef, executionAuthorityRef: instruction.executionAuthorityRef, goalId: goal.id, planRef: goal.planRef });
        result = observed && observed.outcome === "started" && typeof observed.turnId === "string" && observed.turnId.trim() && observed.turnId !== target.turnId
          ? observed : observed?.outcome === "conflict" ? { outcome: "conflict" } : { outcome: "unknown" };
      } catch { result = { outcome: "unknown" }; }
      recordMaintenanceForwardResult(goal, target, header.operation_id, result);
      return result;
    },
  };
}

type TransportBeginInput = WorkflowAuthorizationIssuerInput & {
  sourceCheckpoint: string;
  sourceStage: string;
  eventKey: string;
  payloadHash: string;
  operationTarget?: import("./operation.js").GitHubOperationTarget;
  expiresAt?: string;
  processId?: string;
  sessionId?: string;
  reasoningEvidence?: PrepareDeliveryInput["reasoningEvidence"];
  envelopeEvidence?: PrepareDeliveryInput["envelopeEvidence"];
};

type DelegatedBeginInput = TransportBeginInput & {
  delegationRequest: DelegationRequest;
  delegationGrant?: DelegationGrant;
  providerEvidence?: TeamAiCapabilityResult;
};

function assertDelegatedTransportTarget(input: TransportBeginInput, request: DelegationRequest): TransportDelegationTarget {
  if (Object.prototype.hasOwnProperty.call(input, "operationTarget") || input.operationTarget !== undefined) {
    throw new Error("current-v1 delegated transport cannot carry a GitHub operation target");
  }
  const target = normalizeDelegationTarget("c2c_transport", request.target) as TransportDelegationTarget;
  if (target.checkpoint !== input.sourceCheckpoint || target.eventKey !== input.eventKey || target.messageType !== input.messageType || target.payloadHash !== input.payloadHash) {
    throw new Error("delegated transport target does not match the canonical A0 event");
  }
  return target;
}

/** Narrow runtime-owned seam used by the Skill/browser flow. */
export interface DurableTransportTransaction {
  beginAndPrepare(input: TransportBeginInput): { authorization: C2cDeliveryAuthorization; receipt: C2cDeliveryReceipt; proof?: never; result?: never };
  beginAndPrepare(input: DelegatedBeginInput): { authorization?: C2cDeliveryAuthorization; receipt?: C2cDeliveryReceipt; proof: DelegationEvaluation["proof"]; result?: unknown; reservation?: DelegationEvaluation["reservation"]; permit?: DelegatedTransportPermit };
  evaluateDelegation(request: DelegationRequest): DelegationEvaluation;
  evaluateWorkspaceRead(request: DelegationRequest): DelegationEvaluation;
  evaluateOperationReconcile(request: DelegationRequest): DelegationEvaluation;
  markSending(authorization: C2cDeliveryAuthorization, binding: TransportBindingIdentity, processId?: string, sessionId?: string): C2cDeliveryReceipt;
  observeVisible(input: BrowserObservationInput): C2cDeliveryReceipt;
  observeTeamAi(input: Omit<TeamAiAuthObservationInput, "authorization" | "binding"> & { authorization: C2cDeliveryAuthorization; binding: TransportBindingIdentity }): C2cDeliveryReceipt;
  reconcile(input: ReconcileDeliveryInput): C2cDeliveryReceipt;
  consumeResponse(input: ReviewerResponseInput): C2cDeliveryReceipt;
  deliver(intent: MessageIntent, adapter: AuthorizedMessageAdapter): Promise<DeliveryOutcome>;
}

export function createDurableTransportTransaction(): DurableTransportTransaction {
  return {
    beginAndPrepare(input) {
      const delegatedInput = input as TransportBeginInput & Partial<DelegatedBeginInput>;
      if (!input.binding.workspaceRoot) throw new Error("transport begin requires an active workspace root");
      const binding = deriveActiveCanonicalBinding({
        workspaceRoot: input.binding.workspaceRoot,
        workspaceId: input.binding.workspaceId,
        candidate: input.binding,
      });
      const request = delegatedInput.delegationRequest;
      if (request) {
        if (request.action === "c2c_transport") {
          return withOwnedEventLease(input.eventKey, () => {
            assertDelegatedTransportTarget(input, request);
            const activeRequest = {
              ...request,
              ...(delegatedInput.delegationGrant ? { grant: delegatedInput.delegationGrant } : {}),
              ...(delegatedInput.providerEvidence ? { providerEvidence: delegatedInput.providerEvidence } : {}),
              activeBinding: binding,
            } satisfies DelegationRequest;
            const existingAuthorization = readDeliveryAuthorization(input.eventKey);
            const recovered = existingAuthorization?.delegation ? recoverDelegatedTransport(activeRequest, existingAuthorization.delegation) : null;
            const delegated = recovered ?? evaluateDelegation(activeRequest);
            if (delegated.proof.decision !== "ALLOW" || !delegated.grant || !delegated.reservation || !delegated.permit) {
              throw new Error(`delegation denied: ${delegated.proof.reason ?? "ACTION_DENIED"}`);
            }
            const issuer = createWorkflowAuthorizationIssuer({
              workflowStep: input.workflowStep,
              stage: input.stage,
              issuerId: input.issuerId,
              messageType: input.messageType,
              binding,
            });
            const delegation = recovered && existingAuthorization?.delegation
              ? existingAuthorization.delegation
              : {
                  grantId: delegated.grant.grantId,
                  grantGeneration: delegated.grant.generation,
                  reservationId: delegated.reservation.reservationId,
                  decisionDigest: delegated.proof.decisionDigest,
                  ...(delegated.reservation.auditReference ? { auditReference: delegated.reservation.auditReference } : {}),
                };
            let authorization: C2cDeliveryAuthorization;
            try {
              const issue = () => issueOrReuseDeliveryAuthorizationOwnedLease({
                issuer,
                sourceCheckpoint: input.sourceCheckpoint,
                sourceStage: input.sourceStage,
                messageType: input.messageType,
                eventKey: input.eventKey,
                payloadHash: input.payloadHash,
                binding,
                ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
                delegation,
              });
              authorization = recovered
                ? issue()
                : withDelegationGrantLease(delegated.grant.grantId, undefined, () => {
                    assertDelegationReservationCommitReadyOwnedLease(delegated.reservation!, "c2c_transport", delegated.target!, undefined);
                    return issue();
                  });
            } catch (error) {
              try { releaseGrant(delegated.reservation); } catch { /* preserve the A0 failure */ }
              throw error;
            }
            // The authority persistence above is the transport commit boundary.
            const consumed = delegated.reservation.state === "CONSUMED"
              ? delegated.reservation
              : consumeGrant(delegated.reservation, authorization.authorityId, undefined, { recoveryAuthorityId: authorization.authorityId });
            const receipt = prepareAuthorizedDeliveryOwnedLease({
              authorization,
              binding,
              messageType: input.messageType,
              eventKey: input.eventKey,
              payloadHash: input.payloadHash,
              ...(input.processId ? { processId: input.processId } : {}),
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(input.reasoningEvidence ? { reasoningEvidence: input.reasoningEvidence } : {}),
              ...(input.envelopeEvidence ? { envelopeEvidence: input.envelopeEvidence } : {}),
            });
            recordDelegationAudit({
              at: new Date().toISOString(),
              grantId: delegated.grant.grantId,
              action: "c2c_transport",
              grantGeneration: consumed.grantGeneration,
              scopeDigest: delegated.grant.scopeDigest,
              targetDigest: delegated.grant.targetDigest,
              bindingDigest: delegated.proof.bindingDigest,
              decision: "CONSUMED",
              reservationId: consumed.reservationId,
              reservationState: consumed.state,
              commitReference: consumed.commitReference,
              authorityId: authorization.authorityId,
              receiptReference: receipt.eventKey,
              auditReference: consumed.auditReference ?? authorization.delegation?.auditReference,
            });
            return { authorization, receipt: { ...receipt, delegation: authorization.delegation }, proof: delegated.proof, reservation: consumed, permit: delegated.permit };
          });
        }
        if (input.operationTarget !== undefined) throw new Error("non-transport delegated actions cannot carry a GitHub operation target");
        const delegated = evaluateDelegation({
          ...request,
          ...(delegatedInput.delegationGrant ? { grant: delegatedInput.delegationGrant } : {}),
          ...(delegatedInput.providerEvidence ? { providerEvidence: delegatedInput.providerEvidence } : {}),
          activeBinding: binding,
        });
        if (delegated.proof.decision !== "ALLOW") {
          throw new Error(`delegation denied: ${delegated.proof.reason ?? "ACTION_DENIED"}`);
        }
        return {
          proof: delegated.proof,
          ...(delegated.result !== undefined ? { result: delegated.result } : {}),
          ...(delegated.reservation ? { reservation: delegated.reservation } : {}),
        };
      }
      const issuer = createWorkflowAuthorizationIssuer({
        workflowStep: input.workflowStep,
        stage: input.stage,
        issuerId: input.issuerId,
        messageType: input.messageType,
        binding,
      });
      const authorization = issueDeliveryAuthorization({
        issuer,
        sourceCheckpoint: input.sourceCheckpoint,
        sourceStage: input.sourceStage,
        messageType: input.messageType,
        eventKey: input.eventKey,
        payloadHash: input.payloadHash,
        binding,
        ...(input.operationTarget ? { operationTarget: input.operationTarget } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      const receipt = prepareAuthorizedDelivery({
        authorization,
        binding,
        messageType: input.messageType,
        eventKey: input.eventKey,
        payloadHash: input.payloadHash,
        ...(input.processId ? { processId: input.processId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.reasoningEvidence ? { reasoningEvidence: input.reasoningEvidence } : {}),
        ...(input.envelopeEvidence ? { envelopeEvidence: input.envelopeEvidence } : {}),
      });
      return { authorization, receipt };
    },
    evaluateDelegation,
    evaluateWorkspaceRead,
    evaluateOperationReconcile,
    markSending,
    observeVisible: recordBrowserObservation,
    observeTeamAi: recordTeamAiAuthObservation,
    reconcile: reconcileDelivery,
    consumeResponse: consumeReviewerResponse,
    deliver: deliverMessage,
  } as DurableTransportTransaction;
}
