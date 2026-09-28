import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJsonIfExists, stateSubdir, writeSecureAtomicJson } from "../config/paths.js";
import type { ConnectionBinding } from "../connection/identity.js";
import { bindingFile, readConnectionBinding } from "../connection/identity.js";
import { Workspace } from "../workspace/manager.js";
import { assertOpaqueSecretRef, type ProtectedSecretStore } from "./secret-store.js";
import type { SecureTunnelAdapter } from "./tunnel-adapter.js";

export type StartupPolicy = "user_logon" | "manual";
export type SecretOwnership = "preExisting" | "p0-2";
export type RecoveryHealth = "unknown" | "healthy" | "stopped" | "ambiguous" | "waiting";

const CAPABILITY_ATTESTATION = Symbol("p0-2-recovery-capability-attestation");

export interface RecoveryCapabilityAttestation {
  readonly connectionBindingId: string;
  readonly protectedSecretRef: string;
  readonly tunnelProfileRef: string;
  readonly protectedSecretProvider: string;
  readonly tunnelProvider: string;
  readonly verifiedAt: string;
  readonly [CAPABILITY_ATTESTATION]: true;
}

export interface RecoveryBindingRecord {
  schemaVersion: 1;
  connectionBindingId: string;
  projectName: string;
  canonicalAllowedRoot: string;
  tunnelProfileRef: string;
  protectedSecretRef: string;
  startupPolicy: StartupPolicy;
  ownership: {
    createdBy: SecretOwnership;
    ownerMarker: string;
  };
  capability: {
    protectedSecretProvider: string;
    tunnelProvider: string;
    verifiedAt: string;
  };
  observedHealth: RecoveryHealth;
  identitySnapshot: {
    workspace: string;
    canonicalRepository: string;
    installationId: string;
    endpointMode: ConnectionBinding["endpointMode"];
    endpointFingerprint: string;
    connectorName: string;
  };
  updatedAt: string;
}

export class RecoveryIdentityError extends Error {
  constructor(
    public readonly status: "identity_mismatch" | "ambiguous_ownership",
    message: string,
  ) {
    super(message);
    this.name = "RecoveryIdentityError";
  }
}

function assertBindingIdentifier(connectionBindingId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(connectionBindingId)) {
    throw new RecoveryIdentityError("identity_mismatch", "recovery binding identifier is invalid");
  }
}

export function recoveryBindingFile(connectionBindingId: string): string {
  assertBindingIdentifier(connectionBindingId);
  return path.join(stateSubdir("recovery"), "bindings", `${connectionBindingId}.json`);
}

export function recoveryCheckpointFile(connectionBindingId: string): string {
  assertBindingIdentifier(connectionBindingId);
  return path.join(stateSubdir("recovery"), "checkpoints", `${connectionBindingId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertBindingScopedSecretRef(ref: string, connectionBindingId: string): void {
  try {
    assertOpaqueSecretRef(ref);
  } catch (error) {
    throw new RecoveryIdentityError(
      "ambiguous_ownership",
      error instanceof Error ? error.message : "protected secret reference is invalid",
    );
  }
  if (!ref.startsWith(`binding:${connectionBindingId}:`)) {
    throw new RecoveryIdentityError("ambiguous_ownership", "protected secret reference is not scoped to the connection binding");
  }
}

/** Canonicalize an existing directory using the platform's native realpath. */
export function canonicalizeRecoveryRoot(input: string): string {
  if (!isNonEmptyString(input) || input.includes("\0")) {
    throw new RecoveryIdentityError("identity_mismatch", "recovery root is invalid");
  }
  const resolved = path.resolve(input);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    throw new RecoveryIdentityError("identity_mismatch", "recovery root does not exist");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new RecoveryIdentityError("identity_mismatch", "recovery root cannot be inspected");
  }
  if (!stat.isDirectory()) throw new RecoveryIdentityError("identity_mismatch", "recovery root is not a directory");
  // native realpath already resolves junctions/symlinks; normalize drive/case
  // so comparisons are stable across Windows process restarts.
  const normalized = path.normalize(real);
  return process.platform === "win32"
    ? normalized.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`).toLowerCase()
    : normalized;
}

