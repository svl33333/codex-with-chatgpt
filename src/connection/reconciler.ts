import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { ConnectionBinding } from "./identity.js";

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
}

export interface ConnectionAdapter {
  listConnectors(): Promise<ConnectorRecord[]>;
  createConnector(binding: ConnectionBinding): Promise<ConnectorRecord>;
  deleteConnector(connectorId: string): Promise<void>;
  workspaceInfo(connector: ConnectorRecord): Promise<{
    workspace: string;
    repository: string;
    ok: boolean;
  }>;
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
  mutations: { create: number; delete: number }
): ReconcileOutcome {
  checkpoint.phase = checkpoint.phase === "VERIFY_ABSENT" ? "VERIFY_ABSENT" : "PREFLIGHT";
  saveCheckpoint(checkpoint);
  return {
    status: "CONNECTION_WAITING",
    phase: checkpoint.phase,
    operationKey: checkpoint.operationKey,
    reason,
    mutations,
    checkpoint,
  };
}

async function reconcileUnlocked(binding: ConnectionBinding, adapter: ConnectionAdapter): Promise<ReconcileOutcome> {
  const operationKey = connectionOperationKey(binding);
  const checkpoint = readCheckpoint(operationKey, binding);
  const mutations = { create: 0, delete: 0 };
  let connectors: ConnectorRecord[];
  try {
    connectors = await adapter.listConnectors();
  } catch {
    return waiting(checkpoint, "connector list unavailable", mutations);
  }

  const exact = connectors.filter((connector) => sameEndpoint(connector, binding));
  if (exact.length > 1) return waiting(checkpoint, "multiple connectors match the binding", mutations);
  const namedForeign = connectors.filter((connector) => connector.name === binding.connectorName && !matchesBinding(connector, binding));
  if (namedForeign.length > 0) return waiting(checkpoint, "connector name is owned by another binding", mutations);

  if (exact.length === 1) {
    checkpoint.phase = "VERIFY";
    checkpoint.connectorId = exact[0].id;
    saveCheckpoint(checkpoint);
    let info: { workspace: string; repository: string; ok: boolean };
    try {
      info = await adapter.workspaceInfo(exact[0]);
    } catch {
      return waiting(checkpoint, "workspace_info unavailable", mutations);
    }
    if (!info.ok) return waiting(checkpoint, "workspace_info rejected the connector", mutations);
    if (info.workspace !== binding.workspace || info.repository !== binding.canonicalRepository) {
      return {
        status: "BLOCKED",
        phase: "VERIFY",
        operationKey,
        reason: "workspace or repository mismatch",
        mutations,
        checkpoint,
      };
    }
    checkpoint.phase = "REUSE";
    saveCheckpoint(checkpoint);
    return { status: "READY", phase: "REUSE", operationKey, connector: exact[0], mutations, checkpoint };
  }

  // Only an owned connector with a changed endpoint may be deleted.
  const ownedOld = connectors.filter((connector) => matchesBinding(connector, binding));
  if (ownedOld.length > 1) return waiting(checkpoint, "multiple owned connector candidates", mutations);
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
      const afterDelete = await adapter.listConnectors().catch(() => null);
      if (!afterDelete) return waiting(checkpoint, "delete result unknown", mutations);
      if (afterDelete.some((connector) => connector.id === ownedOld[0].id)) {
        return waiting(checkpoint, "delete result unknown; connector still present", mutations);
      }
    }
    checkpoint.phase = "VERIFY_ABSENT";
    saveCheckpoint(checkpoint);
    const absent = await adapter.listConnectors().catch(() => null);
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
    const info = await adapter.workspaceInfo(created).catch(() => null);
    if (!info || !info.ok) return waiting(checkpoint, "created connector could not be verified", mutations);
    if (info.workspace !== binding.workspace || info.repository !== binding.canonicalRepository) {
      return {
        status: "BLOCKED",
        phase: "VERIFY",
        operationKey,
        reason: "created connector workspace or repository mismatch",
        mutations,
        checkpoint,
      };
    }
    checkpoint.phase = "REUSE";
    saveCheckpoint(checkpoint);
    return { status: "READY", phase: "REUSE", operationKey, connector: created, mutations, checkpoint };
  } catch {
    // A transport timeout is not evidence of absence. Reconcile the list first.
    const afterCreate = await adapter.listConnectors().catch(() => null);
    if (!afterCreate) return waiting(checkpoint, "create result unknown", mutations);
    const accepted = afterCreate.filter((connector) => sameEndpoint(connector, binding));
    if (accepted.length === 1) {
      const info = await adapter.workspaceInfo(accepted[0]).catch(() => null);
      if (info?.ok && info.workspace === binding.workspace && info.repository === binding.canonicalRepository) {
        checkpoint.connectorId = accepted[0].id;
        checkpoint.phase = "REUSE";
        saveCheckpoint(checkpoint);
        return { status: "READY", phase: "REUSE", operationKey, connector: accepted[0], mutations, checkpoint };
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
