import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getStateDir, readJsonIfExists, writeAtomicSecureJson } from "../config/paths.js";
import { readWorktreeIdentity } from "../connection/identity.js";
import {
  prepareGitHubOperation,
  reconcileGitHubOperation,
  type GitHubOperationObservation,
  type GitHubOperationTarget,
} from "./operation.js";
import { assertTeamAiAuthResult, type TeamAiCapabilityResult } from "./teamai.js";

export type DeliveryMessageType = "INIT" | "HANDOFF" | "PLAN" | "EXECUTED" | "REVIEW" | "RE_REVIEW";

export type DeliveryReceiptState =
  | "PREPARED"
  | "SENDING"
  | "DELIVERED_VISIBLE"
  | "WAITING_RESPONSE"
  | "RESPONSE_RECEIVED"
  | "RECONCILING"
  | "FAILED_DEFINITE"
  | "AMBIGUOUS"
  | "BLOCKED";

export type RemoteEvidenceOutcome =
  | "accepted"
  | "pending"
  | "definite_not_accepted"
  | "ambiguous"
  | "failed";

export type TeamAiCredentialClassification =
  | "healthy"
  | "credential_context_unavailable"
  | "auth_invalid_or_expired"
  | "human_security_boundary"
  | "capability_unavailable";

export type AuthRecoveryState =
  | "AUTHORIZED_OPERATION_PREPARED"
  | "INTERRUPTED_AUTH_PENDING"
  | "AUTH_CONTEXT_RECONCILING"
  | "TEAMAI_RECOVERY_ACTIVE"
  | "AUTH_HEALTHY"
  | "REMOTE_RECONCILING"
  | "RESUME_ONCE"
  | "COMPLETED"
  | "WAITING_HUMAN_SECURITY_BOUNDARY";

export interface TransportBindingIdentity {
  workspaceId: string;
  workstreamId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  canonicalRepository?: string;
  worktreeRoot?: string;
  branch?: string;
  observedCommit?: string;
  dirtyState?: "clean" | "dirty" | "unknown";
  installationId?: string;
  endpointFingerprint?: string;
  connectorName?: string;
  mcpAppId?: string;
  mcpVersionId?: string;
  projectId?: string;
  chatId?: string;
  codexSessionId?: string;
  expectedAccount?: string;
  authAttemptId?: string;
  taskId: string;
  checkpoint: string;
  stage: string;
  eventKey: string;
  /** Runtime-only brand; it is intentionally omitted from persisted JSON. */
  readonly [ACTIVE_CANONICAL_BINDING]?: true;
}

