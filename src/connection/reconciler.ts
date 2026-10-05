import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { ConnectionBinding } from "./identity.js";
import { classifyConnectionOutcome, type SurfaceOutcome } from "../provisioning/chatgpt-surface.js";

export type ReconcileStatus = "READY" | "CONNECTION_WAITING" | "BLOCKED";
export type ReconcilePhase =
  | "PREFLIGHT"
  | "REUSE"
  | "CREATE_RESERVED"
  | "CREATE"
  | "VERIFY"
  | "DELETE_RESERVED"
  | "VERIFY_ABSENT";

export interface ConnectorRecord {
  id: string;
  name: string;
  workspace: string;
  repository: string;
  installationId: string;
  endpointMode: ConnectionBinding["endpointMode"];
  endpointFingerprint: string;
  accountFingerprint?: string;
  selectedSurface?: string;
  projectBinding?: string;
  readOnly?: boolean;
}

export interface ConnectorVerification {
  workspace: string;
  repository: string;
  ok: boolean;
  accountFingerprint?: string;
  projectBinding?: string;
  readOnly?: boolean;
  selectedSurface?: string;
  messageSelectionVerified?: boolean;
}

export interface ConnectionAdapter {
  listConnectors(): Promise<ConnectorRecord[]>;
  createConnector(binding: ConnectionBinding): Promise<ConnectorRecord>;
  deleteConnector(connectorId: string): Promise<void>;
  workspaceInfo(connector: ConnectorRecord): Promise<ConnectorVerification>;
}

export interface ReconcileCheckpoint {
  schemaVersion: 1;
  operationKey: string;
  binding: Pick<
    ConnectionBinding,
    | "workspace"
    | "canonicalRepository"
    | "installationId"
    | "endpointMode"
    | "endpointFingerprint"
    | "connectorName"
  >;
  phase: ReconcilePhase;
  createAttempts: number;
  deleteAttempts: number;
  connectorId?: string;
  updatedAt: string;
}

export interface ReconcileOutcome {
  status: ReconcileStatus;
  phase: ReconcilePhase;
  operationKey: string;
  connector?: ConnectorRecord;
  reason?: string;
  compatibilityOutcome: SurfaceOutcome;
  mutations: { create: number; delete: number };
  checkpoint: ReconcileCheckpoint;
}

const locks = new Map<string, Promise<void>>();

