import { createHash } from "node:crypto";
import { ensureBridge, type EnsureBridgeResult } from "../process/daemon.js";
import { readConnectionBinding } from "../connection/identity.js";
import { writeSecureAtomicJson, readJsonIfExists } from "../config/paths.js";
import {
  readRecoveryBinding,
  recoveryCheckpointFile,
  recoveryBindingFile,
  RecoveryIdentityError,
  validateRecoveryBinding,
  writeRecoveryBinding,
  type RecoveryBindingRecord,
  type RecoveryHealth,
} from "./bindings.js";
import { acquireBindingLock, RecoveryLockError, type BindingLock } from "./locks.js";
import {
  assertOpaqueSecretRef,
  ProtectedSecretError,
  UnsupportedProtectedSecretStore,
  type ProtectedSecretStore,
} from "./secret-store.js";
import {
  SecureTunnelCapabilityError,
  UnsupportedSecureTunnelAdapter,
  type SecureTunnelAdapter,
} from "./tunnel-adapter.js";
import { observeOwnedBridge, type OwnedBridgeObservation } from "./bridge-observation.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";

export type RecoveryPhase =
  | "LOAD_BINDING"
  | "OBSERVE_BRIDGE"
  | "START_BRIDGE"
  | "RESOLVE_SECRET"
  | "RECONCILE_TUNNEL"
  | "VERIFY"
  | "COMMIT_STATE";

export type RecoveryStatus =
  | "healthy"
  | "reused"
  | "started"
  | "tunnel_reconciled"
  | "identity_mismatch"
  | "ambiguous_ownership"
  | "protected_secret_unavailable"
  | "unsupported_tunnel_capability"
  | "recovery_waiting";

export interface RecoveryCheckpoint {
  schemaVersion: 1;
  connectionBindingId: string;
  operationKey: string;
  phase: RecoveryPhase;
  status: RecoveryStatus;
  observedEndpointFingerprint: string | null;
  updatedAt: string;
}

export interface RecoveryOutcome {
  ok: boolean;
  status: RecoveryStatus;
  phase: RecoveryPhase;
  connectionBindingId: string;
  reason?: string;
  bridge: {
    state: OwnedBridgeObservation["state"];
    started: boolean;
    port: number | null;
  };
  tunnel: {
    provider: string | null;
    running: boolean | null;
    url: string | null;
  };
  checkpoint: RecoveryCheckpoint;
}

export interface RecoveryCoordinatorOptions {
  secretStore?: ProtectedSecretStore;
  tunnelAdapter?: SecureTunnelAdapter;
  ensureBridge?: (root: string) => Promise<EnsureBridgeResult>;
  observeBridge?: (root: string, record: RecoveryBindingRecord) => Promise<OwnedBridgeObservation>;
  lockWaitMs?: number;
}

function operationKey(bindingId: string, endpointFingerprint: string): string {
  return createHash("sha256").update(`${bindingId}\0recovery\0${endpointFingerprint}`).digest("hex").slice(0, 32);
}

function initialCheckpoint(bindingId: string, key: string): RecoveryCheckpoint {
  const existing = readJsonIfExists<RecoveryCheckpoint>(recoveryCheckpointFile(bindingId));
  if (
    existing?.schemaVersion === 1 &&
    existing.connectionBindingId === bindingId &&
    existing.operationKey === key
  ) return existing;
  return {
    schemaVersion: 1,
    connectionBindingId: bindingId,
    operationKey: key,
    phase: "LOAD_BINDING",
    status: "recovery_waiting",
    observedEndpointFingerprint: null,
    updatedAt: new Date().toISOString(),
  };
}

function saveCheckpoint(checkpoint: RecoveryCheckpoint): RecoveryCheckpoint {
  const updated = { ...checkpoint, updatedAt: new Date().toISOString() };
  writeSecureAtomicJson(recoveryCheckpointFile(checkpoint.connectionBindingId), updated);
  return updated;
}

function safeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const sanitized = sanitizeExecutionOutput(reason);
  return sanitized.allowed ? sanitized.text : "diagnostic output withheld";
}

