import fs from "node:fs";
import path from "node:path";
import { readConnectionBinding } from "../connection/identity.js";
import {
  readRecoveryBinding,
  recoveryBindingFile,
  recoveryCheckpointFile,
  validateRecoveryBinding,
  type RecoveryBindingRecord,
} from "./bindings.js";
import { acquireBindingLock, RecoveryLockError } from "./locks.js";
import { supervisorDefinitionFile, supervisorLogFile, supervisorTaskName } from "./supervisor.js";
import {
  ProtectedSecretError,
  UnsupportedProtectedSecretStore,
  type ProtectedSecretStore,
} from "./secret-store.js";

export interface RecoveryUninstallResult {
  ok: boolean;
  status: "removed" | "absent" | "ambiguous_ownership" | "protected_secret_unavailable" | "recovery_waiting";
  bindingId: string;
  reason?: string;
}

function removeOwnedState(bindingId: string): void {
  // Delete subordinate state first and the authoritative binding last. If a
  // process is interrupted, a remaining binding lets the next run prove
  // provenance and retry cleanup; deleting the binding first would make any
  // subordinate leftovers permanently indistinguishable from foreign state.
  for (const file of [
    recoveryCheckpointFile(bindingId),
    supervisorDefinitionFile(bindingId),
    supervisorLogFile(bindingId),
  ]) {
    fs.rmSync(file, { force: true });
  }
  removeOwnedTemporaryState(bindingId);
  fs.rmSync(recoveryBindingFile(bindingId), { force: true });
}

/** Remove only crash leftovers whose filename is scoped to this binding. */
function removeOwnedTemporaryState(bindingId: string): void {
  supervisorTaskName(bindingId); // validate the filename scope before scanning
  const directories = [
    path.dirname(recoveryBindingFile(bindingId)),
    path.dirname(recoveryCheckpointFile(bindingId)),
    path.dirname(supervisorDefinitionFile(bindingId)),
    path.dirname(supervisorLogFile(bindingId)),
  ];
  const prefixes = [
    `.${bindingId}.json.`,
    `.${bindingId}.xml.`,
    `.${bindingId}.log.`,
  ];
  for (const directory of directories) {
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!prefixes.some((prefix) => name.startsWith(prefix)) || !/\.(?:tmp|bak)$/.test(name)) continue;
      try {
        fs.rmSync(path.join(directory, name), { force: true });
      } catch {
        // Cleanup remains fail-closed for authoritative state; a leftover
        // owned artifact is harmless and can be retried on the next run.
      }
    }
  }
}

/** Remove only recovery state whose authoritative binding and provenance agree. */
export async function uninstallRecoveryState(
  bindingId: string,
  options: { secretStore?: ProtectedSecretStore } = {},
): Promise<RecoveryUninstallResult> {
  const store: ProtectedSecretStore = options.secretStore ?? new UnsupportedProtectedSecretStore();
  const raw = readRecoveryBinding(bindingId);
  if (!raw) return { ok: true, status: "absent", bindingId };
  let record: RecoveryBindingRecord;
  try {
    record = validateRecoveryBinding(raw, raw.canonicalAllowedRoot, readConnectionBinding(bindingId));
  } catch (error) {
    return {
      ok: false,
      status: error instanceof RecoveryLockError ? "ambiguous_ownership" : "ambiguous_ownership",
      bindingId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let lock;
  try {
    lock = await acquireBindingLock(bindingId, { waitMs: 5_000 });
  } catch (error) {
    return {
      ok: false,
      status: error instanceof RecoveryLockError ? error.status : "recovery_waiting",
      bindingId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    // Re-read after locking; another process may have changed provenance.
    const current = readRecoveryBinding(bindingId);
    if (!current) return { ok: true, status: "absent", bindingId };
    record = validateRecoveryBinding(current, current.canonicalAllowedRoot, readConnectionBinding(bindingId));
    if (record.ownership.createdBy === "p0-2") {
      if (!store.releaseOwned) {
        return {
          ok: false,
          status: "protected_secret_unavailable",
          bindingId,
          reason: "owned protected-secret cleanup is unavailable",
        };
      }
      try {
        // Protected-secret providers implement releaseOwned idempotently, so
        // an uninstall interrupted after this point can safely retry before
        // deleting the provenance-bearing binding.
        await store.releaseOwned(record.protectedSecretRef);
      } catch (error) {
        if (error instanceof ProtectedSecretError) {
          return { ok: false, status: "protected_secret_unavailable", bindingId, reason: error.message };
        }
        return { ok: false, status: "protected_secret_unavailable", bindingId, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    removeOwnedState(bindingId);
    return { ok: true, status: "removed", bindingId };
  } catch (error) {
    return { ok: false, status: "ambiguous_ownership", bindingId, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    lock.release();
  }
}