export function recoveryPathEquals(left: string, right: string): boolean {
  const a = canonicalizeRecoveryRoot(left);
  const b = canonicalizeRecoveryRoot(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validHealth(value: unknown): value is RecoveryHealth {
  return value === "unknown" || value === "healthy" || value === "stopped" || value === "ambiguous" || value === "waiting";
}

function validRecord(value: unknown): value is RecoveryBindingRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!isNonEmptyString(value.connectionBindingId) || !isNonEmptyString(value.projectName)) return false;
  if (!isNonEmptyString(value.canonicalAllowedRoot) || !isNonEmptyString(value.tunnelProfileRef)) return false;
  if (!isNonEmptyString(value.protectedSecretRef)) return false;
  if (!value.protectedSecretRef.startsWith(`binding:${value.connectionBindingId}:`)) return false;
  if (value.startupPolicy !== "user_logon" && value.startupPolicy !== "manual") return false;
  if (!validHealth(value.observedHealth) || !isNonEmptyString(value.updatedAt)) return false;
  if (!isRecord(value.ownership) || !isNonEmptyString(value.ownership.ownerMarker)) return false;
  if (value.ownership.createdBy !== "preExisting" && value.ownership.createdBy !== "p0-2") return false;
  if (!isRecord(value.capability) || !isNonEmptyString(value.capability.protectedSecretProvider) || !isNonEmptyString(value.capability.tunnelProvider) || !isNonEmptyString(value.capability.verifiedAt)) return false;
  const snapshot = value.identitySnapshot;
  if (!isRecord(snapshot)) return false;
  return (
    isNonEmptyString(snapshot.workspace) &&
    isNonEmptyString(snapshot.canonicalRepository) &&
    isNonEmptyString(snapshot.installationId) &&
    (snapshot.endpointMode === "stable" || snapshot.endpointMode === "ephemeral" || snapshot.endpointMode === "local") &&
    isNonEmptyString(snapshot.endpointFingerprint) &&
    isNonEmptyString(snapshot.connectorName)
  );
}

export function readRecoveryBinding(connectionBindingId: string): RecoveryBindingRecord | null {
  const value = readJsonIfExists<unknown>(recoveryBindingFile(connectionBindingId));
  return validRecord(value) ? value : null;
}

/**
 * Produce the only capability value accepted by durable recovery seeding.
 * The attestation is created after inspecting concrete providers and proving
 * that both consume secrets in-process; provider-name strings alone cannot
 * manufacture a verified record.
 */
export async function attestRecoveryCapabilities(input: {
  connectionBindingId: string;
  protectedSecretRef: string;
  tunnelProfileRef: string;
  secretStore: ProtectedSecretStore;
  tunnelAdapter: SecureTunnelAdapter;
}): Promise<RecoveryCapabilityAttestation> {
  assertBindingScopedSecretRef(input.protectedSecretRef, input.connectionBindingId);
  if (!isNonEmptyString(input.tunnelProfileRef)) {
    throw new RecoveryIdentityError("ambiguous_ownership", "tunnel profile reference is invalid");
  }
  const [secret, tunnel] = await Promise.all([input.secretStore.inspect(), input.tunnelAdapter.inspect()]);
  if (!secret.available || input.secretStore.consumption !== "in_process") {
    throw new RecoveryIdentityError("ambiguous_ownership", secret.reason ?? "protected-secret capability is not verified in-process");
  }
  if (!tunnel.available || input.tunnelAdapter.consumption !== "in_process") {
    throw new RecoveryIdentityError("ambiguous_ownership", tunnel.reason ?? "tunnel capability is not verified in-process");
  }
  if (!isNonEmptyString(secret.provider) || !isNonEmptyString(tunnel.provider)) {
    throw new RecoveryIdentityError("ambiguous_ownership", "capability provider identity is missing");
  }
  if (!input.secretStore.verifyReference || !(await input.secretStore.verifyReference(input.protectedSecretRef))) {
    throw new RecoveryIdentityError("ambiguous_ownership", "protected secret reference is not verified by the selected store");
  }
  if (!input.tunnelAdapter.verifyProfile || !(await input.tunnelAdapter.verifyProfile(input.tunnelProfileRef))) {
    throw new RecoveryIdentityError("ambiguous_ownership", "tunnel profile reference is not verified by the selected adapter");
  }
  const attestation = {
    connectionBindingId: input.connectionBindingId,
    protectedSecretRef: input.protectedSecretRef,
    tunnelProfileRef: input.tunnelProfileRef,
    protectedSecretProvider: secret.provider,
    tunnelProvider: tunnel.provider,
    verifiedAt: new Date().toISOString(),
  } as RecoveryCapabilityAttestation;
  Object.defineProperty(attestation, CAPABILITY_ATTESTATION, { value: true, enumerable: false });
  return attestation;
}

/**
 * Validate a recovery record against the authoritative ConnectionBinding and
 * the caller's exact workspace. Snapshot fields can never override identity.
 */
