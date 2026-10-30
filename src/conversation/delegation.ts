import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  delegationRoot,
  delegationSubdir,
  writeAtomicSecureJson,
} from "../config/paths.js";
import { parseStrictJson, readStrictJsonFile } from "../config/strict-json.js";
import { acquireLease, type LeaseClock } from "../config/lease.js";
import {
  assertActiveCanonicalBinding,
  type DeliveryMessageType,
  type TransportBindingIdentity,
} from "./authorization.js";
import {
  readKnownLogicalOperation,
  type GitHubOperationRecord,
} from "./operation.js";
import { readDeliveryReceiptForOperation } from "./authorization.js";
import { Workspace } from "../workspace/manager.js";
import { gitStatus } from "../workspace/git.js";
import {
  ALLOWED_DELEGATED_ACTIONS,
  DELEGATION_POLICY_DEFAULTS,
  DELEGATION_POLICY_VERSION,
  isDelegatedAction,
  isProviderDependentPath as policyIsProviderDependentPath,
  maxUsesForAction,
  providerContractMatches,
  providerEvidenceProjection,
  routeForAction,
  deriveOperationEvidencePath,
  isProviderDependentPath,
  type DelegatedAction,
  type DelegationRoute,
  type OperationEvidencePath,
  type ProviderContractRequirement,
} from "./delegation-policy.js";
import type { TeamAiCapabilityResult } from "./teamai.js";

export {
  ALLOWED_DELEGATED_ACTIONS,
  DELEGATION_POLICY_DEFAULTS,
  DELEGATION_POLICY_VERSION,
  routeForAction,
  type DelegatedAction,
  type DelegationRoute,
  type OperationEvidencePath,
  type ProviderContractRequirement,
};

const DELEGATION_SCHEMA_VERSION = 1 as const;
const MAX_SCOPE_TEXT = 512;
const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PERMIT: unique symbol = Symbol("a1-delegated-transport-permit");

export type DelegationClock = LeaseClock | (() => number);

export interface DelegationScope {
  workspaceId: string;
  workstreamId: string;
  workspaceName?: string;
  workspaceRoot?: string;
  canonicalRepository: string;
  worktreeRoot: string;
  branch: string;
  stage: string;
  canonicalAction: string;
  checkpoint?: string;
  taskId?: string;
  eventKey?: string;
  projectId?: string;
  chatId?: string;
  connectorName?: string;
  mcpAppId?: string;
  mcpVersionId?: string;
  installationId?: string;
  endpointFingerprint?: string;
  action?: DelegatedAction;
}

export interface TransportDelegationTarget {
  kind: "c2c_transport" | "transport";
  checkpoint: string;
  eventKey: string;
  messageType: DeliveryMessageType;
  payloadHash: string;
}

export interface WorkspaceReadDelegationTarget {
  kind: "workspace_read" | "workspace";
  operation: "read" | "search" | "status";
  path?: string;
  query?: string;
  maxBytes?: number;
}

export interface OperationReconcileDelegationTarget {
  kind: "operation_reconcile" | "operation";
  operationKey: string;
  proofRequest?: string;
  /** Deliberately not accepted from the untrusted wire request. */
  evidencePath?: never;
}

export type DelegationTarget =
  | TransportDelegationTarget
  | WorkspaceReadDelegationTarget
  | OperationReconcileDelegationTarget;

export interface DelegationRequest {
  action: DelegatedAction | string;
  scope: DelegationScope | Record<string, unknown>;
  target: DelegationTarget | Record<string, unknown>;
  grantId?: string;
  grant?: DelegationGrant;
  providerEvidence?: TeamAiCapabilityResult;
  /** Caller-controlled routing is intentionally rejected when present. */
  delegationRequired?: unknown;
  clock?: DelegationClock;
  /** A retry identity is runtime-owned; callers cannot select one. */
  decisionInstanceId?: never;
  activeBinding?: TransportBindingIdentity;
}

export interface DelegationApprovalProvenance {
  workflowStatePath: string;
  checkpoint: string;
  decisionId: string;
  approverIdentityRef: string;
  approvedAt: string;
  approvedDigest: string;
}

/** Canonical provenance for a grant revocation decision. */
export interface DelegationRevocationProvenance {
  workflowStatePath: string;
  checkpoint: string;
  decisionId: string;
  approverIdentityRef: string;
  approvedAt: string;
  approvedDigest: string;
  grantId: string;
  reason?: string;
}

export type DelegationGrantStatus = "APPROVED_ACTIVE" | "REVOKED" | "SUPERSEDED" | "EXPIRED";

export interface DelegationGrant {
  schemaVersion: 1;
  policyVersion: string;
  grantId: string;
  generation: number;
  createdAt: string;
  notBefore: string;
  expiresAt: string;
  action: DelegatedAction;
  route: DelegationRoute;
  scope: DelegationScope;
  scopeDigest: string;
  /** Class-specific target is an immutable part of every grant. */
  target: DelegationTarget;
  targetDigest: string;
  approval: DelegationApprovalProvenance;
  maxUses: number;
  useCount: number;
  status: DelegationGrantStatus;
  providerRequirement?: ProviderContractRequirement;
  supersedesGrantIds?: string[];
  supersededBy?: string;
  revokedAt?: string;
  revocationReason?: string;
}

export type ReservationState = "RESERVED" | "CONSUMED" | "RELEASED";

export interface DelegationReservation {
  schemaVersion: 1;
  reservationId: string;
  grantId: string;
  grantGeneration: number;
  decisionInstanceId: string;
  action: DelegatedAction;
  targetDigest: string;
  state: ReservationState;
  createdAt: string;
  updatedAt: string;
  commitReference?: string;
  /** Stable pointer joining every lifecycle entry for this reservation. */
  auditReference?: string;
}

export type DelegationDenialReason =
  | "HUMAN_GATE"
  | "SCOPE_MISMATCH"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_SUPERSEDED"
  | "GRANT_EXHAUSTED"
  | "TEAMAI_UNAVAILABLE"
  | "TEAMAI_INCOMPATIBLE"
  | "OPERATION_NOT_KNOWN"
  | "SCHEMA_UNSUPPORTED"
  | "LEASE_CONFLICT"
  | "ACTION_DENIED"
  | "TARGET_DENIED"
  | "PROVIDER_FIELDS_IRRELEVANT"
  | "INVALID_APPROVAL";

export interface DelegationDecisionProof {
  schemaVersion: 1;
  decision: "ALLOW" | "DENY";
  action: DelegatedAction | string;
  route?: DelegationRoute;
  reason?: DelegationDenialReason;
  grantId?: string;
  grantGeneration?: number;
  scopeDigest?: string;
  targetDigest?: string;
  bindingDigest?: string;
  decisionInstanceId?: string;
  reservationId?: string;
  now?: number;
  notBefore?: string;
  expiresAt?: string;
  useCount?: number;
  maxUses?: number;
  operationKey?: string;
  evidencePath?: OperationEvidencePath;
  provider?: {
    source: "teamai";
    skillName: "github-cli-auth";
    capabilityVersion: string;
    expectedAccount?: string;
    classification: TeamAiCapabilityResult["classification"];
  };
  decisionDigest: string;
}

export interface DelegatedTransportPermit {
  readonly [PERMIT]: true;
  readonly grantId: string;
  readonly grantGeneration: number;
  readonly reservationId: string;
  readonly decisionDigest: string;
}

export interface DelegationEvaluation {
  proof: DelegationDecisionProof;
  reservation?: DelegationReservation;
  grant?: DelegationGrant;
  permit?: DelegatedTransportPermit;
  operation?: GitHubOperationRecord;
  target?: DelegationTarget;
  result?: unknown;
}

export interface CreateDelegationGrantInput {
  action: DelegatedAction | string;
  scope: DelegationScope | Record<string, unknown>;
  target: DelegationTarget | Record<string, unknown>;
  approval?: DelegationApprovalProvenance;
  approvalProvenance?: DelegationApprovalProvenance;
  grantId?: string;
  createdAt?: string;
  notBefore?: string;
  expiresAt?: string;
  maxUses?: number;
  singleUse?: boolean;
  providerRequirement?: ProviderContractRequirement;
  supersedesGrantIds?: string[];
  persistedOperation?: GitHubOperationRecord;
  clock?: DelegationClock;
  persist?: boolean;
}

export interface RevokeDelegationInput {
  reason?: string;
  clock?: DelegationClock;
  /** Optional for trusted in-process lifecycle seams; required by the CLI. */
  approval?: DelegationRevocationProvenance;
}

