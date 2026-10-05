import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { ChatGPTSurfaceId, SurfaceOutcome } from "./chatgpt-surface.js";
import type { PairingStrategy, PairingStrategyOverride } from "../pairing/strategy.js";
import type { ReviewerProof } from "./reviewer-proof.js";

/** Machine-local setup phases. This file never contains credentials or message bodies. */
export const PROVISIONING_PHASES = [
  "uninitialized",
  "runtime_ready",
  "human_auth_required",
  "authenticated",
  "connector_provisioning",
  "connector_ready",
  "project_binding",
  "workspace_verification",
  "ready",
  "degraded",
  "repairing",
  "human_action_required",
] as const;

export type ProvisioningPhase = (typeof PROVISIONING_PHASES)[number];

export type ProvisioningOutcome = SurfaceOutcome | "PENDING";

export const PROVISIONING_SURFACE_IDS = [
  "plugin-hub-custom-mcp",
  "settings-custom-app",
  "authenticated-browser-profile",
] as const;

export const PROVISIONING_OUTCOMES = [
  "PENDING",
  "REUSED",
  "CREATED",
  "RECOVERED",
  "HUMAN_BOUNDARY",
  "RECOVERABLE_FAILURE",
  "REQUIRED_CAPABILITY_UNAVAILABLE",
] as const;

export interface ProvisioningState {
  schemaVersion: 1 | 2 | 3;
  workspaceId: string;
  phase: ProvisioningPhase;
  reason?: string;
  retryCount?: number;
  selectedSurface?: ChatGPTSurfaceId;
  outcome?: ProvisioningOutcome;
  nextAction?: string;
  accountVerified?: boolean;
  readOnlyVerified?: boolean;
  oauthContractVerified?: boolean;
  projectVerified?: boolean;
  messageSelectionVerified?: boolean;
  messageSelectionKey?: string;
  workspaceInfoHash?: string;
  gitStatusHash?: string;
  pairingStrategyOverride?: PairingStrategyOverride;
  pairingStrategy?: PairingStrategy;
  proofSchemaVersion?: number;
  reviewerProof?: ReviewerProof;
  updatedAt: string;
}

export interface ProvisioningStatePatch {
  reason?: string;
  retryCount?: number;
  selectedSurface?: ChatGPTSurfaceId;
  outcome?: ProvisioningOutcome;
  nextAction?: string;
  accountVerified?: boolean;
  readOnlyVerified?: boolean;
  oauthContractVerified?: boolean;
  projectVerified?: boolean;
  messageSelectionVerified?: boolean;
  messageSelectionKey?: string;
  workspaceInfoHash?: string;
  gitStatusHash?: string;
  pairingStrategyOverride?: PairingStrategyOverride;
  pairingStrategy?: PairingStrategy;
  proofSchemaVersion?: number;
  reviewerProof?: ReviewerProof;
}

export interface ProvisioningObservation {
  workspaceReady: boolean;
  runtimeReady: boolean;
  authenticated: boolean;
  connectorProvisioning?: boolean;
  connectorReady: boolean;
  projectBinding?: boolean;
  projectBound: boolean;
  workspaceVerification?: boolean;
  workspaceVerified: boolean;
  degraded?: boolean;
  repairing?: boolean;
  humanAuthRequired?: boolean;
  humanActionRequired?: boolean;
}

export function provisioningFile(workspaceId: string): string {
  return path.join(getStateDir(), "provisioning", `${workspaceId}.json`);
}