export function validateRecoveryBinding(
  record: RecoveryBindingRecord,
  expectedRoot: string,
  authoritative?: ConnectionBinding | null,
): RecoveryBindingRecord {
  if (!validRecord(record)) throw new RecoveryIdentityError("identity_mismatch", "malformed recovery binding");
  const binding = authoritative ?? readConnectionBinding(record.connectionBindingId);
  if (!binding) {
    throw new RecoveryIdentityError("ambiguous_ownership", `authoritative connection binding is unavailable: ${record.connectionBindingId}`);
  }
  if (binding.workspaceId !== record.connectionBindingId) {
    throw new RecoveryIdentityError("identity_mismatch", "recovery locator does not match ConnectionBinding.workspaceId");
  }
  let root = canonicalizeRecoveryRoot(expectedRoot);
  let storedRoot = canonicalizeRecoveryRoot(record.canonicalAllowedRoot);
  if (!recoveryPathEquals(root, storedRoot)) {
    throw new RecoveryIdentityError("identity_mismatch", "workspace root is outside the canonical recovery policy");
  }
  // Re-resolve through Workspace so a root that changed via a junction cannot
  // be accepted merely because its text still looks identical.
  const workspace = new Workspace(root);
  if (workspace.id !== binding.workspaceId) {
    throw new RecoveryIdentityError("identity_mismatch", "workspace root does not resolve to the authoritative binding");
  }
  const snapshot = record.identitySnapshot;
  if (
    snapshot.workspace !== binding.workspace ||
    snapshot.canonicalRepository !== binding.canonicalRepository ||
    snapshot.installationId !== binding.installationId ||
    snapshot.endpointMode !== binding.endpointMode ||
    snapshot.endpointFingerprint !== binding.endpointFingerprint ||
    snapshot.connectorName !== binding.connectorName
  ) {
    throw new RecoveryIdentityError("identity_mismatch", "recovery identity snapshot disagrees with ConnectionBinding");
  }
  // Keep the exact canonical spelling that this process observed. The root is
  // a policy value, not a user-controlled redirect.
  storedRoot = root;
  return { ...record, canonicalAllowedRoot: storedRoot };
}

export function seedRecoveryBinding(input: {
  root: string;
  binding?: ConnectionBinding | null;
  tunnelProfileRef?: string;
  protectedSecretRef?: string;
  startupPolicy?: StartupPolicy;
  createdBy?: SecretOwnership;
  capability?: RecoveryCapabilityAttestation;
}): RecoveryBindingRecord {
  const root = canonicalizeRecoveryRoot(input.root);
  const workspace = new Workspace(root);
  const binding = input.binding ?? readConnectionBinding(workspace.id);
  if (!binding || binding.workspaceId !== workspace.id) {
    throw new RecoveryIdentityError("ambiguous_ownership", "cannot seed recovery without an authoritative ConnectionBinding");
  }
  if (
    !input.tunnelProfileRef ||
    !input.protectedSecretRef ||
    !input.capability ||
    input.capability[CAPABILITY_ATTESTATION] !== true ||
    !isNonEmptyString(input.capability.protectedSecretProvider) ||
    !isNonEmptyString(input.capability.tunnelProvider) ||
    /^(?:none|unavailable|unsupported)$/i.test(input.capability.protectedSecretProvider) ||
    /^(?:none|unavailable|unsupported)$/i.test(input.capability.tunnelProvider)
  ) {
    throw new RecoveryIdentityError(
      "ambiguous_ownership",
      "recovery seeding requires verified tunnel and protected-secret capability references",
    );
  }
  assertBindingScopedSecretRef(input.protectedSecretRef, binding.workspaceId);
  if (
    input.capability.connectionBindingId !== binding.workspaceId ||
    input.capability.protectedSecretRef !== input.protectedSecretRef ||
    input.capability.tunnelProfileRef !== input.tunnelProfileRef
  ) {
    throw new RecoveryIdentityError(
      "ambiguous_ownership",
      "capability attestation is not bound to the exact recovery resources",
    );
  }
  const record: RecoveryBindingRecord = {
    schemaVersion: 1,
    connectionBindingId: binding.workspaceId,
    projectName: binding.workspace,
    canonicalAllowedRoot: root,
    tunnelProfileRef: input.tunnelProfileRef,
    protectedSecretRef: input.protectedSecretRef,
    startupPolicy: input.startupPolicy ?? "user_logon",
    ownership: {
      createdBy: input.createdBy ?? "preExisting",
      ownerMarker: `p0-2:${binding.workspaceId}`,
    },
    capability: {
      protectedSecretProvider: input.capability.protectedSecretProvider,
      tunnelProvider: input.capability.tunnelProvider,
      verifiedAt: new Date().toISOString(),
    },
    observedHealth: "unknown",
    identitySnapshot: {
      workspace: binding.workspace,
      canonicalRepository: binding.canonicalRepository,
      installationId: binding.installationId,
      endpointMode: binding.endpointMode,
      endpointFingerprint: binding.endpointFingerprint,
      connectorName: binding.connectorName,
    },
    updatedAt: new Date().toISOString(),
  };
  writeSecureAtomicJson(recoveryBindingFile(binding.workspaceId), record);
  return record;
}

export function writeRecoveryBinding(record: RecoveryBindingRecord): RecoveryBindingRecord {
  if (!validRecord(record)) throw new RecoveryIdentityError("identity_mismatch", "malformed recovery binding");
  writeSecureAtomicJson(recoveryBindingFile(record.connectionBindingId), {
    ...record,
    updatedAt: new Date().toISOString(),
  });
  return readRecoveryBinding(record.connectionBindingId) ?? record;
}

export function recoveryBindingDigest(record: RecoveryBindingRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16);
}

export function authoritativeBindingPath(connectionBindingId: string): string {
  return bindingFile(connectionBindingId);
}