export interface DelegationAuditEntry {
  at: string;
  grantId: string;
  action: DelegatedAction | string;
  grantGeneration?: number;
  approvalDecisionId?: string;
  approvalDigest?: string;
  scopeDigest?: string;
  targetDigest?: string;
  bindingDigest?: string;
  decision: "ALLOW" | "DENY" | "RESERVED" | "CONSUMED" | "RELEASED" | "REVOKED" | "SUPERSEDED";
  reason?: string;
  reservationId?: string;
  reservationState?: ReservationState;
  commitReference?: string;
  authorityId?: string;
  receiptReference?: string;
  reconciliationReference?: string;
  revocationEvidence?: string;
  supersessionEvidence?: string;
  auditReference?: string;
}

const COMMON_SCOPE_KEYS = new Set([
  "workspaceId", "workstreamId", "workspaceName", "workspaceRoot", "canonicalRepository", "worktreeRoot", "branch", "stage", "canonicalAction", "checkpoint", "taskId", "eventKey", "projectId", "chatId", "connectorName", "mcpAppId", "mcpVersionId", "installationId", "endpointFingerprint", "action",
]);
const TARGET_KEYS: Record<DelegatedAction, Set<string>> = {
  c2c_transport: new Set(["kind", "checkpoint", "eventKey", "messageType", "payloadHash"]),
  workspace_read: new Set(["kind", "operation", "path", "query", "maxBytes"]),
  operation_reconcile: new Set(["kind", "operationKey", "proofRequest"]),
};

function clockMs(clock: DelegationClock | undefined): number {
  if (typeof clock === "function") return clock();
  return clock?.now() ?? Date.now();
}