export function connectionOperationKey(binding: ConnectionBinding): string {
  const raw = [
    binding.workspace,
    binding.canonicalRepository,
    binding.installationId,
    binding.endpointFingerprint,
    binding.connectorName,
  ].join("\0");
  // The fingerprint is intentionally opaque and safe to use as a filename.
  return `connection-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function checkpointFile(operationKey: string): string {
  return path.join(getStateDir(), "operations", `${operationKey}.json`);
}

function readCheckpoint(operationKey: string, binding: ConnectionBinding): ReconcileCheckpoint {
  const existing = readJsonIfExists<ReconcileCheckpoint>(checkpointFile(operationKey));
  if (
    existing?.schemaVersion === 1 &&
    existing.operationKey === operationKey &&
    existing.binding.workspace === binding.workspace &&
    existing.binding.canonicalRepository === binding.canonicalRepository &&
    existing.binding.installationId === binding.installationId &&
    existing.binding.endpointFingerprint === binding.endpointFingerprint &&
    existing.binding.connectorName === binding.connectorName
  ) {
    return existing;
  }
  return {
    schemaVersion: 1,
    operationKey,
    binding: {
      workspace: binding.workspace,
      canonicalRepository: binding.canonicalRepository,
      installationId: binding.installationId,
      endpointMode: binding.endpointMode,
      endpointFingerprint: binding.endpointFingerprint,
      connectorName: binding.connectorName,
    },
    phase: "PREFLIGHT",
    createAttempts: 0,
    deleteAttempts: 0,
    updatedAt: new Date().toISOString(),
  };
}

function saveCheckpoint(checkpoint: ReconcileCheckpoint): void {
  writeSecureJson(checkpointFile(checkpoint.operationKey), {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  });
}

function matchesBinding(connector: ConnectorRecord, binding: ConnectionBinding): boolean {
  return (
    connector.name === binding.connectorName &&
    connector.workspace === binding.workspace &&
    connector.repository === binding.canonicalRepository &&
    connector.installationId === binding.installationId
  );
}

function sameEndpoint(connector: ConnectorRecord, binding: ConnectionBinding): boolean {
  return (
    matchesBinding(connector, binding) &&
    connector.endpointMode === binding.endpointMode &&
    connector.endpointFingerprint === binding.endpointFingerprint
  );
}

function waiting(
  checkpoint: ReconcileCheckpoint,
  reason: string,
  mutations: { create: number; delete: number },
  compatibilityOutcome: SurfaceOutcome = "RECOVERABLE_FAILURE"
): ReconcileOutcome {
  checkpoint.phase = checkpoint.phase === "VERIFY_ABSENT" ? "VERIFY_ABSENT" : "PREFLIGHT";
  saveCheckpoint(checkpoint);
  return {
    status: "CONNECTION_WAITING",
    phase: checkpoint.phase,
    operationKey: checkpoint.operationKey,
    reason,
    compatibilityOutcome,
    mutations,
    checkpoint,
  };
}

type VerificationDecision =
  | { kind: "valid" }
  | { kind: "waiting"; reason: string }
  | { kind: "blocked"; reason: string };

function validateConnectorVerification(
  binding: ConnectionBinding,
  info: ConnectorVerification
): VerificationDecision {
  if (!info.ok) return { kind: "waiting", reason: "workspace_info rejected the connector" };
  if (info.workspace !== binding.workspace || info.repository !== binding.canonicalRepository) {
    return { kind: "blocked", reason: "workspace or repository mismatch" };
  }
  if (binding.accountFingerprint) {
    if (!info.accountFingerprint) return { kind: "waiting", reason: "account proof unavailable" };
    if (info.accountFingerprint !== binding.accountFingerprint) {
      return { kind: "blocked", reason: "account proof mismatch" };
    }
  }
  if (binding.projectId) {
    if (!info.projectBinding) return { kind: "waiting", reason: "project binding proof unavailable" };
    if (info.projectBinding !== binding.projectId) return { kind: "blocked", reason: "project binding mismatch" };
  }
  if (binding.readOnlyRequired) {
    if (info.readOnly === undefined) return { kind: "waiting", reason: "read-only proof unavailable" };
    if (!info.readOnly) return { kind: "blocked", reason: "connector is not read-only" };
  }
  return { kind: "valid" };
}

function blockedOutcome(
  checkpoint: ReconcileCheckpoint,
  operationKey: string,
  reason: string,
  mutations: { create: number; delete: number }
): ReconcileOutcome {
  const classified = classifyConnectionOutcome("BLOCKED", mutations, reason);
  return {
    status: "BLOCKED",
    phase: checkpoint.phase,
    operationKey,
    reason,
    compatibilityOutcome: classified.outcome,
    mutations,
    checkpoint,
  };
}

/**
 * Browser/connector reads can fail transiently. Retry reads only, with a
 * bounded attempt count; mutations remain strictly checkpointed and explicit.
 */
async function readWithRetry<T>(read: () => Promise<T>, attempts = 2): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch {
      if (attempt + 1 === attempts) return null;
    }
  }
  return null;
}

async function reconcileUnlocked(binding: ConnectionBinding, adapter: ConnectionAdapter): Promise<ReconcileOutcome> {
  const operationKey = connectionOperationKey(binding);
  const checkpoint = readCheckpoint(operationKey, binding);
  const mutations = { create: 0, delete: 0 };
  const initialConnectors = await readWithRetry(() => adapter.listConnectors());
  if (!initialConnectors) {
    return waiting(checkpoint, "connector list unavailable", mutations);
  }
  let connectors = initialConnectors;

  const exact = connectors.filter((connector) => sameEndpoint(connector, binding));
  if (exact.length > 1) return waiting(checkpoint, "multiple connectors match the binding", mutations, "HUMAN_BOUNDARY");
  const namedForeign = connectors.filter((connector) => connector.name === binding.connectorName && !matchesBinding(connector, binding));
  if (namedForeign.length > 0) return waiting(checkpoint, "connector name is owned by another binding", mutations, "HUMAN_BOUNDARY");

  if (exact.length === 1) {
    checkpoint.phase = "VERIFY";
    checkpoint.connectorId = exact[0].id;
    saveCheckpoint(checkpoint);
    let info: { workspace: string; repository: string; ok: boolean };
    const verified = await readWithRetry(() => adapter.workspaceInfo(exact[0]));
    if (!verified) {
      return waiting(checkpoint, "workspace_info unavailable", mutations);
    }
    info = verified;
    const decision = validateConnectorVerification(binding, info);
    if (decision.kind === "waiting") return waiting(checkpoint, decision.reason, mutations);
    if (decision.kind === "blocked") return blockedOutcome(checkpoint, operationKey, decision.reason, mutations);
    checkpoint.phase = "REUSE";
    saveCheckpoint(checkpoint);
    return {
      status: "READY",
      phase: "REUSE",
      operationKey,
      connector: exact[0],
      compatibilityOutcome: classifyConnectionOutcome("READY", mutations).outcome,
      mutations,
      checkpoint,
    };
  }

  // Only an owned connector with a changed endpoint may be deleted.
  const ownedOld = connectors.filter((connector) => matchesBinding(connector, binding));
  if (ownedOld.length > 1) return waiting(checkpoint, "multiple owned connector candidates", mutations, "HUMAN_BOUNDARY");
  if (ownedOld.length === 1) {
    if (checkpoint.deleteAttempts > 0 && checkpoint.phase === "VERIFY_ABSENT") {
      // A previous delete timed out. Re-listing above is the authoritative check.
      return waiting(checkpoint, "delete result remains uncertain", mutations);
    }
    checkpoint.phase = "DELETE_RESERVED";
    checkpoint.connectorId = ownedOld[0].id;
    saveCheckpoint(checkpoint);
    checkpoint.deleteAttempts += 1;
    saveCheckpoint(checkpoint);
    try {
      await adapter.deleteConnector(ownedOld[0].id);
      mutations.delete += 1;
    } catch {
      checkpoint.phase = "VERIFY_ABSENT";
      saveCheckpoint(checkpoint);
      const afterDelete = await readWithRetry(() => adapter.listConnectors());
      if (!afterDelete) return waiting(checkpoint, "delete result unknown", mutations);
      if (afterDelete.some((connector) => connector.id === ownedOld[0].id)) {
        return waiting(checkpoint, "delete result unknown; connector still present", mutations);
      }
    }
    checkpoint.phase = "VERIFY_ABSENT";
    saveCheckpoint(checkpoint);
    const absent = await readWithRetry(() => adapter.listConnectors());
    if (!absent) return waiting(checkpoint, "delete absence could not be verified", mutations);
    if (absent.some((connector) => connector.id === ownedOld[0].id)) {
      return waiting(checkpoint, "owned connector was not deleted", mutations);
    }
    connectors = absent;
  }

  if (checkpoint.createAttempts > 0) {
    return waiting(checkpoint, "create result unknown; refusing duplicate create", mutations);
  }
  checkpoint.phase = "CREATE_RESERVED";
  saveCheckpoint(checkpoint);
  checkpoint.createAttempts += 1;
  checkpoint.phase = "CREATE";
  saveCheckpoint(checkpoint);
  try {
    const created = await adapter.createConnector(binding);
    mutations.create += 1;
    checkpoint.connectorId = created.id;
    checkpoint.phase = "VERIFY";
    saveCheckpoint(checkpoint);
    const info = await readWithRetry(() => adapter.workspaceInfo(created));
    if (!info) return waiting(checkpoint, "created connector could not be verified", mutations);
    const decision = validateConnectorVerification(binding, info);
    if (decision.kind === "waiting") return waiting(checkpoint, decision.reason, mutations);
    if (decision.kind === "blocked") return blockedOutcome(checkpoint, operationKey, decision.reason, mutations);
    checkpoint.phase = "REUSE";
    saveCheckpoint(checkpoint);
    return {
      status: "READY",
      phase: "REUSE",
      operationKey,
      connector: created,
      compatibilityOutcome: classifyConnectionOutcome("READY", mutations).outcome,
      mutations,
      checkpoint,
    };
  } catch {
    // A transport timeout is not evidence of absence. Reconcile the list first.
    const afterCreate = await readWithRetry(() => adapter.listConnectors());
    if (!afterCreate) return waiting(checkpoint, "create result unknown", mutations);
    const accepted = afterCreate.filter((connector) => sameEndpoint(connector, binding));
    if (accepted.length === 1) {
      const info = await readWithRetry(() => adapter.workspaceInfo(accepted[0]));
      if (info) {
        const decision = validateConnectorVerification(binding, info);
        if (decision.kind === "valid") {
          checkpoint.connectorId = accepted[0].id;
          checkpoint.phase = "REUSE";
          saveCheckpoint(checkpoint);
          return {
            status: "READY",
            phase: "REUSE",
            operationKey,
            connector: accepted[0],
            compatibilityOutcome: classifyConnectionOutcome("READY", mutations).outcome,
            mutations,
            checkpoint,
          };
        }
      }
    }
    return waiting(checkpoint, "create result unknown; no verified connector", mutations);
  }
}

/** Reconcile a connector under a binding lock; normal reuse performs zero mutations. */
export async function reconcileConnection(binding: ConnectionBinding, adapter: ConnectionAdapter): Promise<ReconcileOutcome> {
  const key = `${binding.workspaceId}:${binding.installationId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await reconcileUnlocked(binding, adapter);
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}
