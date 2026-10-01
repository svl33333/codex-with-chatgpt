import type { RemoteMessageState } from "./delivery.js";

export type ReasoningLevel = "low" | "medium" | "high" | "extra_high" | "unknown";

export interface ReasoningObservation {
  requested: ReasoningLevel;
  actual: ReasoningLevel;
  supported: boolean;
  corrected: boolean;
  reason?: string;
}

export interface VisibleBubbleObservation {
  visible: boolean;
  remoteId?: string;
  evidenceHash?: string;
  observedEventKey?: string;
  observedPayloadHash?: string;
  responseReady?: boolean;
}

export interface IabAdapter {
  inspectReasoning(): Promise<ReasoningObservation>;
  correctReasoning?(requested: ReasoningLevel): Promise<ReasoningObservation>;
  fillComposer(text: string): Promise<void>;
  submitComposer(): Promise<void>;
  observeVisibleBubble(input: { eventKey: string; payloadHash: string }): Promise<VisibleBubbleObservation>;
  classifyTimeout(error: unknown): "definite_failure" | "ambiguous";
  getMessageStatus?(idempotencyKey: string): Promise<RemoteMessageState>;
}

/** Browser implementations own DOM details; the transport sees this contract only. */
export type IabDeliveryAdapter = IabAdapter;

export function timeoutClassification(adapter: Pick<IabAdapter, "classifyTimeout">, error: unknown): "definite_failure" | "ambiguous" {
  return adapter.classifyTimeout(error);
}
