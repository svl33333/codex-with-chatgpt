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