function outcome(
  checkpoint: RecoveryCheckpoint,
  fields: Omit<RecoveryOutcome, "checkpoint" | "connectionBindingId" | "phase" | "status" | "ok"> &
    Partial<Pick<RecoveryOutcome, "reason">>,
): RecoveryOutcome {
  return {
    ok: checkpoint.status === "healthy" || checkpoint.status === "reused" || checkpoint.status === "started" || checkpoint.status === "tunnel_reconciled",
    status: checkpoint.status,
    phase: checkpoint.phase,
    connectionBindingId: checkpoint.connectionBindingId,
    checkpoint,
    ...fields,
    ...(fields.reason ? { reason: safeReason(fields.reason) } : {}),
  };
}

function bridgeResult(observation: OwnedBridgeObservation, started: boolean): RecoveryOutcome["bridge"] {
  return {
    state: observation.state,
    started,
    port: observation.state === "healthy" ? observation.info.port : observation.runtime?.port ?? null,
  };
}

function tunnelResult(observation: OwnedBridgeObservation, adapter: SecureTunnelAdapter, running: boolean | null, url: string | null): RecoveryOutcome["tunnel"] {
  return {
    provider: observation.state === "healthy" ? (running ? adapter.name : observation.info.tunnel.provider || null) : null,
    running,
    url,
  };
}