function bounded(value: unknown, limit = MAX_SCOPE_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/[\r\n]+/g, " ");
  return text ? text.slice(0, limit) : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${where} contains unsupported field: ${key}`);
  }
}

function normalizedText(value: unknown, field: string, required = true): string | undefined {
  const result = bounded(value);
  if (!result && required) throw new Error(`${field} is required`);
  return result;
}

export function normalizeDelegationScope(input: DelegationScope | Record<string, unknown>, action?: DelegatedAction): DelegationScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("delegation scope must be an object");
  const value = input as Record<string, unknown>;
  rejectUnknown(value, COMMON_SCOPE_KEYS, "delegation scope");
  const scope: DelegationScope = {
    workspaceId: normalizedText(value.workspaceId, "workspaceId")!,
    workstreamId: normalizedText(value.workstreamId, "workstreamId")!,
    canonicalRepository: normalizedText(value.canonicalRepository, "canonicalRepository")!,
    worktreeRoot: normalizedText(value.worktreeRoot, "worktreeRoot")!,
    branch: normalizedText(value.branch, "branch")!,
    stage: normalizedText(value.stage, "stage")!,
    canonicalAction: normalizedText(value.canonicalAction ?? value.action, "canonicalAction")!,
    ...(action ? { action } : typeof value.action === "string" && isDelegatedAction(value.action) ? { action: value.action } : {}),
  };
  for (const field of ["workspaceName", "workspaceRoot", "checkpoint", "taskId", "eventKey", "projectId", "chatId", "connectorName", "mcpAppId", "mcpVersionId", "installationId", "endpointFingerprint"] as const) {
    const item = bounded(value[field]);
    if (item) scope[field] = item;
  }
  const lowerStage = scope.stage.toLowerCase();
  const lowerAction = scope.canonicalAction.toLowerCase();
  const stageBoundary = ["human gate", "approval", "authentication", "security boundary"].some((term) => lowerStage.includes(term));
  const actionBoundary = ["push", "merge", "publication", "review", "issue", "connector", "account", "project"].some((term) => lowerAction.includes(term));
  if (stageBoundary || actionBoundary) {
    throw new Error("delegation scope crosses a Human Gate or excluded action");
  }
  return scope;
}

export function normalizeDelegationTarget(action: DelegatedAction, input: DelegationTarget | Record<string, unknown>): DelegationTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("delegation target must be an object");
  const value = input as Record<string, unknown>;
  rejectUnknown(value, TARGET_KEYS[action], `${action} target`);
  switch (action) {
    case "c2c_transport": {
      const messageType = value.messageType;
      if (!["INIT", "HANDOFF", "PLAN", "EXECUTED", "REVIEW", "RE_REVIEW"].includes(String(messageType))) throw new Error("unsupported transport message type");
      const result: TransportDelegationTarget = {
        kind: value.kind === "transport" ? "transport" : "c2c_transport",
        checkpoint: normalizedText(value.checkpoint, "transport checkpoint")!,
        eventKey: normalizedText(value.eventKey, "transport eventKey")!,
        messageType: messageType as DeliveryMessageType,
        payloadHash: normalizedText(value.payloadHash, "transport payloadHash", true)!,
      };
      return result;
    }
    case "workspace_read": {
      if (value.operation !== "read" && value.operation !== "search" && value.operation !== "status") throw new Error("unsupported workspace read operation");
      const maxBytes = value.maxBytes === undefined ? 256 * 1024 : typeof value.maxBytes === "number" ? value.maxBytes : NaN;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024) throw new Error("workspace read bound is invalid");
      const result: WorkspaceReadDelegationTarget = {
        kind: value.kind === "workspace" ? "workspace" : "workspace_read",
        operation: value.operation,
        ...(value.path !== undefined ? { path: normalizedText(value.path, "workspace path") } : {}),
        ...(value.query !== undefined ? { query: normalizedText(value.query, "workspace query") } : {}),
        maxBytes,
      };
      if (result.operation === "read" && !result.path) throw new Error("workspace read path is required");
      if (result.operation === "search" && !result.query) throw new Error("workspace search query is required");
      if (result.path && (path.isAbsolute(result.path) || result.path.includes("..\\") || result.path.includes("../"))) throw new Error("workspace path escapes the bounded root");
      return result;
    }
    case "operation_reconcile": {
      if (Object.prototype.hasOwnProperty.call(value, "evidencePath")) throw new Error("evidencePath is policy-owned and cannot be supplied by a request");
      return {
        kind: value.kind === "operation" ? "operation" : "operation_reconcile",
        operationKey: normalizedText(value.operationKey, "operationKey")!,
        ...(value.proofRequest !== undefined ? { proofRequest: normalizedText(value.proofRequest, "proofRequest") } : {}),
      };
    }
  }
}

export function delegationScopeDigest(scope: DelegationScope): string {
  return digest(normalizeDelegationScope(scope, scope.action));
}

export const scopeDigest = delegationScopeDigest;

function targetDigest(target: DelegationTarget): string {
  return digest(target);
}

export const delegationTargetDigest = targetDigest;

function bindingDigest(binding: TransportBindingIdentity | undefined): string | undefined {
  if (!binding) return undefined;
  const projection = Object.fromEntries(Object.entries(binding).filter(([key]) => !["observedCommit", "dirtyState"].includes(key)));
  return digest(projection);
}

function grantFile(grantId: string): string {
  return path.join(delegationSubdir("grants"), `${digest(grantId).slice(0, 48)}.json`);
}

function reservationFile(reservationId: string): string {
  return path.join(delegationSubdir("reservations"), `${digest(reservationId).slice(0, 48)}.json`);
}

function grantLock(grantId: string): string {
  return path.join(delegationSubdir("locks"), `${digest(`grant:${grantId}`).slice(0, 48)}.lock`);
}

function auditLock(grantId: string): string {
  return path.join(delegationSubdir("locks"), `${digest(`audit:${grantId}`).slice(0, 48)}.lock`);
}

function auditFile(grantId: string): string {
  return path.join(delegationSubdir("audit"), `${digest(grantId).slice(0, 48)}.json`);
}

function reservationAuditReference(grantId: string, reservationId: string, decisionInstanceId: string): string {
  return `a1-audit-${digest({ grantId, reservationId, decisionInstanceId }).slice(0, 48)}`;
}

function appendAudit(entry: DelegationAuditEntry): void {
  // All lifecycle writers use the same per-grant audit lease. Grant callers
  // already hold the grant lease (grant -> audit ordering); denial/correlation
  // writers only need the audit lease. This prevents lost updates without
  // creating an audit -> grant lock inversion.
  const lease = acquireLease(auditLock(entry.grantId));
  try {
    const file = auditFile(entry.grantId);
    const existingResult = readStrictJsonFile<DelegationAuditEntry[]>(file);
    const existing = existingResult.status === "OK" && Array.isArray(existingResult.value) ? existingResult.value : [];
    let grant: DelegationGrant | null = null;
    try { grant = loadDelegationGrant(entry.grantId); } catch { /* preserve the lifecycle evidence even if the grant is unavailable */ }
    const enriched: DelegationAuditEntry = {
      ...entry,
      ...(entry.grantGeneration === undefined && grant ? { grantGeneration: grant.generation } : {}),
      ...(entry.approvalDecisionId === undefined && grant ? { approvalDecisionId: grant.approval.decisionId } : {}),
      ...(entry.approvalDigest === undefined && grant ? { approvalDigest: grant.approval.approvedDigest } : {}),
      ...(entry.scopeDigest === undefined && grant ? { scopeDigest: grant.scopeDigest } : {}),
      ...(entry.targetDigest === undefined && grant ? { targetDigest: grant.targetDigest } : {}),
      ...(entry.auditReference ? {} : { auditReference: `a1-audit-${digest({ grantId: entry.grantId, reservationId: entry.reservationId ?? null, at: entry.at, decision: entry.decision }).slice(0, 48)}` }),
    };
    writeAtomicSecureJson(file, [...existing, enriched]);
  } finally {
    lease.release();
  }
}

/** Append a sanitized lifecycle link without exposing the raw control message. */
export function recordDelegationAudit(entry: DelegationAuditEntry): void {
  appendAudit(entry);
}

export function readDelegationAudit(grantId: string): DelegationAuditEntry[] {
  const result = readStrictJsonFile<DelegationAuditEntry[]>(auditFile(grantId));
  return result.status === "OK" && Array.isArray(result.value) ? result.value : [];
}

export interface DelegationApprovalContract {
  policyVersion: string;
  action: DelegatedAction;
  scope: DelegationScope;
  target: DelegationTarget;
  providerRequirement?: ProviderContractRequirement;
  notBefore: string;
  expiresAt: string;
  maxUses: number;
  supersedesGrantIds?: string[];
}

/** Digest the complete immutable grant contract, not only its common scope. */
export function delegationApprovalDigest(contract: DelegationApprovalContract): string {
  return digest({
    policyVersion: contract.policyVersion,
    action: contract.action,
    scope: contract.scope,
    target: contract.target,
    ...(contract.providerRequirement ? { providerRequirement: contract.providerRequirement } : {}),
    notBefore: contract.notBefore,
    expiresAt: contract.expiresAt,
    maxUses: contract.maxUses,
    ...(contract.supersedesGrantIds ? { supersedesGrantIds: contract.supersedesGrantIds } : {}),
  });
}

/** Digest the exact durable decision that authorizes one grant revocation. */
export function delegationRevocationDigest(grantId: string, reason?: string): string {
  const normalizedReason = bounded(reason, 256);
  return digest({
    kind: "delegation_revocation",
    grantId: normalizedText(grantId, "grantId")!,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });
}

function canonicalApprovalScalar(state: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return state.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`, "m"))?.[1]
    ?.replace(/^['\"]|['\"]$/g, "").trim() || undefined;
}

interface CanonicalDelegationApprovalRecord {
  decisionId?: string;
  approvedDigest?: string;
  action?: string;
  scopeDigest?: string;
  targetDigest?: string;
  approvedAt?: string;
  approverIdentityRef?: string;
}

/**
 * Read the small, deliberately bounded YAML subset used for grant decisions.
 * The canonical state may keep one legacy `delegation_approval` record or an
 * append-only `delegation_approvals` sequence.  This is not a general YAML
 * parser: it only accepts scalar fields from the named state section, so
 * nested/unrelated state cannot accidentally become approval evidence.
 */
function canonicalDelegationApprovalRecords(state: string): CanonicalDelegationApprovalRecord[] {
  const lines = state.split(/\r?\n/);
  const records: CanonicalDelegationApprovalRecord[] = [];
  for (const key of ["delegation_approval", "delegation_approvals"] as const) {
    const header = lines.findIndex((line) => new RegExp(`^[ \\t]*${key}:\s*(?:\\[\\])?\\s*$`).test(line));
    if (header < 0) continue;
    const headerIndent = lines[header].match(/^[ \\t]*/)?.[0].length ?? 0;
    const section: string[] = [];
    for (let index = header + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && (line.match(/^[ \\t]*/)?.[0].length ?? 0) <= headerIndent) break;
      section.push(line);
    }
    let current: CanonicalDelegationApprovalRecord | undefined;
    const push = (): void => {
      if (current && Object.keys(current).length > 0) records.push(current);
      current = undefined;
    };
    for (const line of section) {
      const item = line.match(/^\s*-\s*(?:(decision_id|approved_digest|action|scope_digest|target_digest|approved_at|approver_identity_ref):\s*(.*))?$/);
      if (item) {
        push();
        current = {};
        if (item[1]) current[item[1].replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof CanonicalDelegationApprovalRecord] = item[2]
          ?.replace(/^['\"]|['\"]$/g, "").trim();
        continue;
      }
      const scalar = line.match(/^\s+(decision_id|approved_digest|action|scope_digest|target_digest|approved_at|approver_identity_ref):\s*(.*?)\s*$/);
      if (!scalar) continue;
      if (!current) current = {};
      current[scalar[1].replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof CanonicalDelegationApprovalRecord] = scalar[2]
        .replace(/^['\"]|['\"]$/g, "").trim();
    }
    push();
  }
  return records;
}

function verifyAuthoritativeApproval(input: DelegationApprovalProvenance, contract: DelegationApprovalContract): void {
  const statePath = path.resolve(input.workflowStatePath);
  if (path.basename(statePath) !== "state.yaml" || !statePath.includes(`${path.sep}.harness${path.sep}`) || !fs.existsSync(statePath)) {
    throw new Error("grant approval must reference an existing canonical workflow state");
  }
  if (path.basename(path.dirname(statePath)) !== contract.scope.workstreamId) {
    throw new Error("grant approval workstream does not match the delegated scope");
  }
  const state = fs.readFileSync(statePath, "utf8");
  if (!/step4_approval:[\s\S]*?approved:\s*true/.test(state)) {
    throw new Error("grant approval is not recorded by the canonical Human Gate state");
  }
  const stateCheckpoint = canonicalApprovalScalar(state, "checkpoint");
  if (stateCheckpoint && stateCheckpoint !== input.checkpoint) {
    throw new Error("grant approval checkpoint does not match canonical state");
  }
  const approvalSection = state.split(/^[ \t]*step4_approval:[ \t]*$/m)[1]?.split(/^\S/m)[0] ?? state;
  const matching = canonicalDelegationApprovalRecords(state).filter((item) => item.decisionId === input.decisionId);
  if (matching.length !== 1) throw new Error(matching.length === 0 ? "canonical state has no grant-specific delegation approval record" : "canonical state has ambiguous duplicate grant approval records");
  const exact = matching[0];
  const recordedDecisionId = exact.decisionId;
  const recordedDigest = exact.approvedDigest;
  const recordedAction = exact.action;
  const recordedScopeDigest = exact.scopeDigest;
  const recordedTargetDigest = exact.targetDigest;
  const expectedDigest = delegationApprovalDigest(contract);
  if (recordedDecisionId !== input.decisionId || recordedDigest !== expectedDigest || recordedAction !== contract.action || recordedScopeDigest !== delegationScopeDigest(contract.scope) || recordedTargetDigest !== targetDigest(contract.target)) {
    throw new Error("canonical state does not record this exact grant decision");
  }
  if (!exact.approvedAt || !exact.approverIdentityRef) throw new Error("canonical grant approval record is missing timestamp or approver");
  if (exact.approvedAt !== input.approvedAt) {
    throw new Error("grant decision timestamp does not match canonical state");
  }
  if (exact.approverIdentityRef !== input.approverIdentityRef) {
    throw new Error("grant decision approver does not match canonical state");
  }
  if (contract.scope) {
    const workspaceId = canonicalApprovalScalar(state, "workspace_id") ?? canonicalApprovalScalar(state, "verified_workspace_id");
    if (workspaceId && workspaceId !== contract.scope.workspaceId) throw new Error("grant approval workspace does not match the delegated scope");
  }
}

interface CanonicalDelegationRevocationRecord {
  decisionId?: string;
  grantId?: string;
  checkpoint?: string;
  approvedDigest?: string;
  approvedAt?: string;
  approverIdentityRef?: string;
  reason?: string;
}

/** Read only the bounded append-only revocation section from canonical state. */
function canonicalDelegationRevocationRecords(state: string): CanonicalDelegationRevocationRecord[] {
  const lines = state.split(/\r?\n/);
  const header = lines.findIndex((line) => /^[ \t]*delegation_revocations:\s*(?:\[\])?\s*$/.test(line));
  if (header < 0) return [];
  const headerIndent = lines[header].match(/^[ \t]*/)?.[0].length ?? 0;
  const section: string[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && (line.match(/^[ \t]*/)?.[0].length ?? 0) <= headerIndent) break;
    section.push(line);
  }
  const records: CanonicalDelegationRevocationRecord[] = [];
  let current: CanonicalDelegationRevocationRecord | undefined;
  const push = (): void => {
    if (current && Object.keys(current).length > 0) records.push(current);
    current = undefined;
  };
  for (const line of section) {
    const item = line.match(/^\s*-\s*(?:(decision_id|grant_id|checkpoint|approved_digest|approved_at|approver_identity_ref|reason):\s*(.*))?$/);
    if (item) {
      push();
      current = {};
      if (item[1]) current[item[1].replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof CanonicalDelegationRevocationRecord] = item[2]
        ?.replace(/^['\"]|['\"]$/g, "").trim();
      continue;
    }
    const scalar = line.match(/^\s+(decision_id|grant_id|checkpoint|approved_digest|approved_at|approver_identity_ref|reason):\s*(.*?)\s*$/);
    if (!scalar) continue;
    if (!current) current = {};
    current[scalar[1].replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof CanonicalDelegationRevocationRecord] = scalar[2]
      .replace(/^['\"]|['\"]$/g, "").trim();
  }
  push();
  return records;
}

function verifyAuthoritativeRevocation(input: DelegationRevocationProvenance, grant: DelegationGrant): void {
  const statePath = path.resolve(input.workflowStatePath);
  if (path.basename(statePath) !== "state.yaml" || !statePath.includes(`${path.sep}.harness${path.sep}`) || !fs.existsSync(statePath)) {
    throw new Error("revocation approval must reference an existing canonical workflow state");
  }
  if (path.basename(path.dirname(statePath)) !== grant.scope.workstreamId) {
    throw new Error("revocation approval workstream does not match the grant");
  }
  const state = fs.readFileSync(statePath, "utf8");
  const stateCheckpoint = canonicalApprovalScalar(state, "checkpoint");
  if (stateCheckpoint && stateCheckpoint !== input.checkpoint) {
    throw new Error("revocation approval checkpoint does not match canonical state");
  }
  const matching = canonicalDelegationRevocationRecords(state).filter((item) => item.decisionId === input.decisionId);
  if (matching.length !== 1) throw new Error(matching.length === 0 ? "canonical state has no grant-specific revocation decision" : "canonical state has ambiguous duplicate revocation decisions");
  const exact = matching[0];
  const reason = bounded(input.reason, 256);
  const expectedDigest = delegationRevocationDigest(grant.grantId, reason);
  if (exact.decisionId !== input.decisionId || exact.grantId !== grant.grantId || exact.checkpoint !== input.checkpoint || exact.approvedDigest !== expectedDigest || input.approvedDigest !== expectedDigest || bounded(exact.reason, 256) !== reason) {
    throw new Error("canonical state does not record this exact grant revocation decision");
  }
  if (!exact.approvedAt || !exact.approverIdentityRef) throw new Error("canonical revocation decision is missing timestamp or approver");
  if (exact.approvedAt !== input.approvedAt) throw new Error("revocation decision timestamp does not match canonical state");
  if (exact.approverIdentityRef !== input.approverIdentityRef) throw new Error("revocation decision approver does not match canonical state");
}

/** Verify a durable canonical revocation decision before a lifecycle mutation. */
export function assertAuthoritativeRevocation(grantOrId: DelegationGrant | string, input: DelegationRevocationProvenance): void {
  const id = typeof grantOrId === "string" ? grantOrId : grantOrId.grantId;
  const grant = typeof grantOrId === "string" ? loadDelegationGrant(id) : grantOrId;
  if (!grant) throw new Error("delegation grant is not known");
  const normalized: DelegationRevocationProvenance = {
    workflowStatePath: normalizedText(input.workflowStatePath, "revocation approval workflowStatePath")!,
    checkpoint: normalizedText(input.checkpoint, "revocation approval checkpoint")!,
    decisionId: normalizedText(input.decisionId, "revocation approval decisionId")!,
    approverIdentityRef: normalizedText(input.approverIdentityRef, "revocation approval approverIdentityRef")!,
    approvedAt: normalizedText(input.approvedAt, "revocation approval approvedAt")!,
    approvedDigest: normalizedText(input.approvedDigest, "revocation approval approvedDigest")!,
    grantId: normalizedText(input.grantId, "revocation approval grantId")!,
    ...(bounded(input.reason, 256) ? { reason: bounded(input.reason, 256) } : {}),
  };
  if (normalized.grantId !== grant.grantId || !Number.isFinite(Date.parse(normalized.approvedAt))) throw new Error("revocation approval identity or timestamp is invalid");
  verifyAuthoritativeRevocation(normalized, grant);
}

function normalizeApproval(input: DelegationApprovalProvenance | undefined, contract: DelegationApprovalContract): DelegationApprovalProvenance {
  if (!input) throw new Error("grant-specific approval provenance is required");
  const result: DelegationApprovalProvenance = {
    workflowStatePath: normalizedText(input.workflowStatePath, "approval workflowStatePath")!,
    checkpoint: normalizedText(input.checkpoint, "approval checkpoint")!,
    decisionId: normalizedText(input.decisionId, "approval decisionId")!,
    approverIdentityRef: normalizedText(input.approverIdentityRef, "approval approverIdentityRef")!,
    approvedAt: normalizedText(input.approvedAt, "approval approvedAt")!,
    approvedDigest: normalizedText(input.approvedDigest, "approval approvedDigest")!,
  };
  if (!Number.isFinite(Date.parse(result.approvedAt))) throw new Error("approval timestamp is invalid");
  verifyAuthoritativeApproval(result, contract);
  const expectedDigest = delegationApprovalDigest(contract);
  if (result.approvedDigest !== expectedDigest) throw new Error(`approval digest does not match ${contract.action} authorization contract`);
  return result;
}

function normalizeProviderRequirement(action: DelegatedAction, requirement: ProviderContractRequirement | undefined): ProviderContractRequirement | undefined {
  if (!requirement) return undefined;
  if (action !== "operation_reconcile") throw new Error("provider requirements are irrelevant for this action");
  if (requirement.source !== "teamai" || requirement.skillName !== "github-cli-auth" || !bounded(requirement.capabilityVersion) || !bounded(requirement.expectedAccount)) throw new Error("provider contract is invalid");
  return {
    source: "teamai",
    skillName: "github-cli-auth",
    capabilityVersion: bounded(requirement.capabilityVersion)!,
    expectedAccount: bounded(requirement.expectedAccount)!,
    ...(bounded(requirement.minCapabilityVersion) ? { minCapabilityVersion: bounded(requirement.minCapabilityVersion) } : {}),
    ...(bounded(requirement.maxCapabilityVersion) ? { maxCapabilityVersion: bounded(requirement.maxCapabilityVersion) } : {}),
  };
}

function grantStatus(grant: DelegationGrant, now: number): DelegationGrantStatus {
  if (grant.status === "REVOKED" || grant.status === "SUPERSEDED") return grant.status;
  if (Date.parse(grant.expiresAt) <= now) return "EXPIRED";
  return grant.status;
}

export function saveDelegationGrant(grant: DelegationGrant): DelegationGrant {
  writeAtomicSecureJson(grantFile(grant.grantId), grant);
  return grant;
}

export function loadDelegationGrant(grantId: string): DelegationGrant | null {
  if (!bounded(grantId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(grantId)) return null;
  const result = readStrictJsonFile<DelegationGrant>(grantFile(grantId));
  if (result.status === "MISSING") return null;
  if (result.status !== "OK" || !result.value) throw new Error("unsupported or corrupt delegation grant record");
  const grant = result.value;
  try {
    if (grant.grantId !== grantId) throw new Error("grant identity mismatch");
    assertGrantIntegrity(grant);
  } catch {
    throw new Error("unsupported or forged delegation grant record");
  }
  return grant;
}

export const readDelegationGrant = loadDelegationGrant;

function assertGrantIntegrity(grant: DelegationGrant): void {
  if (grant.schemaVersion !== 1 || !grant.grantId || !isDelegatedAction(grant.action) || grant.policyVersion !== DELEGATION_POLICY_VERSION || !grant.target || typeof grant.targetDigest !== "string") throw new Error("unsupported delegation grant schema or policy");
  const scope = normalizeDelegationScope(grant.scope, grant.action);
  const target = normalizeDelegationTarget(grant.action, grant.target);
  if (grant.scopeDigest !== delegationScopeDigest(scope) || grant.targetDigest !== targetDigest(target)) throw new Error("grant digest mismatch");
  const providerRequirement = normalizeProviderRequirement(grant.action, grant.providerRequirement);
  const expectedApproval = delegationApprovalDigest({
    policyVersion: grant.policyVersion,
    action: grant.action,
    scope,
    target,
    ...(providerRequirement ? { providerRequirement } : {}),
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
    maxUses: grant.maxUses,
    ...(grant.supersedesGrantIds ? { supersedesGrantIds: grant.supersedesGrantIds } : {}),
  });
  verifyAuthoritativeApproval(grant.approval, {
    policyVersion: grant.policyVersion,
    action: grant.action,
    scope,
    target,
    ...(providerRequirement ? { providerRequirement } : {}),
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
    maxUses: grant.maxUses,
    ...(grant.supersedesGrantIds ? { supersedesGrantIds: grant.supersedesGrantIds } : {}),
  });
  if (grant.approval.approvedDigest !== expectedApproval) throw new Error("grant approval digest mismatch");
}

export function createDelegationGrant(input: CreateDelegationGrantInput): DelegationGrant {
  if (!isDelegatedAction(input.action)) throw new Error("unsupported delegated action");
  const action = input.action;
  const scope = normalizeDelegationScope(input.scope, action);
  const scopeHash = delegationScopeDigest(scope);
  const target = normalizeDelegationTarget(action, input.target);
  const targetHash = targetDigest(target);
  const now = clockMs(input.clock);
  const createdAt = input.createdAt ?? new Date(now).toISOString();
  const notBefore = input.notBefore ?? createdAt;
  const expiresAt = input.expiresAt ?? new Date(now + DELEGATION_POLICY_DEFAULTS.lifetimeMs).toISOString();
  const createdMs = Date.parse(createdAt);
  const notBeforeMs = Date.parse(notBefore);
  const expiresMs = Date.parse(expiresAt);
  if (![createdMs, notBeforeMs, expiresMs].every(Number.isFinite) || expiresMs <= notBeforeMs || expiresMs - notBeforeMs > MAX_GRANT_LIFETIME_MS) throw new Error("grant lifetime is invalid");
  const maxUses = input.maxUses ?? maxUsesForAction(action, input.singleUse === true);
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > maxUsesForAction(action, false)) throw new Error("grant use budget is invalid");
  const providerRequirement = normalizeProviderRequirement(action, input.providerRequirement);
  if (action === "operation_reconcile" && input.persistedOperation) {
    const pathValue = deriveOperationEvidencePath(input.persistedOperation);
    if (policyIsProviderDependentPath(pathValue) && !providerRequirement) throw new Error("provider-bound operation grant requires provider contract");
    if (!policyIsProviderDependentPath(pathValue) && providerRequirement) throw new Error("local operation grant cannot carry provider contract");
  }
  const approval = normalizeApproval(input.approval ?? input.approvalProvenance, {
    policyVersion: DELEGATION_POLICY_VERSION,
    action,
    scope,
    target,
    ...(providerRequirement ? { providerRequirement } : {}),
    notBefore,
    expiresAt,
    maxUses,
    ...(input.supersedesGrantIds ? { supersedesGrantIds: input.supersedesGrantIds } : {}),
  });
  const grant: DelegationGrant = {
    schemaVersion: 1,
    policyVersion: DELEGATION_POLICY_VERSION,
    grantId: input.grantId ?? `a1-${randomUUID()}`,
    generation: 0,
    createdAt,
    notBefore,
    expiresAt,
    action,
    route: routeForAction(action),
    scope,
    scopeDigest: scopeHash,
    target,
    targetDigest: targetHash,
    approval,
    maxUses,
    useCount: 0,
    status: "APPROVED_ACTIVE",
    ...(providerRequirement ? { providerRequirement } : {}),
    ...(input.supersedesGrantIds ? { supersedesGrantIds: input.supersedesGrantIds } : {}),
  };
  if (input.persist !== false) saveDelegationGrant(grant);
  appendAudit({ at: new Date(now).toISOString(), grantId: grant.grantId, action, scopeDigest: scopeHash, targetDigest: targetHash, grantGeneration: grant.generation, approvalDecisionId: grant.approval.decisionId, approvalDigest: grant.approval.approvedDigest, decision: "ALLOW" });
  return grant;
}

export const createDelegationGrantFromApproval = createDelegationGrant;

export function revokeDelegationGrant(grantOrId: DelegationGrant | string, input: RevokeDelegationInput = {}): DelegationGrant {
  const id = typeof grantOrId === "string" ? grantOrId : grantOrId.grantId;
  return withGrantLock(id, input.clock, () => {
    const grant = loadDelegationGrant(id);
    if (!grant) throw new Error("delegation grant is not known");
    if (input.approval) assertAuthoritativeRevocation(grant, input.approval);
    grant.generation += 1;
    grant.status = "REVOKED";
    grant.revokedAt = new Date(clockMs(input.clock)).toISOString();
    grant.revocationReason = bounded(input.reason ?? input.approval?.reason, 256);
    saveDelegationGrant(grant);
    appendAudit({ at: grant.revokedAt, grantId: grant.grantId, action: grant.action, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: grant.targetDigest, decision: "REVOKED", reason: grant.revocationReason, revocationEvidence: input.approval ? `${input.approval.decisionId}:${input.approval.approvedDigest}` : grant.revocationReason });
    return grant;
  });
}

export function supersedeDelegationGrant(grantOrId: DelegationGrant | string, replacement: DelegationGrant): DelegationGrant {
  const id = typeof grantOrId === "string" ? grantOrId : grantOrId.grantId;
  return withGrantLock(id, undefined, () => {
    const grant = loadDelegationGrant(id);
    const durableReplacement = loadDelegationGrant(replacement.grantId);
    if (!grant || !durableReplacement || replacement.grantId === grant.grantId || !durableReplacement.supersedesGrantIds?.includes(grant.grantId)) throw new Error("delegation supersession identity is invalid");
    grant.generation += 1;
    grant.status = "SUPERSEDED";
    grant.supersededBy = replacement.grantId;
    saveDelegationGrant(grant);
    appendAudit({ at: new Date().toISOString(), grantId: grant.grantId, action: grant.action, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: grant.targetDigest, decision: "SUPERSEDED", supersessionEvidence: durableReplacement.grantId });
    return grant;
  });
}

function makeReservationId(grant: DelegationGrant, action: DelegatedAction, target: DelegationTarget): string {
  if (action === "c2c_transport") return digest(`${grant.grantId}:${grant.generation}:${targetDigest(target)}:${(target as TransportDelegationTarget).eventKey}`);
  return randomUUID();
}

function persistReservation(reservation: DelegationReservation): DelegationReservation {
  writeAtomicSecureJson(reservationFile(reservation.reservationId), reservation);
  appendAudit({ at: reservation.updatedAt, grantId: reservation.grantId, action: reservation.action, grantGeneration: reservation.grantGeneration, targetDigest: reservation.targetDigest, decision: reservation.state, reservationId: reservation.reservationId, reservationState: reservation.state, commitReference: reservation.commitReference, auditReference: reservation.auditReference });
  return reservation;
}

export function loadDelegationReservation(reservationId: string): DelegationReservation | null {
  const result = readStrictJsonFile<DelegationReservation>(reservationFile(reservationId));
  if (result.status === "MISSING") return null;
  if (result.status !== "OK" || !result.value || result.value.schemaVersion !== 1) throw new Error("unsupported or corrupt delegation reservation record");
  return result.value;
}

export const readDelegationReservation = loadDelegationReservation;

export function reserveGrant(grantOrId: DelegationGrant | string, action: DelegatedAction, target: DelegationTarget, options: { decisionInstanceId?: string; clock?: DelegationClock } = {}): DelegationReservation {
  const id = typeof grantOrId === "string" ? grantOrId : grantOrId.grantId;
  return withGrantLock(id, options.clock, () => {
    const grant = loadDelegationGrant(id);
    if (!grant) throw new Error("delegation grant is not known");
    const now = clockMs(options.clock);
    if (grantStatus(grant, now) !== "APPROVED_ACTIVE") throw new Error("delegation grant is not active");
    if (grant.useCount >= grant.maxUses) throw new Error("delegation grant use budget is exhausted");
    const reservationId = makeReservationId(grant, action, target);
    const existing = loadDelegationReservation(reservationId);
    if (existing) {
      if (existing.grantId !== grant.grantId || existing.grantGeneration !== grant.generation || existing.targetDigest !== targetDigest(target)) throw new Error("delegation reservation identity conflict");
      return existing;
    }
    const timestamp = new Date(now).toISOString();
    const decisionInstanceId = options.decisionInstanceId ?? randomUUID();
    return persistReservation({
      schemaVersion: 1,
      reservationId,
      grantId: grant.grantId,
      grantGeneration: grant.generation,
      decisionInstanceId,
      action,
      targetDigest: targetDigest(target),
      state: "RESERVED",
      createdAt: timestamp,
      updatedAt: timestamp,
      auditReference: reservationAuditReference(grant.grantId, reservationId, decisionInstanceId),
    });
  });
}

/** Run a transport commit while the event-first coordinator owns the grant lease. */
export function withDelegationGrantLease<T>(grantId: string, clock: DelegationClock | undefined, action: () => T): T {
  return withGrantLock(grantId, clock, action);
}

/** Revalidate a pre-commit reservation under the grant CAS boundary. */
function assertDelegationReservationCommitReadyLocked(reservationOrId: DelegationReservation | string, action: DelegatedAction, target: DelegationTarget, clock?: DelegationClock): DelegationReservation {
  const reservationId = typeof reservationOrId === "string" ? reservationOrId : reservationOrId.reservationId;
  const reservation = loadDelegationReservation(reservationId);
  if (!reservation) throw new Error("delegation reservation is not known");
  const current = loadDelegationReservation(reservationId);
  const grant = loadDelegationGrant(reservation.grantId);
  const now = clockMs(clock);
  if (!current || !grant || current.state !== "RESERVED" || current.action !== action || current.targetDigest !== targetDigest(target)) throw new Error("delegation reservation is no longer ready to commit");
  if (current.grantGeneration !== grant.generation || grant.targetDigest !== targetDigest(target) || grantStatus(grant, now) !== "APPROVED_ACTIVE" || now < Date.parse(grant.notBefore) || now >= Date.parse(grant.expiresAt)) throw new Error("delegation grant is no longer applicable at commit");
  return current;
}

export function assertDelegationReservationCommitReady(reservationOrId: DelegationReservation | string, action: DelegatedAction, target: DelegationTarget, clock?: DelegationClock): DelegationReservation {
  const reservation = loadDelegationReservation(typeof reservationOrId === "string" ? reservationOrId : reservationOrId.reservationId);
  if (!reservation) throw new Error("delegation reservation is not known");
  return withGrantLock(reservation.grantId, clock, () => assertDelegationReservationCommitReadyLocked(reservation, action, target, clock));
}

/** Internal coordinator seam; the caller must already own the grant lease. */
export function assertDelegationReservationCommitReadyOwnedLease(reservation: DelegationReservation, action: DelegatedAction, target: DelegationTarget, clock?: DelegationClock): DelegationReservation {
  return assertDelegationReservationCommitReadyLocked(reservation, action, target, clock);
}

/** Trusted recovery seam: only a runtime-held reservation handle may call this. */
export function recoverDelegationReservation(reservationId: string, action: DelegatedAction, target: DelegationTarget, clock?: DelegationClock): DelegationReservation {
  const reservation = loadDelegationReservation(reservationId);
  if (!reservation || reservation.action !== action || reservation.targetDigest !== targetDigest(target) || reservation.state !== "RESERVED") throw new Error("delegation recovery identity is not an unfinished reservation");
  return withGrantLock(reservation.grantId, clock, () => {
    const current = loadDelegationReservation(reservationId);
    const grant = loadDelegationGrant(reservation.grantId);
    const now = clockMs(clock);
    if (!current || !grant || current.state !== "RESERVED" || current.action !== action || current.targetDigest !== targetDigest(target)) throw new Error("delegation recovery reservation changed");
    if (current.grantGeneration !== grant.generation || grant.targetDigest !== targetDigest(target) || grantStatus(grant, now) !== "APPROVED_ACTIVE" || now < Date.parse(grant.notBefore) || now >= Date.parse(grant.expiresAt)) throw new Error("delegation recovery grant is no longer applicable");
    return current;
  });
}

export function consumeGrant(reservationOrId: DelegationReservation | string, commitReference?: string, clock?: DelegationClock, options: { recoveryAuthorityId?: string } = {}): DelegationReservation {
  const reservationId = typeof reservationOrId === "string" ? reservationOrId : reservationOrId.reservationId;
  const reservation = loadDelegationReservation(reservationId);
  if (!reservation) throw new Error("delegation reservation is not known");
  return withGrantLock(reservation.grantId, clock, () => {
    const current = loadDelegationReservation(reservationId);
    const grant = loadDelegationGrant(reservation.grantId);
    if (!current || !grant) throw new Error("delegation reservation or grant is missing");
    if (current.state === "CONSUMED") return current;
    if (current.state !== "RESERVED") throw new Error("delegation reservation is not consumable");
    const recovery = Boolean(options.recoveryAuthorityId && commitReference === options.recoveryAuthorityId);
    if (!recovery) {
      const now = clockMs(clock);
      if (current.grantGeneration !== grant.generation || grantStatus(grant, now) !== "APPROVED_ACTIVE" || now < Date.parse(grant.notBefore) || now >= Date.parse(grant.expiresAt)) throw new Error("delegation grant is no longer applicable at commit");
    }
    if (!recovery && grant.useCount >= grant.maxUses) throw new Error("delegation grant use budget is exhausted");
    grant.useCount += 1;
    grant.generation += 1;
    saveDelegationGrant(grant);
    const next = { ...current, grantGeneration: grant.generation, state: "CONSUMED" as const, updatedAt: new Date(clockMs(clock)).toISOString(), ...(commitReference ? { commitReference: bounded(commitReference, 256) } : {}) };
    return persistReservation(next);
  });
}

export function releaseGrant(reservationOrId: DelegationReservation | string, clock?: DelegationClock): DelegationReservation {
  const reservationId = typeof reservationOrId === "string" ? reservationOrId : reservationOrId.reservationId;
  const reservation = loadDelegationReservation(reservationId);
  if (!reservation) throw new Error("delegation reservation is not known");
  return withGrantLock(reservation.grantId, clock, () => {
    const current = loadDelegationReservation(reservationId);
    if (!current) throw new Error("delegation reservation is not known");
    if (current.state === "RELEASED" || current.state === "CONSUMED") return current;
    const next = { ...current, state: "RELEASED" as const, updatedAt: new Date(clockMs(clock)).toISOString() };
    return persistReservation(next);
  });
}

function withGrantLock<T>(grantId: string, clock: DelegationClock | undefined, action: () => T): T {
  const lease = acquireLease(grantLock(grantId), { clock });
  try { return action(); } finally { lease.release(); }
}

function denial(action: string, reason: DelegationDenialReason, extras: Partial<DelegationDecisionProof> = {}): DelegationEvaluation {
  const proofBase = { schemaVersion: 1 as const, decision: "DENY" as const, action, reason, ...extras };
  const proof = { ...proofBase, decisionDigest: digest(proofBase) };
  if (typeof extras.grantId === "string" && extras.grantId) {
    recordDelegationAudit({
      at: new Date().toISOString(),
      grantId: extras.grantId,
      action,
      grantGeneration: extras.grantGeneration,
      scopeDigest: extras.scopeDigest,
      targetDigest: extras.targetDigest,
      bindingDigest: extras.bindingDigest,
      decision: "DENY",
      reason,
      reservationId: extras.reservationId,
    });
  }
  return { proof };
}

function allowProof(input: Omit<DelegationDecisionProof, "schemaVersion" | "decision" | "decisionDigest">): DelegationDecisionProof {
  const proofBase = { schemaVersion: 1 as const, decision: "ALLOW" as const, ...input };
  return { ...proofBase, decisionDigest: digest(proofBase) };
}

function assertActiveBinding(scope: DelegationScope, binding: TransportBindingIdentity | undefined): void {
  if (!binding) throw new Error("delegation evaluation requires an active canonical binding");
  assertActiveCanonicalBinding(binding);
  for (const key of ["workspaceId", "workstreamId", "workspaceRoot", "canonicalRepository", "worktreeRoot", "branch", "stage"] as const) {
    const value = scope[key];
    const actual = binding[key];
    if (typeof actual !== "string" || !actual.trim()) throw new Error(`active canonical binding is incomplete: ${key}`);
    if (value !== undefined && (key === "workspaceRoot" || key === "worktreeRoot" ? path.resolve(actual) !== path.resolve(value) : actual !== value)) {
      throw new Error(`active canonical binding mismatch: ${key}`);
    }
  }
  const optionalFields = [
    "workspaceName", "checkpoint", "taskId", "eventKey", "projectId", "chatId", "connectorName",
    "mcpAppId", "mcpVersionId", "installationId", "endpointFingerprint",
  ] as const;
  for (const key of optionalFields) {
    const value = scope[key];
    if (value !== undefined && binding[key] !== value) throw new Error(`active canonical binding mismatch: ${key}`);
  }
}

function providerFieldsPresent(request: DelegationRequest): boolean {
  const scope = request.scope as Record<string, unknown>;
  const target = request.target as Record<string, unknown>;
  return ["provider", "providerRequirement", "expectedAccount", "account", "capability", "capabilityVersion", "teamai"].some((key) => Object.prototype.hasOwnProperty.call(scope, key) || Object.prototype.hasOwnProperty.call(target, key));
}

function operationEvidence(request: DelegationRequest, target: OperationReconcileDelegationTarget): { operation: GitHubOperationRecord; path: OperationEvidencePath; result: unknown; authorityId?: string; receiptReference?: string } | DelegationEvaluation {
  const operation = readKnownLogicalOperation(target.operationKey);
  if (!operation) return denial(request.action, "OPERATION_NOT_KNOWN", { operationKey: target.operationKey });
  try {
    const receipt = readDeliveryReceiptForOperation(operation.operationKey, operation.target, operation.payloadHash);
    const pathValue = deriveOperationEvidencePath(operation, receipt ? {
      source: "a0-receipt",
      evidencePath: "local_persisted",
      operationEvidence: receipt.operationEvidence,
      receiptState: receipt.state,
      receiptAuthorityId: receipt.authorityId,
    } : undefined);
    const result = receipt?.operationEvidence ?? {
      operationKey: operation.operationKey,
      evidencePath: pathValue,
      target: operation.target,
      payloadHash: operation.payloadHash,
    };
    return { operation, path: pathValue, result, ...(receipt?.authorityId ? { authorityId: receipt.authorityId } : {}), ...(receipt ? { receiptReference: receipt.eventKey } : {}) };
  } catch {
    return denial(request.action, "SCHEMA_UNSUPPORTED", { operationKey: target.operationKey });
  }
}

function classTarget(action: DelegatedAction, input: DelegationRequest): DelegationTarget {
  return normalizeDelegationTarget(action, input.target);
}

export function evaluateDelegation(request: DelegationRequest): DelegationEvaluation {
  return evaluateDelegationInternal(request, true);
}

/** Common proof/query path used by inspection tooling; it never reads a workspace target or consumes a grant use. */
export function evaluateDelegationProof(request: DelegationRequest): DelegationEvaluation {
  return evaluateDelegationInternal(request, false);
}

function evaluateDelegationInternal(request: DelegationRequest, commit: boolean): DelegationEvaluation {
  if (Object.prototype.hasOwnProperty.call(request, "delegationRequired")) return denial(String(request.action), "ACTION_DENIED");
  if (Object.prototype.hasOwnProperty.call(request, "decisionInstanceId")) return denial(String(request.action), "ACTION_DENIED");
  if (!isDelegatedAction(request.action)) return denial(String(request.action), "ACTION_DENIED");
  const action = request.action;
  if (action === "workspace_read" || action === "c2c_transport") {
    if (request.providerEvidence || providerFieldsPresent(request)) return denial(action, "PROVIDER_FIELDS_IRRELEVANT");
  }
  let scope: DelegationScope;
  let target: DelegationTarget;
  try {
    scope = normalizeDelegationScope(request.scope, action);
    target = classTarget(action, request);
    assertActiveBinding(scope, request.activeBinding);
  } catch (error) {
    return denial(action, error instanceof Error && /Human Gate|excluded/.test(error.message) ? "HUMAN_GATE" : "TARGET_DENIED");
  }
  let suppliedGrant: DelegationGrant | null = null;
  try {
    suppliedGrant = request.grant ?? (request.grantId ? loadDelegationGrant(request.grantId) : null);
  } catch {
    return denial(action, "SCHEMA_UNSUPPORTED");
  }
  let grant = suppliedGrant;
  if (suppliedGrant) {
    // Rehydrate the authoritative generation when a caller presents an older
    // in-memory projection after a crash or another process's CAS update.
    let persisted: DelegationGrant | null = null;
    try { persisted = loadDelegationGrant(suppliedGrant.grantId); } catch { return denial(action, "SCHEMA_UNSUPPORTED", { grantId: suppliedGrant.grantId }); }
    if (persisted) grant = persisted;
    else {
      try { assertGrantIntegrity(suppliedGrant); } catch { return denial(action, "INVALID_APPROVAL", { grantId: suppliedGrant.grantId }); }
    }
  }
  if (!grant) return denial(action, "SCHEMA_UNSUPPORTED", { scopeDigest: delegationScopeDigest(scope), targetDigest: targetDigest(target) });
  if (grant.action !== action || grant.scopeDigest !== delegationScopeDigest(scope)) return denial(action, "SCOPE_MISMATCH", { grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: delegationScopeDigest(scope), targetDigest: targetDigest(target) });
  if (grant.targetDigest !== targetDigest(target)) return denial(action, "SCOPE_MISMATCH", { grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: targetDigest(target) });
  const now = clockMs(request.clock);
  const status = grantStatus(grant, now);
  if (status === "EXPIRED") return denial(action, "GRANT_EXPIRED", { grantId: grant.grantId, grantGeneration: grant.generation, expiresAt: grant.expiresAt, now });
  if (status === "REVOKED") return denial(action, "GRANT_REVOKED", { grantId: grant.grantId, grantGeneration: grant.generation });
  if (status === "SUPERSEDED") return denial(action, "GRANT_SUPERSEDED", { grantId: grant.grantId, grantGeneration: grant.generation });
  if (now < Date.parse(grant.notBefore) || now >= Date.parse(grant.expiresAt)) return denial(action, now >= Date.parse(grant.expiresAt) ? "GRANT_EXPIRED" : "TARGET_DENIED", { grantId: grant.grantId, grantGeneration: grant.generation, now, notBefore: grant.notBefore, expiresAt: grant.expiresAt });
  if (grant.useCount >= grant.maxUses) return denial(action, "GRANT_EXHAUSTED", { grantId: grant.grantId, grantGeneration: grant.generation, useCount: grant.useCount, maxUses: grant.maxUses });
  if (action === "operation_reconcile") {
    const opTarget = target as OperationReconcileDelegationTarget;
    const evidence = operationEvidence(request, opTarget);
    if ("proof" in evidence) return evidence;
    if (isProviderDependentPath(evidence.path)) {
      if (!grant.providerRequirement || !request.providerEvidence) return denial(action, "TEAMAI_UNAVAILABLE", { grantId: grant.grantId, operationKey: opTarget.operationKey, evidencePath: evidence.path });
      if (!providerContractMatches(grant.providerRequirement, request.providerEvidence)) return denial(action, "TEAMAI_INCOMPATIBLE", { grantId: grant.grantId, operationKey: opTarget.operationKey, evidencePath: evidence.path });
    } else if (grant.providerRequirement || request.providerEvidence) {
      return denial(action, "PROVIDER_FIELDS_IRRELEVANT", { grantId: grant.grantId, operationKey: opTarget.operationKey, evidencePath: evidence.path });
    }
    if (!commit) {
      const proof = allowProof({ action, route: routeForAction(action), grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: targetDigest(target), bindingDigest: bindingDigest(request.activeBinding), now, notBefore: grant.notBefore, expiresAt: grant.expiresAt, useCount: grant.useCount, maxUses: grant.maxUses, operationKey: opTarget.operationKey, evidencePath: evidence.path, ...(request.providerEvidence && isProviderDependentPath(evidence.path) ? { provider: providerEvidenceProjection(request.providerEvidence) } : {}) });
      return { proof, grant, operation: evidence.operation, target, result: evidence.result };
    }
    let reservation: DelegationReservation;
    try { reservation = reserveGrant(grant, action, target, { clock: request.clock }); } catch { return denial(action, "LEASE_CONFLICT", { grantId: grant.grantId, operationKey: opTarget.operationKey }); }
    const proof = allowProof({ action, route: routeForAction(action), grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: targetDigest(target), bindingDigest: bindingDigest(request.activeBinding), decisionInstanceId: reservation.decisionInstanceId, reservationId: reservation.reservationId, now, notBefore: grant.notBefore, expiresAt: grant.expiresAt, useCount: grant.useCount, maxUses: grant.maxUses, operationKey: opTarget.operationKey, evidencePath: evidence.path, ...(request.providerEvidence && isProviderDependentPath(evidence.path) ? { provider: providerEvidenceProjection(request.providerEvidence) } : {}) });
    try {
      const consumed = consumeGrant(reservation, `operation:${opTarget.operationKey}`, request.clock);
      recordDelegationAudit({
        at: new Date(now).toISOString(),
        grantId: grant.grantId,
        action,
        grantGeneration: consumed.grantGeneration,
        scopeDigest: grant.scopeDigest,
        targetDigest: targetDigest(target),
        decision: "CONSUMED",
        reservationId: consumed.reservationId,
        reservationState: consumed.state,
        commitReference: consumed.commitReference,
        reconciliationReference: opTarget.operationKey,
        ...(evidence.authorityId ? { authorityId: evidence.authorityId } : {}),
        ...(evidence.receiptReference ? { receiptReference: evidence.receiptReference } : {}),
        bindingDigest: proof.bindingDigest,
        auditReference: consumed.auditReference,
      });
      return { proof, grant: loadDelegationGrant(grant.grantId) ?? grant, reservation: consumed, operation: evidence.operation, target, result: evidence.result };
    } catch { return denial(action, "LEASE_CONFLICT", { grantId: grant.grantId, reservationId: reservation.reservationId }); }
  }
  if (!commit) {
    const proof = allowProof({ action, route: routeForAction(action), grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: targetDigest(target), bindingDigest: bindingDigest(request.activeBinding), now, notBefore: grant.notBefore, expiresAt: grant.expiresAt, useCount: grant.useCount, maxUses: grant.maxUses });
    return { proof, grant, target };
  }
  let reservation: DelegationReservation;
  try { reservation = reserveGrant(grant, action, target, { clock: request.clock }); } catch { return denial(action, "LEASE_CONFLICT", { grantId: grant.grantId }); }
  const proof = allowProof({ action, route: routeForAction(action), grantId: grant.grantId, grantGeneration: grant.generation, scopeDigest: grant.scopeDigest, targetDigest: targetDigest(target), bindingDigest: bindingDigest(request.activeBinding), decisionInstanceId: reservation.decisionInstanceId, reservationId: reservation.reservationId, now, notBefore: grant.notBefore, expiresAt: grant.expiresAt, useCount: grant.useCount, maxUses: grant.maxUses });
  if (action === "workspace_read") {
    try {
      const result = evaluateWorkspaceReadTarget(scope, target as WorkspaceReadDelegationTarget);
      const consumed = consumeGrant(reservation, `workspace:${(target as WorkspaceReadDelegationTarget).operation}`, request.clock);
      recordDelegationAudit({
        at: new Date(now).toISOString(),
        grantId: grant.grantId,
        action,
        grantGeneration: consumed.grantGeneration,
        scopeDigest: grant.scopeDigest,
        targetDigest: targetDigest(target),
        decision: "CONSUMED",
        reservationId: consumed.reservationId,
        reservationState: consumed.state,
        commitReference: consumed.commitReference,
        reconciliationReference: `workspace:${(target as WorkspaceReadDelegationTarget).operation}`,
        bindingDigest: proof.bindingDigest,
        auditReference: consumed.auditReference,
      });
      return { proof, grant: loadDelegationGrant(grant.grantId) ?? grant, reservation: consumed, target, result };
    } catch (error) {
      try { releaseGrant(reservation, request.clock); } catch { /* preserve the typed denial */ }
      return denial(action, error instanceof Error && /escape|target|file|directory/.test(error.message) ? "TARGET_DENIED" : "LEASE_CONFLICT", { grantId: grant.grantId, reservationId: reservation.reservationId });
    }
  }
  const permit = delegatedTransportPermitFromReference({ grantId: grant.grantId, grantGeneration: grant.generation, reservationId: reservation.reservationId, decisionDigest: proof.decisionDigest });
  return { proof, grant, reservation, target, permit };
}

export function evaluateC2cTransport(request: DelegationRequest): DelegationEvaluation {
  if (request.action !== "c2c_transport") return denial(String(request.action), "ACTION_DENIED");
  return evaluateDelegation(request);
}

export function evaluateWorkspaceRead(request: DelegationRequest): DelegationEvaluation {
  if (request.action !== "workspace_read") return denial(String(request.action), "ACTION_DENIED");
  return evaluateDelegation(request);
}

export function evaluateOperationReconcile(request: DelegationRequest): DelegationEvaluation {
  if (request.action !== "operation_reconcile") return denial(String(request.action), "ACTION_DENIED");
  return evaluateDelegation(request);
}

export interface DelegationAuthorityReference {
  grantId: string;
  grantGeneration: number;
  reservationId: string;
  decisionDigest: string;
}

export function delegatedTransportPermitFromReference(reference: DelegationAuthorityReference): DelegatedTransportPermit {
  return Object.freeze({
    [PERMIT]: true as const,
    grantId: reference.grantId,
    grantGeneration: reference.grantGeneration,
    reservationId: reference.reservationId,
    decisionDigest: reference.decisionDigest,
  });
}

/** Rehydrate an exact persisted A0 transport decision after a process crash. */
export function recoverDelegatedTransport(request: DelegationRequest, reference: DelegationAuthorityReference): DelegationEvaluation | null {
  if (request.action !== "c2c_transport" || request.providerEvidence || providerFieldsPresent(request)) return null;
  if (Object.prototype.hasOwnProperty.call(request, "delegationRequired") || Object.prototype.hasOwnProperty.call(request, "decisionInstanceId")) return null;
  try {
    const scope = normalizeDelegationScope(request.scope, "c2c_transport");
    const target = normalizeDelegationTarget("c2c_transport", request.target);
    assertActiveBinding(scope, request.activeBinding);
    const grant = loadDelegationGrant(reference.grantId);
    const reservation = loadDelegationReservation(reference.reservationId);
    if (!grant || !reservation || grant.action !== "c2c_transport" || grant.scopeDigest !== delegationScopeDigest(scope) || grant.targetDigest !== targetDigest(target) || reservation.grantId !== reference.grantId || reservation.action !== "c2c_transport" || reservation.targetDigest !== targetDigest(target) || request.grantId && request.grantId !== reference.grantId || request.grant && request.grant.grantId !== reference.grantId) return null;
    const proofBase = {
      schemaVersion: 1 as const,
      decision: "ALLOW" as const,
      action: "c2c_transport" as const,
      route: routeForAction("c2c_transport"),
      grantId: grant.grantId,
      grantGeneration: reference.grantGeneration,
      scopeDigest: grant.scopeDigest,
      targetDigest: targetDigest(target),
      bindingDigest: bindingDigest(request.activeBinding),
      decisionInstanceId: reservation.decisionInstanceId,
      reservationId: reservation.reservationId,
      now: clockMs(request.clock),
      notBefore: grant.notBefore,
      expiresAt: grant.expiresAt,
      useCount: grant.useCount,
      maxUses: grant.maxUses,
    } satisfies Omit<DelegationDecisionProof, "decisionDigest">;
    return {
      proof: { ...proofBase, decisionDigest: reference.decisionDigest },
      grant,
      reservation,
      target,
      permit: delegatedTransportPermitFromReference(reference),
    };
  } catch {
    return null;
  }
}

export function isDelegatedTransportPermit(value: unknown): value is DelegatedTransportPermit {
  return !!value && typeof value === "object" && (value as { [PERMIT]?: unknown })[PERMIT] === true;
}

export function assertDelegatedTransportPermit(value: unknown): asserts value is DelegatedTransportPermit {
  if (!isDelegatedTransportPermit(value)) throw new Error("delegated transport requires an evaluator-issued permit");
}

function evaluateWorkspaceReadTarget(scope: DelegationScope, target: WorkspaceReadDelegationTarget): unknown {
  const root = scope.worktreeRoot || scope.workspaceRoot;
  if (!root) return { operation: target.operation };
  const workspace = new Workspace(root);
  if (target.operation === "status") return { operation: "status", status: gitStatus(workspace) };
  const start = workspace.resolve(target.path ?? ".");
  if (target.operation === "search") {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const query = target.query!.toLowerCase();
    const walk = (directory: string): void => {
      if (matches.length >= 100) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= 100 || entry.isSymbolicLink()) continue;
        const abs = path.join(directory, entry.name);
        const rel = path.relative(workspace.root, abs).split(path.sep).join("/");
        if (workspace.ignoreRules.isHidden(rel) || workspace.ignoreRules.isHidden(`${rel}/`)) continue;
        if (entry.isDirectory()) { walk(abs); continue; }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(abs);
        if (stat.size > Math.min(target.maxBytes ?? 256 * 1024, 2 * 1024 * 1024)) continue;
        const content = fs.readFileSync(abs, "utf8");
        if (content.includes("\0")) continue;
        for (const [index, line] of content.split("\n").entries()) {
          if (line.toLowerCase().includes(query)) matches.push({ path: rel, line: index + 1, text: line.trimEnd().slice(0, 500) });
          if (matches.length >= 100) break;
        }
      }
    };
    if (fs.statSync(start.abs).isDirectory()) walk(start.abs);
    else throw new Error("workspace search target is not a directory");
    return { operation: "search", query: target.query, matches, truncated: matches.length >= 100 };
  }
  const stat = fs.statSync(start.abs);
  if (!stat.isFile()) throw new Error("workspace read target is not a file");
  const content = fs.readFileSync(start.abs, "utf8");
  if (content.includes("\0")) throw new Error("workspace read target is binary");
  const maxBytes = target.maxBytes ?? 256 * 1024;
  return { operation: "read", path: start.rel, content: Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8") };
}

export function delegationStateRoot(): string {
  return delegationRoot();
}

/** Strict raw-boundary parser for CLI and other A1 authorization JSON. */
export function parseDelegationJson<T = unknown>(raw: string): T {
  return parseStrictJson<T>(raw);
}

export function isProviderBoundOperation(pathValue: OperationEvidencePath): boolean {
  return isProviderDependentPath(pathValue);
}