export interface C2cDeliveryAuthorization {
  schemaVersion: 1;
  /** Monotonic compare-and-swap generation for cross-process recovery. */
  generation: number;
  authorityId: string;
  issuedAt: string;
  issuer: "canonical-workflow";
  issuerId: string;
  operationKey?: string;
  operationTarget?: GitHubOperationTarget;
  sourceCheckpoint: string;
  sourceStage: string;
  messageType: DeliveryMessageType;
  eventKey: string;
  payloadHash: string;
  binding: TransportBindingIdentity;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ReceiptHistoryEntry {
  state: DeliveryReceiptState;
  at: string;
  reason?: string;
}

export interface RemoteEvidence {
  outcome: RemoteEvidenceOutcome;
  remoteId?: string;
  status?: string;
  target?: string;
  evidenceHash?: string;
  eventKey?: string;
  payloadHash?: string;
  observedAt: string;
  visibleBubble?: boolean;
}

export interface ReasoningEvidence {
  requested: string;
  actual: string;
  supported: boolean;
  corrected: boolean;
  reason?: string;
}

export interface EnvelopeEvidence {
  byteLength: number;
  characterCount: number;
  fragmented: false;
  reducedFields: string[];
}

export interface C2cDeliveryReceipt {
  schemaVersion: 1;
  /** Monotonic compare-and-swap generation for cross-process recovery. */
  generation: number;
  authorityId: string;
  eventKey: string;
  payloadHash: string;
  messageType: DeliveryMessageType;
  binding: TransportBindingIdentity;
  state: DeliveryReceiptState;
  sendAttempts: number;
  processId?: string;
  sessionId?: string;
  responseKey?: string;
  responseHash?: string;
  responseConsumedAt?: string;
  remoteEvidence?: RemoteEvidence;
  operationKey?: string;
  operationTarget?: GitHubOperationTarget;
  operationEvidence?: ReturnType<typeof reconcileGitHubOperation>;
  reasoningEvidence?: ReasoningEvidence;
  envelopeEvidence?: EnvelopeEvidence;
  authRecovery?: AuthRecoveryObservation;
  reconciliationAttempts: number;
  nextAction?: string;
  reason?: string;
  history: ReceiptHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthRecoveryObservation {
  state: AuthRecoveryState;
  classifier: "github-cli-auth";
  capabilityVersion?: string;
  classification?: TeamAiCredentialClassification;
  expectedAccount?: string;
  authAttemptId?: string;
  reason?: string;
  observedAt: string;
}

export interface TeamAiAuthObservationInput {
  authorization: C2cDeliveryAuthorization;
  binding: TransportBindingIdentity;
  state: AuthRecoveryState;
  capabilityResult: TeamAiCapabilityResult;
  expectedAccount?: string;
  authAttemptId?: string;
  reason?: string;
}

export interface WorkflowAuthorizationIssuer {
  readonly [WORKFLOW_AUTHORITY]: true;
  kind: "canonical-workflow";
  workflowStep: number;
  stage: string;
  authorizedMessageType: DeliveryMessageType;
  authorizedAction: DeliveryMessageType;
  /** Deterministic action identity issued by the canonical workflow state. */
  actionId: string;
  authorizedTaskId: string;
  authorizedEventKey: string;
  humanGateComplete: boolean;
  issuerId: string;
  workflowStatePath: string;
  workflowStateDigest: string;
  bindingDigest: string;
}

const WORKFLOW_AUTHORITY: unique symbol = Symbol("canonical-workflow-authority");
const ACTIVE_CANONICAL_BINDING: unique symbol = Symbol("active-canonical-workflow-binding");

export interface WorkflowAuthorizationIssuerInput {
  workflowStep: number;
  stage: string;
  issuerId: string;
  messageType: DeliveryMessageType;
  binding: TransportBindingIdentity;
}

export interface IssueAuthorizationInput {
  issuer: WorkflowAuthorizationIssuer;
  sourceCheckpoint: string;
  sourceStage: string;
  messageType: DeliveryMessageType;
  eventKey: string;
  payloadHash: string;
  binding: TransportBindingIdentity;
  operationTarget?: GitHubOperationTarget;
  expiresAt?: string;
}

export interface PrepareDeliveryInput {
  authorization: C2cDeliveryAuthorization;
  binding: TransportBindingIdentity;
  messageType: DeliveryMessageType;
  eventKey: string;
  payloadHash: string;
  processId?: string;
  sessionId?: string;
  reasoningEvidence?: ReasoningEvidence;
  envelopeEvidence?: EnvelopeEvidence;
}

export interface BrowserObservationInput {
  authorization: C2cDeliveryAuthorization;
  binding: TransportBindingIdentity;
  outcome: "visible" | "ambiguous" | "definite_failure";
  remoteId?: string;
  evidenceHash?: string;
  observedEventKey?: string;
  observedPayloadHash?: string;
  reason?: string;
}

export interface ReconcileDeliveryInput {
  authorization: C2cDeliveryAuthorization;
  binding: TransportBindingIdentity;
  outcome: RemoteEvidenceOutcome;
  remoteId?: string;
  status?: string;
  target?: string;
  evidenceHash?: string;
  reason?: string;
  operationObservation?: Omit<GitHubOperationObservation, "target" | "payloadHash"> & {
    target?: GitHubOperationTarget;
    payloadHash?: string;
  };
}

export interface ReviewerResponseInput {
  authorization: C2cDeliveryAuthorization;
  binding: TransportBindingIdentity;
  responseKey: string;
  responseHash: string;
}

export const DELIVERY_RECEIPT_TRANSITIONS: Readonly<
  Record<DeliveryReceiptState, readonly DeliveryReceiptState[]>
> = {
  PREPARED: ["SENDING", "BLOCKED"],
  SENDING: ["DELIVERED_VISIBLE", "WAITING_RESPONSE", "RECONCILING", "FAILED_DEFINITE", "AMBIGUOUS", "BLOCKED"],
  DELIVERED_VISIBLE: ["WAITING_RESPONSE", "RESPONSE_RECEIVED", "RECONCILING", "BLOCKED"],
  WAITING_RESPONSE: ["DELIVERED_VISIBLE", "RESPONSE_RECEIVED", "RECONCILING", "BLOCKED"],
  RESPONSE_RECEIVED: [],
  RECONCILING: ["DELIVERED_VISIBLE", "WAITING_RESPONSE", "FAILED_DEFINITE", "AMBIGUOUS", "BLOCKED"],
  FAILED_DEFINITE: ["SENDING", "BLOCKED"],
  AMBIGUOUS: ["RECONCILING", "DELIVERED_VISIBLE", "WAITING_RESPONSE", "FAILED_DEFINITE", "BLOCKED"],
  BLOCKED: [],
};

const STEP5_MESSAGE_TYPES: readonly DeliveryMessageType[] = ["EXECUTED", "REVIEW", "RE_REVIEW"];

const ALLOWED_MESSAGE_TYPES = new Set<DeliveryMessageType>([
  "INIT",
  "HANDOFF",
  "PLAN",
  "EXECUTED",
  "REVIEW",
  "RE_REVIEW",
]);
const MAX_TEXT = 512;
const MAX_HISTORY = 64;
const MAX_LOCK_AGE_MS = 30_000;

function boundedText(value: string | undefined, limit = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, limit);
}

function transportRoot(): string {
  return path.join(getStateDir(), "transport");
}

function stateFile(kind: "authorizations" | "receipts", eventKey: string): string {
  const safeKey = createHash("sha256").update(eventKey).digest("hex").slice(0, 48);
  return path.join(transportRoot(), kind, `${safeKey}.json`);
}

function lockFile(eventKey: string): string {
  return path.join(transportRoot(), "locks", `${createHash("sha256").update(eventKey).digest("hex").slice(0, 48)}.lock`);
}

function now(): string {
  return new Date().toISOString();
}

function bindingFields(): string[] {
  return [
    "workspaceId",
    "workstreamId",
    "workspaceName",
    "workspaceRoot",
    "canonicalRepository",
    "worktreeRoot",
    "branch",
    "observedCommit",
    "dirtyState",
    "installationId",
    "endpointFingerprint",
    "connectorName",
    "mcpAppId",
    "mcpVersionId",
    "projectId",
    "chatId",
    "codexSessionId",
    "expectedAccount",
    "authAttemptId",
    "taskId",
    "checkpoint",
    "stage",
    "eventKey",
  ];
}

export function bindingMismatchFields(
  actual: TransportBindingIdentity,
  expected: TransportBindingIdentity
): string[] {
  return bindingFields().filter((field) => {
    const expectedValue = expected[field as keyof TransportBindingIdentity];
    return expectedValue !== undefined && actual[field as keyof TransportBindingIdentity] !== expectedValue;
  });
}

export function bindingMatches(actual: TransportBindingIdentity, expected: TransportBindingIdentity): boolean {
  return bindingMismatchFields(actual, expected).length === 0;
}

function assertBinding(actual: TransportBindingIdentity, expected: TransportBindingIdentity): void {
  const mismatches = bindingMismatchFields(actual, expected);
  if (mismatches.length > 0) {
    throw new Error(`transport binding mismatch: ${mismatches.join(", ")}`);
  }
}

function assertEventIdentity(
  authorization: C2cDeliveryAuthorization,
  binding: TransportBindingIdentity,
  messageType: DeliveryMessageType,
  eventKey: string,
  payloadHash: string
): void {
  const persisted = loadAuthorization(authorization.eventKey);
  if (!persisted || persisted.authorityId !== authorization.authorityId) {
    throw new Error("delivery authorization is not the persisted canonical authority");
  }
  if (authorization.revokedAt || persisted.revokedAt) throw new Error("delivery authorization is revoked");
  if (persisted.generation !== authorization.generation) {
    throw new Error("delivery authorization is not the persisted canonical authority");
  }
  if (persisted.payloadHash !== authorization.payloadHash || persisted.messageType !== authorization.messageType) {
    throw new Error("persisted delivery authorization identity mismatch");
  }
  if (!bindingMatches(persisted.binding, authorization.binding)) {
    throw new Error("persisted delivery authorization binding mismatch");
  }
  const expiresAt = persisted.expiresAt ?? authorization.expiresAt;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new Error("delivery authorization is expired");
  }
  if (authorization.messageType !== messageType) throw new Error("delivery message type mismatch");
  if (authorization.eventKey !== eventKey) throw new Error("delivery event key mismatch");
  if (authorization.payloadHash !== payloadHash) throw new Error("delivery payload hash mismatch");
  assertBinding(authorization.binding, binding);
}