/** Execute one bounded, lock-serialized recovery attempt. */
export async function recoverBinding(
  root: string,
  connectionBindingId: string,
  options: RecoveryCoordinatorOptions = {},
): Promise<RecoveryOutcome> {
  const secretStore = options.secretStore ?? new UnsupportedProtectedSecretStore();
  const tunnelAdapter = options.tunnelAdapter ?? new UnsupportedSecureTunnelAdapter();
  const ensure = options.ensureBridge ?? (async (workspaceRoot: string) => ensureBridge(workspaceRoot));
  const observe = options.observeBridge ?? observeOwnedBridge;
  let checkpoint = initialCheckpoint(connectionBindingId, "unresolved");
  let currentObservation: OwnedBridgeObservation = { state: "ambiguous", runtime: null, reason: "not observed" };
  let started = false;
  let tunnelReconciled = false;
  let tunnelRunning: boolean | null = null;
  let tunnelUrl: string | null = null;
  let bindingLock: BindingLock | null = null;
  const persistFailure = (status: RecoveryStatus): RecoveryCheckpoint => {
    checkpoint.status = status;
    // Only the process that owns the binding lock may persist an authoritative
    // failure checkpoint. Lock acquisition failures return an in-memory result.
    return bindingLock ? saveCheckpoint(checkpoint) : { ...checkpoint, updatedAt: new Date().toISOString() };
  };
  try {
    bindingLock = await acquireBindingLock(connectionBindingId, { waitMs: options.lockWaitMs });
      checkpoint.phase = "LOAD_BINDING";
      const raw = readRecoveryBinding(connectionBindingId);
      if (!raw) {
        checkpoint.status = "identity_mismatch";
        checkpoint = saveCheckpoint(checkpoint);
        return outcome(checkpoint, {
          reason: `recovery binding is missing or malformed: ${recoveryBindingFile(connectionBindingId)}`,
          bridge: { state: "ambiguous", started: false, port: null },
          tunnel: { provider: null, running: null, url: null },
        });
      }
      const binding = readConnectionBinding(connectionBindingId);
      const validated = validateRecoveryBinding(raw, root, binding);
      const key = operationKey(validated.connectionBindingId, validated.identitySnapshot.endpointFingerprint);
      checkpoint = initialCheckpoint(connectionBindingId, key);
      checkpoint.phase = "OBSERVE_BRIDGE";
      checkpoint.observedEndpointFingerprint = validated.identitySnapshot.endpointFingerprint;
      checkpoint = saveCheckpoint(checkpoint);

      currentObservation = await observe(root, validated);
      if (currentObservation.state === "ambiguous") {
        checkpoint.status = "ambiguous_ownership";
        checkpoint = saveCheckpoint(checkpoint);
        return outcome(checkpoint, {
          reason: currentObservation.reason,
          bridge: bridgeResult(currentObservation, false),
          tunnel: { provider: null, running: null, url: null },
        });
      }
      if (currentObservation.state === "stopped") {
        checkpoint.phase = "START_BRIDGE";
        checkpoint = saveCheckpoint(checkpoint);
        await ensure(root);
        started = true;
        currentObservation = await observe(root, validated);
        if (currentObservation.state !== "healthy") {
          checkpoint.status = currentObservation.state === "ambiguous" ? "ambiguous_ownership" : "recovery_waiting";
          checkpoint = saveCheckpoint(checkpoint);
          return outcome(checkpoint, {
            reason: currentObservation.reason,
            bridge: bridgeResult(currentObservation, started),
            tunnel: { provider: null, running: null, url: null },
          });
        }
      }

      checkpoint.phase = "RESOLVE_SECRET";
      checkpoint = saveCheckpoint(checkpoint);
      assertOpaqueSecretRef(validated.protectedSecretRef);
      // Revalidate the tunnel provider/profile before deciding whether a
      // secret is needed. A healthy exact tunnel is a no-op and must remain
      // reusable during a temporary protected-secret outage.
      const tunnelCapability = await tunnelAdapter.inspect();
      if (
        !tunnelCapability.available ||
        tunnelAdapter.consumption !== "in_process" ||
        tunnelCapability.provider !== validated.capability.tunnelProvider ||
        !tunnelAdapter.verifyProfile ||
        !(await tunnelAdapter.verifyProfile(validated.tunnelProfileRef))
      ) {
        checkpoint.status = "unsupported_tunnel_capability";
        checkpoint = saveCheckpoint(checkpoint);
        return outcome(checkpoint, {
          reason: tunnelCapability.reason ?? "tunnel profile/provider ownership could not be revalidated",
          bridge: bridgeResult(currentObservation, started),
          tunnel: { provider: currentObservation.info.tunnel.provider || null, running: currentObservation.info.tunnel.running, url: currentObservation.info.tunnel.url },
        });
      }

      checkpoint.phase = "RECONCILE_TUNNEL";
      checkpoint = saveCheckpoint(checkpoint);
      const desiredEndpoint = `http://127.0.0.1:${currentObservation.info.port}/mcp`;
      const existingTunnel = await tunnelAdapter.observe(validated.tunnelProfileRef);
      if (
        existingTunnel.running &&
        existingTunnel.profileRef === validated.tunnelProfileRef &&
        existingTunnel.provider === validated.capability.tunnelProvider &&
        existingTunnel.localEndpoint === desiredEndpoint
      ) {
        tunnelRunning = true;
        tunnelUrl = existingTunnel.url;
      } else {
        const secretCapability = await secretStore.inspect();
        if (
          !secretCapability.available ||
          secretStore.consumption !== "in_process" ||
          secretCapability.provider !== validated.capability.protectedSecretProvider ||
          !secretStore.verifyReference ||
          !(await secretStore.verifyReference(validated.protectedSecretRef))
        ) {
          checkpoint.status = "protected_secret_unavailable";
          checkpoint = saveCheckpoint(checkpoint);
          return outcome(checkpoint, {
            reason: secretCapability.reason ?? "protected secret reference/provider ownership could not be revalidated",
            bridge: bridgeResult(currentObservation, started),
            tunnel: { provider: tunnelAdapter.name, running: existingTunnel.running, url: existingTunnel.url },
          });
        }
        const secret = await secretStore.resolve(validated.protectedSecretRef);
        const reconciled = await tunnelAdapter.reconcile({
          localPort: currentObservation.info.port,
          localEndpoint: desiredEndpoint,
          profileRef: validated.tunnelProfileRef,
          secret,
        });
        if (
          !reconciled.running ||
          reconciled.profileRef !== validated.tunnelProfileRef ||
          reconciled.provider !== validated.capability.tunnelProvider ||
          reconciled.localEndpoint !== desiredEndpoint
        ) {
          checkpoint.status = "recovery_waiting";
          checkpoint = saveCheckpoint(checkpoint);
          return outcome(checkpoint, {
            reason: "tunnel adapter did not verify the expected profile",
            bridge: bridgeResult(currentObservation, started),
            tunnel: tunnelResult(currentObservation, tunnelAdapter, reconciled.running, reconciled.url),
          });
        }
        // Mutation responses are advisory. Re-observe through the supported
        // client before committing durable recovery state.
        const observedAfterReconcile = await tunnelAdapter.observe(validated.tunnelProfileRef);
        if (
          !observedAfterReconcile.running ||
          observedAfterReconcile.profileRef !== validated.tunnelProfileRef ||
          observedAfterReconcile.provider !== validated.capability.tunnelProvider ||
          observedAfterReconcile.localEndpoint !== desiredEndpoint
        ) {
          checkpoint.status = "recovery_waiting";
          checkpoint = saveCheckpoint(checkpoint);
          return outcome(checkpoint, {
            reason: "tunnel post-reconcile observation did not verify the expected profile",
            bridge: bridgeResult(currentObservation, started),
            tunnel: tunnelResult(currentObservation, tunnelAdapter, observedAfterReconcile.running, observedAfterReconcile.url),
          });
        }
        tunnelReconciled = true;
        tunnelRunning = observedAfterReconcile.running;
        tunnelUrl = observedAfterReconcile.url;
      }

      checkpoint.phase = "VERIFY";
      checkpoint = saveCheckpoint(checkpoint);
      const verified = await observe(root, validated);
      if (verified.state !== "healthy") {
        checkpoint.status = verified.state === "ambiguous" ? "ambiguous_ownership" : "recovery_waiting";
        checkpoint = saveCheckpoint(checkpoint);
        return outcome(checkpoint, {
          reason: verified.reason,
          bridge: bridgeResult(verified, started),
          tunnel: { provider: tunnelAdapter.name, running: tunnelRunning, url: tunnelUrl },
        });
      }
      checkpoint.phase = "COMMIT_STATE";
      checkpoint.status = started ? "started" : tunnelReconciled ? "tunnel_reconciled" : "reused";
      checkpoint = saveCheckpoint(checkpoint);
      writeRecoveryBinding({ ...validated, observedHealth: "healthy" });
      return outcome(checkpoint, {
        bridge: bridgeResult(verified, started),
        tunnel: { provider: tunnelAdapter.name, running: tunnelRunning, url: tunnelUrl },
      });
  } catch (error) {
    if (error instanceof RecoveryLockError) {
      checkpoint.status = error.status;
      checkpoint.phase = "LOAD_BINDING";
      // A caller that did not acquire the binding lock must not overwrite the
      // competing process's authoritative checkpoint. Return only an
      // in-memory bounded result for this rejected attempt.
      checkpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
      return outcome(checkpoint, {
        reason: error.message,
        bridge: bridgeResult(currentObservation, false),
        tunnel: { provider: null, running: null, url: null },
      });
    }
    if (error instanceof ProtectedSecretError) {
      checkpoint = persistFailure(error.status);
      return outcome(checkpoint, {
        reason: error.message,
        bridge: bridgeResult(currentObservation, started),
        tunnel: { provider: null, running: null, url: null },
      });
    }
    if (error instanceof SecureTunnelCapabilityError) {
      checkpoint = persistFailure(error.status);
      return outcome(checkpoint, {
        reason: error.message,
        bridge: bridgeResult(currentObservation, started),
        tunnel: { provider: null, running: null, url: null },
      });
    }
    if (error instanceof RecoveryIdentityError) {
      checkpoint = persistFailure(error.status);
      return outcome(checkpoint, {
        reason: error.message,
        bridge: bridgeResult(currentObservation, started),
        tunnel: { provider: null, running: null, url: null },
      });
    }
    checkpoint = persistFailure("recovery_waiting");
    return outcome(checkpoint, {
      reason: error instanceof Error ? error.message : String(error),
      bridge: bridgeResult(currentObservation, started),
      tunnel: { provider: null, running: null, url: null },
    });
  } finally {
    // Keep the lock through the failure checkpoint write so a later recovery
    // cannot overtake this operation and then be overwritten by stale state.
    bindingLock?.release();
  }
}

export function recoveryHealthForStatus(status: RecoveryStatus): RecoveryHealth {
  if (status === "healthy" || status === "reused" || status === "started" || status === "tunnel_reconciled") return "healthy";
  if (status === "identity_mismatch") return "ambiguous";
  if (status === "ambiguous_ownership") return "ambiguous";
  return "waiting";
}
