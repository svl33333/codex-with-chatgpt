import type { TeamAiCapabilityResult } from "./teamai.js";
import type { GitHubOperationRecord } from "./operation.js";
import { assertTeamAiAuthResult } from "./teamai.js";

export const DELEGATION_POLICY_VERSION = "a1-v1" as const;

export type DelegatedAction = "c2c_transport" | "workspace_read" | "operation_reconcile";
export type DelegationRoute = "DELEGATED_TRANSPORT" | "LOCAL_WORKSPACE_READ" | "KNOWN_OPERATION_RECONCILE";
export type OperationEvidencePath = "local_persisted" | "provider_bound";

export interface DelegationPolicyDefaults {
  lifetimeMs: number;
  transportMaxUses: number;
  readReconcileMaxUses: number;
  singleUseMaxUses: number;
}

export const DELEGATION_POLICY_DEFAULTS: Readonly<DelegationPolicyDefaults> = Object.freeze({
  lifetimeMs: 24 * 60 * 60 * 1000,
  transportMaxUses: 64,
  readReconcileMaxUses: 256,
  singleUseMaxUses: 1,
});

export const ALLOWED_DELEGATED_ACTIONS: readonly DelegatedAction[] = [
  "c2c_transport",
  "workspace_read",
  "operation_reconcile",
];

export const EXCLUDED_DELEGATED_ACTIONS = Object.freeze([
  "issue_create",
  "issue_update",
  "push",
  "pr_create",
  "pr_update",
  "review",
  "publication",
  "merge",
  "human_gate",
  "authentication",
  "security_boundary",
  "connector_mutation",
  "project_mutation",
  "account_mutation",
] as const);

export interface ProviderContractRequirement {
  expectedAccount: string;
  source: "teamai";
  skillName: "github-cli-auth";
  capabilityVersion: string;
  minCapabilityVersion?: string;
  maxCapabilityVersion?: string;
}

export interface ProviderEvidenceProjection {
  source: "teamai";
  skillName: "github-cli-auth";
  capabilityVersion: string;
  classification: TeamAiCapabilityResult["classification"];
  expectedAccount?: string;
  correlationId: string;
  authAttemptId?: string;
}

export function routeForAction(action: DelegatedAction): DelegationRoute {
  switch (action) {
    case "c2c_transport": return "DELEGATED_TRANSPORT";
    case "workspace_read": return "LOCAL_WORKSPACE_READ";
    case "operation_reconcile": return "KNOWN_OPERATION_RECONCILE";
  }
}

export function isDelegatedAction(value: unknown): value is DelegatedAction {
  return typeof value === "string" && (ALLOWED_DELEGATED_ACTIONS as readonly string[]).includes(value);
}

export function maxUsesForAction(action: DelegatedAction, singleUse = false): number {
  if (singleUse) return DELEGATION_POLICY_DEFAULTS.singleUseMaxUses;
  return action === "c2c_transport" ? DELEGATION_POLICY_DEFAULTS.transportMaxUses : DELEGATION_POLICY_DEFAULTS.readReconcileMaxUses;
}

export function providerEvidenceProjection(result: TeamAiCapabilityResult): ProviderEvidenceProjection {
  assertTeamAiAuthResult(result);
  return {
    source: result.source,
    skillName: result.classifier,
    capabilityVersion: result.capabilityVersion,
    classification: result.classification,
    ...(result.expectedAccount ? { expectedAccount: result.expectedAccount } : {}),
    correlationId: result.correlationId,
    ...(result.authAttemptId ? { authAttemptId: result.authAttemptId } : {}),
  };
}

function versionParts(value: string): number[] {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [];
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (a.length === 0 || b.length === 0) return left === right ? 0 : -1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function providerContractMatches(
  requirement: ProviderContractRequirement,
  result: TeamAiCapabilityResult,
): boolean {
  try {
    const projected = providerEvidenceProjection(result);
    if (projected.source !== requirement.source || projected.skillName !== requirement.skillName) return false;
    if (requirement.expectedAccount !== undefined && projected.expectedAccount !== requirement.expectedAccount) return false;
    if (requirement.capabilityVersion && compareVersions(projected.capabilityVersion, requirement.capabilityVersion) < 0) return false;
    if (requirement.minCapabilityVersion && compareVersions(projected.capabilityVersion, requirement.minCapabilityVersion) < 0) return false;
    if (requirement.maxCapabilityVersion && compareVersions(projected.capabilityVersion, requirement.maxCapabilityVersion) > 0) return false;
    return projected.classification === "healthy";
  } catch {
    return false;
  }
}

export interface PersistedOperationEvidencePath {
  evidencePath?: unknown;
  providerRequired?: unknown;
  source?: unknown;
  operationEvidence?: unknown;
  receiptState?: unknown;
  receiptAuthorityId?: unknown;
}

/**
 * Derive the reconciliation path exclusively from typed persisted evidence.
 * The wire request never supplies this value. Existing A0 records without an
 * explicit path are provider-bound until an authoritative A0 receipt carries
 * a persisted, bounded operation-evidence result. A GitHub-shaped operation
 * never manufactures a local result merely because its record exists.
 */
export function deriveOperationEvidencePath(
  record: GitHubOperationRecord,
  persistedEvidence?: PersistedOperationEvidencePath,
): OperationEvidencePath {
  if (!record || record.schemaVersion !== 1 || typeof record.operationKey !== "string" || !record.operationKey) {
    throw new Error("known operation identity is missing or stale");
  }
  const recordPath = (record as GitHubOperationRecord & { reconciliationPath?: unknown }).reconciliationPath;
  if (recordPath !== undefined && recordPath !== "local_persisted" && recordPath !== "provider_bound") throw new Error("unsupported operation evidence path");
  const hasAuthoritativeReceiptEvidence = persistedEvidence?.source === "a0-receipt" &&
    typeof persistedEvidence.receiptAuthorityId === "string" &&
    persistedEvidence.receiptAuthorityId.length > 0 &&
    persistedEvidence.operationEvidence !== undefined &&
    (persistedEvidence.receiptState === "RECONCILING" || persistedEvidence.receiptState === "WAITING_RESPONSE" || persistedEvidence.receiptState === "FAILED_DEFINITE" || persistedEvidence.receiptState === "AMBIGUOUS" || persistedEvidence.receiptState === "RESPONSE_RECEIVED");
  const evidencePath = hasAuthoritativeReceiptEvidence ? "local_persisted" : "provider_bound";
  if (persistedEvidence?.evidencePath !== undefined && persistedEvidence.evidencePath !== evidencePath) throw new Error("persisted evidence path is not policy-bound");
  if (persistedEvidence?.providerRequired !== undefined && typeof persistedEvidence.providerRequired !== "boolean") {
    throw new Error("invalid persisted provider requirement");
  }
  if (persistedEvidence?.providerRequired === true && evidencePath !== "provider_bound") {
    throw new Error("provider evidence path is not policy-bound");
  }
  if (persistedEvidence?.source !== undefined && persistedEvidence.source !== "a0-receipt" && persistedEvidence.source !== "provider") {
    throw new Error("invalid persisted evidence source");
  }
  return evidencePath;
}

export function isProviderDependentPath(path: OperationEvidencePath): boolean {
  return path === "provider_bound";
}