function withEventLease<T>(eventKey: string, action: () => T): T {
  const file = lockFile(eventKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let descriptor: number | null = null;
  let acquired = false;
  const leaseId = randomUUID();
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        descriptor = fs.openSync(file, "wx", 0o600);
        acquired = true;
        fs.writeFileSync(descriptor, JSON.stringify({ leaseId, pid: process.pid, at: now() }), "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(file).mtimeMs;
          if (age > MAX_LOCK_AGE_MS) fs.rmSync(file, { force: true });
        } catch {
          // A concurrent owner may have released the lease.
        }
      }
    }
    if (descriptor === null) throw new Error("transport event is locked");
    return action();
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor may already be closed after an I/O failure.
      }
    }
    if (acquired) {
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { leaseId?: string };
        if (current.leaseId === leaseId) fs.rmSync(file, { force: true });
      } catch {
        // Best effort lease cleanup; the stale lease guard and CAS handle recovery.
      }
    }
  }
}

function saveAuthorization(authorization: C2cDeliveryAuthorization): C2cDeliveryAuthorization {
  const file = stateFile("authorizations", authorization.eventKey);
  const existing = fs.existsSync(file) ? loadAuthorization(authorization.eventKey) : null;
  const generation = Number.isSafeInteger(authorization.generation) && authorization.generation >= 0 ? authorization.generation : 0;
  if (existing && existing.generation !== generation) throw new Error("transport authorization generation conflict");
  const next = { ...authorization, generation: generation + 1 };
  writeAtomicSecureJson(file, next);
  return next;
}

function loadAuthorization(eventKey: string): C2cDeliveryAuthorization | null {
  const file = stateFile("authorizations", eventKey);
  if (!fs.existsSync(file)) return null;
  const value = readJsonIfExists<C2cDeliveryAuthorization>(file);
  if (!value || value.schemaVersion !== 1 || value.eventKey !== eventKey || value.issuer !== "canonical-workflow") {
    throw new Error("malformed delivery authorization record; refusing implicit recovery");
  }
  const generation = Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0;
  return { ...value, generation };
}

function saveReceipt(receipt: C2cDeliveryReceipt): C2cDeliveryReceipt {
  const bounded = {
    ...receipt,
    generation: Number.isSafeInteger(receipt.generation) && receipt.generation >= 0 ? receipt.generation : 0,
    reason: boundedText(receipt.reason),
    nextAction: boundedText(receipt.nextAction, 256),
    history: receipt.history.slice(-MAX_HISTORY),
  };
  const file = stateFile("receipts", receipt.eventKey);
  const existing = fs.existsSync(file) ? loadReceipt(receipt.eventKey) : null;
  if (existing && existing.generation !== bounded.generation) throw new Error("transport receipt generation conflict");
  const next = { ...bounded, generation: bounded.generation + 1 };
  writeAtomicSecureJson(file, next);
  return next;
}

function loadReceipt(eventKey: string): C2cDeliveryReceipt | null {
  const file = stateFile("receipts", eventKey);
  if (!fs.existsSync(file)) return null;
  const value = readJsonIfExists<C2cDeliveryReceipt>(file);
  if (!value || value.schemaVersion !== 1 || value.eventKey !== eventKey) {
    throw new Error("malformed delivery receipt record; refusing implicit recovery");
  }
  const generation = Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0;
  return { ...value, generation };
}

function appendHistory(receipt: C2cDeliveryReceipt, state: DeliveryReceiptState, reason?: string): void {
  receipt.history = [
    ...receipt.history,
    { state, at: now(), ...(boundedText(reason) ? { reason: boundedText(reason) } : {}) },
  ].slice(-MAX_HISTORY);
  receipt.updatedAt = now();
}

function transitionReceipt(receipt: C2cDeliveryReceipt, next: DeliveryReceiptState, reason?: string): void {
  if (receipt.state === next) return;
  if (!DELIVERY_RECEIPT_TRANSITIONS[receipt.state].includes(next)) {
    throw new Error(`illegal delivery receipt transition: ${receipt.state} -> ${next}`);
  }
  receipt.state = next;
  appendHistory(receipt, next, reason);
}

function assertMessageType(messageType: DeliveryMessageType): void {
  if (!ALLOWED_MESSAGE_TYPES.has(messageType)) throw new Error("message type is not allowlisted");
}

function boundedBinding(binding: TransportBindingIdentity): TransportBindingIdentity {
  const bounded: TransportBindingIdentity = {
    workspaceId: boundedText(binding.workspaceId, 128) ?? "",
    taskId: boundedText(binding.taskId, 256) ?? "",
    checkpoint: boundedText(binding.checkpoint, 128) ?? "",
    stage: boundedText(binding.stage, 128) ?? "",
    eventKey: boundedText(binding.eventKey, 256) ?? "",
  };
  for (const key of [
    "workstreamId",
    "workspaceName",
    "workspaceRoot",
    "canonicalRepository",
    "worktreeRoot",
    "branch",
    "observedCommit",
    "installationId",
    "endpointFingerprint",
    "connectorName",
    "mcpAppId",
    "mcpVersionId",
    "projectId",
    "chatId",
    "codexSessionId",
    "expectedAccount",
    "authAttemptId",
  ] as const) {
    const value = boundedText(binding[key], 512);
    if (value !== undefined) bounded[key] = value;
  }
  if (binding.dirtyState) bounded.dirtyState = binding.dirtyState;
  return bounded;
}

function workflowStateDigest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file, "utf8")).digest("hex");
}

interface CanonicalWorkflowSnapshot {
  step: number;
  stage: string;
  status: string;
  step4Approved: boolean;
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
  canonicalRepository: string;
  worktreeRoot: string;
  branch: string;
  observedCommit: string;
  dirtyState: "clean" | "dirty" | "unknown";
  installationId: string;
  endpointFingerprint: string;
  connectorName: string;
  mcpAppId: string;
  mcpVersionId: string;
  projectId: string;
  chatId: string;
  codexSessionId: string;
  taskId: string;
  eventKey: string;
  authorizedMessageType: DeliveryMessageType;
  actionId: string;
  checkpoint: string;
  reviewStage: string;
}

function canonicalWorkflowStatePath(binding: TransportBindingIdentity): string {
  if (!binding.workspaceRoot || !binding.workstreamId) {
    throw new Error("canonical workflow binding requires workspace root and workstream id");
  }
  const root = path.resolve(binding.workspaceRoot);
  const candidate = path.resolve(root, ".harness", binding.workstreamId, "state.yaml");
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("canonical workflow state path escaped workspace");
  return candidate;
}