function isPhase(value: unknown): value is ProvisioningPhase {
  return typeof value === "string" && (PROVISIONING_PHASES as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is ProvisioningOutcome {
  return typeof value === "string" && PROVISIONING_OUTCOMES.includes(value as (typeof PROVISIONING_OUTCOMES)[number]);
}

function isSurface(value: unknown): value is ChatGPTSurfaceId {
  return typeof value === "string" && PROVISIONING_SURFACE_IDS.includes(value as (typeof PROVISIONING_SURFACE_IDS)[number]);
}

function isPairingStrategyOverride(value: unknown): value is PairingStrategyOverride {
  return value === "auto" || value === "compatibility";
}

function isPairingStrategy(value: unknown): value is PairingStrategy {
  return value === "runtime_handoff" || value === "compatibility";
}

function isReviewerProof(value: unknown): value is ReviewerProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Partial<ReviewerProof>;
  const appIdentity = proof.appIdentity;
  return (
    proof.schemaVersion === 1 &&
    typeof proof.messageKey === "string" &&
    proof.messageKey.length > 0 &&
    proof.capability === "read-only" &&
    typeof proof.repository === "string" &&
    typeof proof.root === "string" &&
    typeof proof.branch === "string" &&
    typeof proof.head === "string" &&
    /^[0-9a-f]{40}$/i.test(proof.head) &&
    typeof proof.evidenceDigest === "string" &&
    /^[0-9a-f]{64}$/i.test(proof.evidenceDigest) &&
    Boolean(appIdentity && typeof appIdentity.workspaceId === "string" && appIdentity.workspaceId.length > 0 &&
      typeof appIdentity.connectorName === "string" && appIdentity.connectorName.length > 0)
  );
}

export function hasProvisioningReadinessProof(
  state: Pick<
    ProvisioningState,
    | "selectedSurface"
    | "outcome"
    | "accountVerified"
    | "readOnlyVerified"
    | "oauthContractVerified"
    | "projectVerified"
    | "messageSelectionVerified"
    | "messageSelectionKey"
    | "reviewerProof"
  >
): boolean {
  return (
    Boolean(state.selectedSurface) &&
    (state.outcome === "REUSED" || state.outcome === "CREATED" || state.outcome === "RECOVERED") &&
    [state.accountVerified, state.readOnlyVerified, state.oauthContractVerified, state.projectVerified, state.messageSelectionVerified].every(Boolean) &&
    typeof state.messageSelectionKey === "string" &&
    state.messageSelectionKey.length > 0 &&
    hasStructuredReviewerProof(state)
  );
}

/** Structured proof gate for new reviewer sessions; legacy boolean state remains readable. */
export function hasStructuredReviewerProof(state: Pick<ProvisioningState, "reviewerProof">): boolean {
  return isReviewerProof(state.reviewerProof);
}

export function readProvisioningState(workspaceId: string): ProvisioningState | null {
  const value = readJsonIfExists<Partial<ProvisioningState>>(provisioningFile(workspaceId));
  if (
    !value ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
    value.workspaceId !== workspaceId ||
    !isPhase(value.phase)
  ) return null;
  return {
    schemaVersion: value.schemaVersion === 3 ? 3 : 2,
    workspaceId,
    phase: value.phase,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(typeof value.retryCount === "number" && Number.isSafeInteger(value.retryCount) && value.retryCount >= 0
      ? { retryCount: value.retryCount }
      : {}),
    ...(isSurface(value.selectedSurface) ? { selectedSurface: value.selectedSurface } : {}),
    ...(isOutcome(value.outcome) ? { outcome: value.outcome } : {}),
    ...(typeof value.nextAction === "string" && value.nextAction.trim() ? { nextAction: value.nextAction.trim().slice(0, 200) } : {}),
    ...(typeof value.accountVerified === "boolean" ? { accountVerified: value.accountVerified } : {}),
    ...(typeof value.readOnlyVerified === "boolean" ? { readOnlyVerified: value.readOnlyVerified } : {}),
    ...(typeof value.oauthContractVerified === "boolean" ? { oauthContractVerified: value.oauthContractVerified } : {}),
    ...(typeof value.projectVerified === "boolean" ? { projectVerified: value.projectVerified } : {}),
    ...(typeof value.messageSelectionVerified === "boolean" ? { messageSelectionVerified: value.messageSelectionVerified } : {}),
    ...(typeof value.messageSelectionKey === "string" && value.messageSelectionKey.trim()
      ? { messageSelectionKey: value.messageSelectionKey.trim().slice(0, 128) }
      : {}),
    ...(typeof value.workspaceInfoHash === "string" ? { workspaceInfoHash: value.workspaceInfoHash.slice(0, 64) } : {}),
    ...(typeof value.gitStatusHash === "string" ? { gitStatusHash: value.gitStatusHash.slice(0, 64) } : {}),
    ...(isPairingStrategyOverride(value.pairingStrategyOverride) ? { pairingStrategyOverride: value.pairingStrategyOverride } : {}),
    ...(isPairingStrategy(value.pairingStrategy) ? { pairingStrategy: value.pairingStrategy } : {}),
    ...(typeof value.proofSchemaVersion === "number" && Number.isInteger(value.proofSchemaVersion) && value.proofSchemaVersion > 0
      ? { proofSchemaVersion: value.proofSchemaVersion }
      : {}),
    ...(isReviewerProof(value.reviewerProof) ? { reviewerProof: value.reviewerProof } : {}),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function writeProvisioningState(
  workspaceId: string,
  phase: ProvisioningPhase,
  patch: ProvisioningStatePatch = {}
): ProvisioningState {
  const previous = readProvisioningState(workspaceId);
  const proof = {
    selectedSurface: patch.selectedSurface ?? previous?.selectedSurface,
    outcome: patch.outcome ?? previous?.outcome,
    accountVerified: patch.accountVerified ?? previous?.accountVerified,
    readOnlyVerified: patch.readOnlyVerified ?? previous?.readOnlyVerified,
    oauthContractVerified: patch.oauthContractVerified ?? previous?.oauthContractVerified,
    projectVerified: patch.projectVerified ?? previous?.projectVerified,
    messageSelectionVerified: patch.messageSelectionVerified ?? previous?.messageSelectionVerified,
    messageSelectionKey: patch.messageSelectionKey ?? previous?.messageSelectionKey,
    reviewerProof: patch.reviewerProof ?? previous?.reviewerProof,
  };
  const selectedSurface = patch.selectedSurface ?? previous?.selectedSurface;
  const outcome = patch.outcome ?? previous?.outcome;
  const nextAction = patch.nextAction ?? previous?.nextAction;
  const workspaceInfoHash = patch.workspaceInfoHash ?? previous?.workspaceInfoHash;
  const gitStatusHash = patch.gitStatusHash ?? previous?.gitStatusHash;
  const pairingStrategyOverride = patch.pairingStrategyOverride ?? previous?.pairingStrategyOverride;
  const pairingStrategy = patch.pairingStrategy ?? previous?.pairingStrategy;
  const proofSchemaVersion = patch.proofSchemaVersion ?? previous?.proofSchemaVersion;
  const reviewerProof = patch.reviewerProof ?? previous?.reviewerProof;
  const ready = phase === "ready" && !hasProvisioningReadinessProof(proof);
  const persistedPhase = ready ? "workspace_verification" : phase;
  const next: ProvisioningState = {
    schemaVersion: 3,
    workspaceId,
    phase: persistedPhase,
    ...(patch.reason?.trim() ? { reason: patch.reason.trim().slice(0, 400) } : ready ? { reason: "ready proof incomplete" } : {}),
    ...(patch.retryCount !== undefined && Number.isSafeInteger(patch.retryCount) && patch.retryCount >= 0
      ? { retryCount: patch.retryCount }
      : {}),
    ...(isSurface(selectedSurface) ? { selectedSurface } : {}),
    ...(isOutcome(outcome) ? { outcome } : {}),
    ...(nextAction?.trim() ? { nextAction: nextAction.trim().slice(0, 200) } : {}),
    ...(typeof proof.accountVerified === "boolean" ? { accountVerified: proof.accountVerified } : {}),
    ...(typeof proof.readOnlyVerified === "boolean" ? { readOnlyVerified: proof.readOnlyVerified } : {}),
    ...(typeof proof.oauthContractVerified === "boolean" ? { oauthContractVerified: proof.oauthContractVerified } : {}),
    ...(typeof proof.projectVerified === "boolean" ? { projectVerified: proof.projectVerified } : {}),
    ...(typeof proof.messageSelectionVerified === "boolean" ? { messageSelectionVerified: proof.messageSelectionVerified } : {}),
    ...(typeof proof.messageSelectionKey === "string" && proof.messageSelectionKey.trim()
      ? { messageSelectionKey: proof.messageSelectionKey.trim().slice(0, 128) }
      : {}),
    ...(typeof workspaceInfoHash === "string" ? { workspaceInfoHash: workspaceInfoHash.slice(0, 64) } : {}),
    ...(typeof gitStatusHash === "string" ? { gitStatusHash: gitStatusHash.slice(0, 64) } : {}),
    ...(isPairingStrategyOverride(pairingStrategyOverride) ? { pairingStrategyOverride } : {}),
    ...(isPairingStrategy(pairingStrategy) ? { pairingStrategy } : {}),
    ...(typeof proofSchemaVersion === "number" && Number.isInteger(proofSchemaVersion) && proofSchemaVersion > 0 ? { proofSchemaVersion } : {}),
    ...(isReviewerProof(reviewerProof) ? { reviewerProof } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeSecureJson(provisioningFile(workspaceId), next);
  return next;
}

/** Derive a phase from live observations rather than conversation prose. */
export function deriveProvisioningPhase(observation: ProvisioningObservation): ProvisioningPhase {
  if (observation.humanActionRequired) return "human_action_required";
  if (observation.humanAuthRequired) return "human_auth_required";
  if (observation.repairing) return "repairing";
  if (observation.degraded) return "degraded";
  if (!observation.workspaceReady) return "uninitialized";
  if (!observation.runtimeReady) return "uninitialized";
  if (!observation.authenticated) return "runtime_ready";
  if (observation.connectorProvisioning) return "connector_provisioning";
  if (!observation.connectorReady) return "authenticated";
  if (observation.projectBinding) return "project_binding";
  if (!observation.projectBound) return "connector_ready";
  if (observation.workspaceVerification || !observation.workspaceVerified) return "workspace_verification";
  return "ready";
}
