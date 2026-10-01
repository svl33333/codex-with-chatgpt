import {
  consumeReviewerResponse,
  createWorkflowAuthorizationIssuer,
  deriveActiveCanonicalBinding,
  issueDeliveryAuthorization,
  markSending,
  prepareAuthorizedDelivery,
  recordBrowserObservation,
  recordTeamAiAuthObservation,
  reconcileDelivery,
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

/** Narrow runtime-owned seam used by the Skill/browser flow. */
export interface DurableTransportTransaction {
  beginAndPrepare(input: WorkflowAuthorizationIssuerInput & {
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
  }): { authorization: C2cDeliveryAuthorization; receipt: C2cDeliveryReceipt };
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
      if (!input.binding.workspaceRoot) throw new Error("transport begin requires an active workspace root");
      const binding = deriveActiveCanonicalBinding({
        workspaceRoot: input.binding.workspaceRoot,
        workspaceId: input.binding.workspaceId,
        candidate: input.binding,
      });
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
    markSending,
    observeVisible: recordBrowserObservation,
    observeTeamAi: recordTeamAiAuthObservation,
    reconcile: reconcileDelivery,
    consumeResponse: consumeReviewerResponse,
    deliver: deliverMessage,
  };
}