function yamlScalar(state: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return state.match(new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`, "m"))?.[1]
    ?.replace(/^["']|["']$/g, "")
    .trim() || undefined;
}

function projectOrChatId(url: string | undefined, kind: "project" | "chat"): string | undefined {
  if (!url) return undefined;
  const pattern = kind === "project" ? /\/g\/(g-p-[^/]+)\/project(?:$|[?#])/ : /\/c\/([^/?#]+)/;
  return url.match(pattern)?.[1];
}

function canonicalActionId(workspaceId: string, workstreamId: string, checkpoint: string, messageType: DeliveryMessageType): string {
  return `c2c-action-${createHash("sha256").update(`${workspaceId}\0${workstreamId}\0${checkpoint}\0${messageType}`).digest("hex").slice(0, 32)}`;
}

function canonicalWorkflowSnapshot(file: string): CanonicalWorkflowSnapshot {
  const state = fs.readFileSync(file, "utf8");
  const workstreamId = path.basename(path.dirname(file));
  const step = Number(yamlScalar(state, "step"));
  const stage = yamlScalar(state, "stage");
  const status = yamlScalar(state, "status");
  const workspaceId = yamlScalar(state, "workspace_id") ?? yamlScalar(state, "verified_workspace_id");
  const workspaceRoot = yamlScalar(state, "workspace_root");
  const workspaceName = yamlScalar(state, "verified_workspace_name") ?? yamlScalar(state, "workspace_name");
  const canonicalRepository = yamlScalar(state, "canonical_repository");
  const worktreeRoot = yamlScalar(state, "worktree_root");
  const branch = yamlScalar(state, "verified_branch") ?? yamlScalar(state, "branch");
  const observedCommit = yamlScalar(state, "verified_commit") ?? yamlScalar(state, "observed_commit");
  const dirtyState = yamlScalar(state, "dirty_state") as "clean" | "dirty" | "unknown" | undefined;
  const installationId = yamlScalar(state, "installation_id");
  const endpointFingerprint = yamlScalar(state, "endpoint_fingerprint");
  const connectorName = yamlScalar(state, "connector_name");
  const mcpAppId = yamlScalar(state, "connector_app_id") ?? yamlScalar(state, "mcp_app_id");
  const mcpVersionId = yamlScalar(state, "connector_version_id") ?? yamlScalar(state, "mcp_version_id");
  const projectUrl = yamlScalar(state, "project_url");
  const chatUrl = yamlScalar(state, "chat_url");
  const projectId = yamlScalar(state, "project_id") ?? projectOrChatId(projectUrl, "project");
  const chatId = yamlScalar(state, "chat_id") ?? projectOrChatId(chatUrl, "chat");
  const codexSessionId = yamlScalar(state, "codex_session_id");
  const checkpoint = yamlScalar(state, "checkpoint");
  const taskId = yamlScalar(state, "task_id") ?? checkpoint;
  const eventKey = yamlScalar(state, "event_key") ?? checkpoint;
  const authorizedMessageType = (yamlScalar(state, "authorized_action") ?? "EXECUTED") as DeliveryMessageType;
  const actionId = yamlScalar(state, "action_id") ?? (workspaceId && checkpoint ? canonicalActionId(workspaceId, workstreamId, checkpoint, authorizedMessageType) : undefined);
  const validDirtyState = dirtyState === "clean" || dirtyState === "dirty" || dirtyState === "unknown";
  const reviewStage = yamlScalar(state, "review_stage");
  if (
    !Number.isSafeInteger(step) || !stage || !status || !workspaceId || !workspaceRoot || !workspaceName ||
    !canonicalRepository || !worktreeRoot || !branch || !observedCommit || !validDirtyState || !installationId ||
    !endpointFingerprint || !connectorName || !mcpAppId || !mcpVersionId || !projectId || !chatId ||
    !codexSessionId || !taskId || !eventKey || !checkpoint || !reviewStage || !actionId ||
    !ALLOWED_MESSAGE_TYPES.has(authorizedMessageType)
  ) {
    throw new Error("canonical workflow state has an unsupported or incomplete identity schema");
  }
  return {
    step,
    stage,
    status,
    step4Approved: /step4_approval:[\s\S]*?approved:\s*true/.test(state),
    workspaceId,
    workspaceRoot,
    workspaceName,
    canonicalRepository,
    worktreeRoot,
    branch,
    observedCommit,
    dirtyState,
    installationId,
    endpointFingerprint,
    connectorName,
    mcpAppId,
    mcpVersionId,
    projectId,
    chatId,
    codexSessionId,
    taskId,
    eventKey,
    authorizedMessageType,
    actionId,
    checkpoint,
    reviewStage,
  };
}

const CANONICAL_BINDING_FIELDS: readonly string[] = [
  "workspaceId", "workstreamId", "workspaceName", "workspaceRoot", "canonicalRepository", "worktreeRoot",
  "branch", "observedCommit", "dirtyState", "installationId", "endpointFingerprint", "connectorName",
  "mcpAppId", "mcpVersionId", "projectId", "chatId", "codexSessionId", "taskId", "checkpoint", "stage", "eventKey",
];

function bindingDigest(binding: TransportBindingIdentity): string {
  const projection = Object.fromEntries(CANONICAL_BINDING_FIELDS.map((field) => [field, binding[field as keyof TransportBindingIdentity] ?? null]));
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function assertCanonicalBindingAgainstSnapshot(binding: TransportBindingIdentity, snapshot: CanonicalWorkflowSnapshot): void {
  const expected: Record<string, string> = {
    workspaceId: snapshot.workspaceId,
    workstreamId: "",
    workspaceName: snapshot.workspaceName,
    workspaceRoot: path.resolve(snapshot.workspaceRoot),
    canonicalRepository: snapshot.canonicalRepository,
    worktreeRoot: path.resolve(snapshot.worktreeRoot),
    branch: snapshot.branch,
    observedCommit: snapshot.observedCommit,
    dirtyState: snapshot.dirtyState,
    installationId: snapshot.installationId,
    endpointFingerprint: snapshot.endpointFingerprint,
    connectorName: snapshot.connectorName,
    mcpAppId: snapshot.mcpAppId,
    mcpVersionId: snapshot.mcpVersionId,
    projectId: snapshot.projectId,
    chatId: snapshot.chatId,
    codexSessionId: snapshot.codexSessionId,
    taskId: snapshot.taskId,
    checkpoint: snapshot.checkpoint,
    stage: snapshot.stage,
    eventKey: snapshot.eventKey,
  };
  // The workstream is the state directory name, not a value supplied by the
  // caller. The caller is checked against it by deriveActiveCanonicalBinding;
  // direct issuer use still must provide the same directory-rooted binding.
  expected.workstreamId = binding.workstreamId ?? "";
  for (const field of CANONICAL_BINDING_FIELDS) {
    const actual = binding[field as keyof TransportBindingIdentity];
    const wanted = expected[field];
    if (typeof actual !== "string" || !actual.trim()) throw new Error(`canonical transport binding is incomplete: ${String(field)}`);
    const normalizedActual = field === "workspaceRoot" || field === "worktreeRoot" ? path.resolve(actual) : actual;
    if (normalizedActual !== wanted) throw new Error(`canonical transport binding mismatch: ${String(field)}`);
  }
}

function assertActiveCanonicalBinding(binding: TransportBindingIdentity): void {
  if (binding[ACTIVE_CANONICAL_BINDING] !== true) {
    throw new Error("transport binding must come from the active canonical workflow resolver");
  }
}

export interface ActiveCanonicalWorkflowBindingInput {
  /** Workspace root selected by the active Codex runtime, never by a binding file. */
  workspaceRoot: string;
  /** Workspace identity computed by the active runtime's Workspace object. */
  workspaceId: string;
  /** Optional transport metadata; authority fields are checked, then replaced from state. */
  candidate: TransportBindingIdentity;
}

/**
 * Resolve the active workstream/checkpoint from the harness-owned state tree.
 * A binding JSON may carry connector/session metadata, but it cannot select a
 * different workspace, workstream, checkpoint, or workflow stage.
 */
export function deriveActiveCanonicalBinding(input: ActiveCanonicalWorkflowBindingInput): TransportBindingIdentity {
  const root = fs.realpathSync.native(path.resolve(input.workspaceRoot));
  const harnessRoot = path.join(root, ".harness");
  if (!fs.existsSync(harnessRoot)) throw new Error("active workspace has no canonical .harness state");
  const candidates = fs.readdirSync(harnessRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(harnessRoot, entry.name, "state.yaml"))
    .filter((file) => fs.existsSync(file));
  const matches = candidates.flatMap((file) => {
    try {
      const snapshot = canonicalWorkflowSnapshot(file);
      const workstreamId = path.basename(path.dirname(file));
      if (snapshot.status !== "RUNNING" || snapshot.workspaceId !== input.workspaceId || path.resolve(snapshot.workspaceRoot) !== path.resolve(root)) return [];
      if (input.candidate.workstreamId && input.candidate.workstreamId !== workstreamId) return [];
      return [{ file, workstreamId, snapshot }];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) throw new Error("active workspace does not have one unambiguous running canonical workstream");
  const [{ workstreamId, snapshot }] = matches;
  const candidate = input.candidate;
  if (candidate.workspaceId !== input.workspaceId || (candidate.workspaceRoot && path.resolve(candidate.workspaceRoot) !== root) ||
      (candidate.workstreamId && candidate.workstreamId !== workstreamId)) {
    throw new Error("transport binding workspace is not the active workspace");
  }
  const activeWorktree = readWorktreeIdentity({ workspaceRoot: root });
  if (snapshot.workspaceRoot !== root || snapshot.canonicalRepository !== activeWorktree.canonicalRepository ||
      snapshot.worktreeRoot !== activeWorktree.worktreeRoot || snapshot.branch !== activeWorktree.branch ||
      !(snapshot.observedCommit === activeWorktree.observedCommit || snapshot.observedCommit.startsWith(activeWorktree.observedCommit)) ||
      snapshot.dirtyState !== activeWorktree.dirtyState ||
      snapshot.installationId !== activeWorktree.installationId) {
    throw new Error("canonical state does not match the active workspace worktree identity");
  }
  assertCanonicalBindingAgainstSnapshot(candidate, snapshot);
  const resolved: TransportBindingIdentity = {
    ...candidate,
    workspaceId: input.workspaceId,
    workstreamId,
    workspaceName: snapshot.workspaceName,
    workspaceRoot: root,
    canonicalRepository: snapshot.canonicalRepository,
    worktreeRoot: snapshot.worktreeRoot,
    branch: snapshot.branch,
    observedCommit: snapshot.observedCommit,
    dirtyState: snapshot.dirtyState,
    installationId: snapshot.installationId,
    endpointFingerprint: snapshot.endpointFingerprint,
    connectorName: snapshot.connectorName,
    mcpAppId: snapshot.mcpAppId,
    mcpVersionId: snapshot.mcpVersionId,
    projectId: snapshot.projectId,
    chatId: snapshot.chatId,
    codexSessionId: snapshot.codexSessionId,
    taskId: snapshot.taskId,
    checkpoint: snapshot.checkpoint,
    stage: snapshot.stage,
    eventKey: snapshot.eventKey,
    [ACTIVE_CANONICAL_BINDING]: true,
  };
  // A binding file may carry metadata, but it cannot choose any authority
  // dimension. Require it to agree with the complete harness-derived identity.
  assertCanonicalBindingAgainstSnapshot(resolved, snapshot);
  if (candidate.workspaceId !== input.workspaceId || candidate.workstreamId !== workstreamId ||
      candidate.taskId !== snapshot.taskId || candidate.eventKey !== snapshot.eventKey ||
      candidate.checkpoint !== snapshot.checkpoint || candidate.stage !== snapshot.stage ||
      (candidate.workspaceRoot && path.resolve(candidate.workspaceRoot) !== root)) {
    throw new Error("transport binding is not the active canonical action identity");
  }
  return resolved;
}

/** Create the non-forgeable issuer token after checking the harness-owned state file. */
export function createWorkflowAuthorizationIssuer(input: WorkflowAuthorizationIssuerInput): WorkflowAuthorizationIssuer {
  assertActiveCanonicalBinding(input.binding);
  assertMessageType(input.messageType);
  const workflowStatePath = canonicalWorkflowStatePath(input.binding);
  if (!fs.existsSync(workflowStatePath)) throw new Error("canonical workflow state is unavailable");
  const snapshot = canonicalWorkflowSnapshot(workflowStatePath);
  assertCanonicalBindingAgainstSnapshot(input.binding, snapshot);
  if (snapshot.step !== input.workflowStep || snapshot.stage !== input.stage) throw new Error("canonical workflow step or stage does not match");
  if (snapshot.status !== "RUNNING") throw new Error("canonical workflow is not running");
  if (input.workflowStep >= 5 && !snapshot.step4Approved) {
    throw new Error("Step 4 Human Gate approval is not recorded in canonical state");
  }
  if (snapshot.workspaceId !== input.binding.workspaceId || path.resolve(snapshot.workspaceRoot) !== path.resolve(input.binding.workspaceRoot ?? "") || snapshot.checkpoint !== input.binding.checkpoint) {
    throw new Error("canonical workflow state does not bind this workspace/checkpoint");
  }
  if (input.workflowStep === 5 && snapshot.reviewStage !== "post_implementation") {
    throw new Error("canonical workflow review stage does not match Step 5 implementation review");
  }
  if (input.messageType !== snapshot.authorizedMessageType) {
    throw new Error("canonical workflow action does not authorize this message type");
  }
  return {
    [WORKFLOW_AUTHORITY]: true,
    kind: "canonical-workflow",
    workflowStep: input.workflowStep,
    stage: boundedText(snapshot.stage, 128) ?? "",
    authorizedMessageType: snapshot.authorizedMessageType,
    authorizedAction: snapshot.authorizedMessageType,
    actionId: snapshot.actionId,
    authorizedTaskId: snapshot.taskId,
    authorizedEventKey: snapshot.eventKey,
    humanGateComplete: true,
    issuerId: snapshot.actionId,
    workflowStatePath,
    workflowStateDigest: workflowStateDigest(workflowStatePath),
    bindingDigest: bindingDigest(input.binding),
  };
}

function verifyWorkflowAuthorizationIssuer(issuer: WorkflowAuthorizationIssuer, binding: TransportBindingIdentity, checkpoint: string): void {
  if (issuer[WORKFLOW_AUTHORITY] !== true || issuer.kind !== "canonical-workflow" || !issuer.humanGateComplete) {
    throw new Error("canonical workflow authority token is invalid");
  }
  if (!fs.existsSync(issuer.workflowStatePath) || workflowStateDigest(issuer.workflowStatePath) !== issuer.workflowStateDigest) {
    throw new Error("canonical workflow state changed or is unavailable");
  }
  const snapshot = canonicalWorkflowSnapshot(issuer.workflowStatePath);
  assertCanonicalBindingAgainstSnapshot(binding, snapshot);
  if (
    snapshot.step !== issuer.workflowStep ||
    snapshot.stage !== issuer.stage ||
    snapshot.status !== "RUNNING" ||
    snapshot.workspaceId !== binding.workspaceId ||
    path.resolve(snapshot.workspaceRoot) !== path.resolve(binding.workspaceRoot ?? "") ||
    snapshot.checkpoint !== checkpoint ||
    snapshot.taskId !== issuer.authorizedTaskId ||
    snapshot.eventKey !== issuer.authorizedEventKey ||
    snapshot.actionId !== issuer.actionId ||
    snapshot.authorizedMessageType !== issuer.authorizedMessageType ||
    bindingDigest(binding) !== issuer.bindingDigest ||
    (issuer.workflowStep === 5 && snapshot.reviewStage !== "post_implementation")
  ) {
    throw new Error("canonical workflow authority does not match the active checkpoint");
  }
  if (issuer.workflowStep >= 5 && !snapshot.step4Approved) {
    throw new Error("Step 4 Human Gate approval is not recorded in canonical state");
  }
}

/** Issue one event-scoped authority from the canonical workflow issuer only. */
export function issueDeliveryAuthorization(input: IssueAuthorizationInput): C2cDeliveryAuthorization {
  assertMessageType(input.messageType);
  verifyWorkflowAuthorizationIssuer(input.issuer, input.binding, input.sourceCheckpoint);
  if (input.messageType !== input.issuer.authorizedMessageType) {
    throw new Error("canonical workflow authority is not authorized for this message type");
  }
  if (input.messageType !== input.issuer.authorizedAction) {
    throw new Error("canonical workflow authority action does not match the message type");
  }
  if (input.issuer.workflowStep < 1 || !input.issuer.stage || input.issuer.stage !== input.sourceStage) {
    throw new Error("canonical workflow authorization stage is invalid");
  }
  if (input.binding.eventKey !== input.eventKey || input.binding.eventKey !== input.issuer.authorizedEventKey ||
      input.binding.taskId !== input.issuer.authorizedTaskId || input.binding.checkpoint !== input.sourceCheckpoint) {
    throw new Error("authorization source checkpoint does not match binding");
  }
  if (input.operationTarget) {
    if (input.operationTarget.logicalOperationId !== input.eventKey) {
      throw new Error("GitHub operation identity is not bound to the canonical workflow action");
    }
    if (!input.binding.canonicalRepository || input.operationTarget.repository !== input.binding.canonicalRepository) {
      throw new Error("GitHub operation repository is not bound to the canonical workspace");
    }
  }
  return withEventLease(input.eventKey, () => {
    const operation = input.operationTarget ? prepareGitHubOperation(input.operationTarget, input.payloadHash) : undefined;
    const existing = loadAuthorization(input.eventKey);
    if (existing) {
      if (
        existing.payloadHash !== input.payloadHash ||
        existing.messageType !== input.messageType ||
        !bindingMatches(existing.binding, input.binding) ||
        existing.operationKey !== operation?.operationKey
      ) {
        throw new Error("logical event already has a different authorization");
      }
      return existing;
    }
    const authorization: C2cDeliveryAuthorization = {
      schemaVersion: 1,
      generation: 0,
      authorityId: randomUUID(),
      issuedAt: now(),
      issuer: "canonical-workflow",
      issuerId: boundedText(input.issuer.issuerId, 128) ?? "canonical-workflow",
      sourceCheckpoint: input.sourceCheckpoint,
      sourceStage: input.sourceStage,
      messageType: input.messageType,
      eventKey: input.eventKey,
      payloadHash: input.payloadHash,
      binding: boundedBinding(input.binding),
      ...(operation ? { operationKey: operation.operationKey, operationTarget: operation.target } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    return saveAuthorization(authorization);
  });
}

/** Record only a bounded classification returned by TeamAI; A0 never derives it from error text. */
export function recordTeamAiAuthObservation(input: TeamAiAuthObservationInput): C2cDeliveryReceipt {
  return withEventLease(input.authorization.eventKey, () => {
    assertTeamAiAuthResult(input.capabilityResult);
    const receipt = loadReceipt(input.authorization.eventKey);
    if (!receipt) throw new Error("delivery receipt is not prepared");
    assertEventIdentity(input.authorization, input.binding, receipt.messageType, receipt.eventKey, receipt.payloadHash);
    const currentAttempt = receipt.authRecovery?.authAttemptId;
    const incomingAttempt = boundedText(input.authAttemptId ?? input.capabilityResult.authAttemptId, 256);
    if (currentAttempt && incomingAttempt && currentAttempt !== incomingAttempt) {
      throw new Error("stale authentication attempt cannot update this logical operation");
    }
    receipt.authRecovery = {
      state: input.state,
      classifier: "github-cli-auth",
      capabilityVersion: input.capabilityResult.capabilityVersion,
      classification: input.capabilityResult.classification,
      ...(boundedText(input.expectedAccount ?? input.capabilityResult.expectedAccount, 256) ? { expectedAccount: boundedText(input.expectedAccount ?? input.capabilityResult.expectedAccount, 256) } : {}),
      ...(incomingAttempt ? { authAttemptId: incomingAttempt } : {}),
      ...(boundedText(input.reason) ? { reason: boundedText(input.reason) } : {}),
      observedAt: now(),
    };
    receipt.nextAction =
      input.capabilityResult.classification === "healthy"
        ? "reconcile the original authorized remote operation before one continuation"
        : input.capabilityResult.classification === "human_security_boundary"
          ? "wait for the required human/security decision"
          : input.capabilityResult.classification === "capability_unavailable"
            ? "resolve the current TeamAI github-cli-auth capability before retry"
            : "follow the TeamAI-owned authentication recovery contract, then reconcile this operation";
    receipt.reason = boundedText(input.reason);
    return saveReceipt(receipt);
  });
}

export function readDeliveryAuthorization(eventKey: string): C2cDeliveryAuthorization | null {
  return loadAuthorization(eventKey);
}

export function revokeDeliveryAuthorization(authorization: C2cDeliveryAuthorization): C2cDeliveryAuthorization {
  return withEventLease(authorization.eventKey, () => {
    const current = loadAuthorization(authorization.eventKey);
    if (!current || current.authorityId !== authorization.authorityId) throw new Error("authorization record not found");
    if (!current.revokedAt) {
      current.revokedAt = now();
      return saveAuthorization(current);
    }
    return current;
  });
}

export function prepareAuthorizedDelivery(input: PrepareDeliveryInput): C2cDeliveryReceipt {
  assertMessageType(input.messageType);
  assertEventIdentity(input.authorization, input.binding, input.messageType, input.eventKey, input.payloadHash);
  return withEventLease(input.eventKey, () => {
    const existing = loadReceipt(input.eventKey);
    if (existing) {
      if (existing.authorityId !== input.authorization.authorityId || existing.payloadHash !== input.payloadHash) {
        throw new Error("delivery receipt identity mismatch");
      }
      assertBinding(existing.binding, input.binding);
      return existing;
    }
    const timestamp = now();
    const receipt: C2cDeliveryReceipt = {
      schemaVersion: 1,
      generation: 0,
      authorityId: input.authorization.authorityId,
      eventKey: input.eventKey,
      payloadHash: input.payloadHash,
      messageType: input.messageType,
      binding: boundedBinding(input.binding),
      ...(input.authorization.operationKey ? { operationKey: input.authorization.operationKey } : {}),
      ...(input.authorization.operationTarget ? { operationTarget: input.authorization.operationTarget } : {}),
      state: "PREPARED",
      sendAttempts: 0,
      ...(input.processId ? { processId: boundedText(input.processId, 128) } : {}),
      ...(input.sessionId ? { sessionId: boundedText(input.sessionId, 256) } : {}),
      reconciliationAttempts: 0,
      ...(input.reasoningEvidence ? { reasoningEvidence: { ...input.reasoningEvidence, reason: boundedText(input.reasoningEvidence.reason, 160) } } : {}),
      ...(input.envelopeEvidence
        ? {
            envelopeEvidence: {
              byteLength: Math.max(0, Math.min(1024, Math.floor(input.envelopeEvidence.byteLength))),
              characterCount: Math.max(0, Math.min(4096, Math.floor(input.envelopeEvidence.characterCount))),
              fragmented: false,
              reducedFields: input.envelopeEvidence.reducedFields.slice(0, 16).map((field) => boundedText(field, 64) ?? ""),
            },
          }
        : {}),
      history: [{ state: "PREPARED", at: timestamp }],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return saveReceipt(receipt);
  });
}

export function readDeliveryReceipt(eventKey: string): C2cDeliveryReceipt | null {
  return loadReceipt(eventKey);
}

export function markSending(
  authorization: C2cDeliveryAuthorization,
  binding: TransportBindingIdentity,
  processId?: string,
  sessionId?: string
): C2cDeliveryReceipt {
  return withEventLease(authorization.eventKey, () => {
    const receipt = loadReceipt(authorization.eventKey);
    if (!receipt) throw new Error("delivery receipt is not prepared");
    assertEventIdentity(authorization, binding, receipt.messageType, receipt.eventKey, receipt.payloadHash);
    if (receipt.state === "RESPONSE_RECEIVED" || receipt.state === "DELIVERED_VISIBLE" || receipt.state === "WAITING_RESPONSE") {
      return receipt;
    }
    if (receipt.state === "AMBIGUOUS") transitionReceipt(receipt, "RECONCILING", "reconcile before retry");
    if (receipt.state === "RECONCILING") {
      // Reconciliation must resolve the remote result before a retry.
      throw new Error("ambiguous delivery requires reconciliation before retry");
    }
    transitionReceipt(receipt, "SENDING");
    receipt.sendAttempts += 1;
    receipt.processId = boundedText(processId, 128);
    receipt.sessionId = boundedText(sessionId, 256);
    receipt.nextAction = "observe exact visible remote bubble";
    return saveReceipt(receipt);
  });
}

export function recordBrowserObservation(input: BrowserObservationInput): C2cDeliveryReceipt {
  return withEventLease(input.authorization.eventKey, () => {
    if (input.outcome === "visible" &&
      (!boundedText(input.remoteId, 256) || !boundedText(input.evidenceHash, 128) ||
        input.observedEventKey !== input.authorization.eventKey ||
        input.observedPayloadHash !== input.authorization.payloadHash)) {
      throw new Error("visible delivery requires exact remote bubble, event, and payload evidence");
    }
    const receipt = loadReceipt(input.authorization.eventKey);
    if (!receipt) throw new Error("delivery receipt is not prepared");
    assertEventIdentity(input.authorization, input.binding, receipt.messageType, receipt.eventKey, receipt.payloadHash);
    const outcome: RemoteEvidenceOutcome =
      input.outcome === "visible" ? "accepted" : input.outcome === "definite_failure" ? "definite_not_accepted" : "ambiguous";
    receipt.remoteEvidence = {
      outcome,
      ...(input.remoteId ? { remoteId: boundedText(input.remoteId, 256) } : {}),
      ...(input.evidenceHash ? { evidenceHash: boundedText(input.evidenceHash, 128) } : {}),
      ...(input.outcome === "visible" ? { eventKey: input.authorization.eventKey, payloadHash: input.authorization.payloadHash } : {}),
      observedAt: now(),
      visibleBubble: input.outcome === "visible",
    };
    if (input.outcome === "visible") {
      if (receipt.state === "AMBIGUOUS") transitionReceipt(receipt, "RECONCILING", "new visible evidence is being reconciled");
      if (receipt.state === "SENDING" || receipt.state === "WAITING_RESPONSE" || receipt.state === "RECONCILING" || receipt.state === "AMBIGUOUS") {
        transitionReceipt(receipt, "DELIVERED_VISIBLE", "visible remote bubble observed");
      }
      receipt.nextAction = "consume bound reviewer response once";
    } else if (input.outcome === "definite_failure") {
      if (receipt.state === "SENDING" || receipt.state === "RECONCILING") transitionReceipt(receipt, "FAILED_DEFINITE", input.reason);
      receipt.nextAction = "safe retry of the same logical event";
    } else {
      if (receipt.state === "SENDING" || receipt.state === "RECONCILING") transitionReceipt(receipt, "AMBIGUOUS", input.reason);
      receipt.nextAction = "reconcile exact remote evidence before retry";
    }
    receipt.reason = boundedText(input.reason);
    return saveReceipt(receipt);
  });
}

export function reconcileDelivery(input: ReconcileDeliveryInput): C2cDeliveryReceipt {
  return withEventLease(input.authorization.eventKey, () => {
    const receipt = loadReceipt(input.authorization.eventKey);
    if (!receipt) throw new Error("delivery receipt is not prepared");
    assertEventIdentity(input.authorization, input.binding, receipt.messageType, receipt.eventKey, receipt.payloadHash);
    receipt.reconciliationAttempts += 1;
    let outcome = input.outcome;
    let reconciliationReason = input.reason;
    if (receipt.operationTarget) {
      if (!input.operationObservation) {
        outcome = "ambiguous";
        reconciliationReason = "operation-specific remote evidence is required before continuation";
      } else {
        const { target: _ignoredTarget, payloadHash: observedPayloadHash, ...operationObservation } = input.operationObservation;
        const operationEvidence = reconcileGitHubOperation({
          target: receipt.operationTarget,
          payloadHash: observedPayloadHash ?? receipt.payloadHash,
          ...operationObservation,
        });
        receipt.operationEvidence = operationEvidence;
        outcome = operationEvidence.outcome;
        reconciliationReason = operationEvidence.reason ?? input.reason;
      }
    }
    receipt.remoteEvidence = {
      outcome,
      ...(input.remoteId ? { remoteId: boundedText(input.remoteId, 256) } : {}),
      ...(input.status ? { status: boundedText(input.status, 128) } : {}),
      ...(input.target ? { target: boundedText(input.target, 256) } : {}),
      ...(input.evidenceHash ? { evidenceHash: boundedText(input.evidenceHash, 128) } : {}),
      observedAt: now(),
    };
    if (receipt.state === "AMBIGUOUS") transitionReceipt(receipt, "RECONCILING", "remote evidence reconciliation started");
    if (outcome === "accepted") {
      if (receipt.state === "SENDING" || receipt.state === "AMBIGUOUS" || receipt.state === "RECONCILING") {
        transitionReceipt(receipt, "WAITING_RESPONSE", "remote status proves acceptance; visible bubble evidence is still required");
      }
      receipt.nextAction = "consume bound reviewer response once";
    } else if (outcome === "pending") {
      if (receipt.state === "SENDING" || receipt.state === "AMBIGUOUS" || receipt.state === "RECONCILING") {
        transitionReceipt(receipt, "WAITING_RESPONSE", "remote response remains pending; visible bubble evidence is still required");
      }
      receipt.nextAction = "wait for the bound reviewer response";
    } else if (outcome === "definite_not_accepted") {
      if (receipt.state === "SENDING" || receipt.state === "AMBIGUOUS" || receipt.state === "RECONCILING") {
        transitionReceipt(receipt, "FAILED_DEFINITE", reconciliationReason);
      }
      receipt.nextAction = "safe retry of the same logical event";
    } else if (outcome === "failed") {
      if (receipt.state !== "BLOCKED" && receipt.state !== "RESPONSE_RECEIVED") transitionReceipt(receipt, "BLOCKED", reconciliationReason);
      receipt.nextAction = "stop and surface the sanitized failure";
    } else {
      if (receipt.state === "SENDING" || receipt.state === "RECONCILING") transitionReceipt(receipt, "AMBIGUOUS", reconciliationReason);
      receipt.nextAction = "reconcile again; blind retry is prohibited";
    }
    receipt.reason = boundedText(reconciliationReason);
    return saveReceipt(receipt);
  });
}

export function consumeReviewerResponse(input: ReviewerResponseInput): C2cDeliveryReceipt {
  return withEventLease(input.authorization.eventKey, () => {
    if (!boundedText(input.responseKey, 256) || !boundedText(input.responseHash, 128)) {
      throw new Error("reviewer response key and hash are required");
    }
    const receipt = loadReceipt(input.authorization.eventKey);
    if (!receipt) throw new Error("delivery receipt is not prepared");
    assertEventIdentity(input.authorization, input.binding, receipt.messageType, receipt.eventKey, receipt.payloadHash);
    if (receipt.responseConsumedAt) {
      if (receipt.responseKey !== input.responseKey || receipt.responseHash !== input.responseHash) {
        throw new Error("a different reviewer response was already consumed");
      }
      return receipt;
    }
    if (receipt.state !== "DELIVERED_VISIBLE") {
      throw new Error(`reviewer response requires exact visible delivery evidence; current state is ${receipt.state}`);
    }
    receipt.responseKey = boundedText(input.responseKey, 256);
    receipt.responseHash = boundedText(input.responseHash, 128);
    receipt.responseConsumedAt = now();
    transitionReceipt(receipt, "RESPONSE_RECEIVED", "substantive reviewer response consumed once");
    receipt.nextAction = "advance canonical workflow with the bound response";
    return saveReceipt(receipt);
  });
}
