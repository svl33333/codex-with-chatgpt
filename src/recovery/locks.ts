import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, stateSubdir } from "../config/paths.js";

export interface BindingLockOwner {
  schemaVersion: 1;
  connectionBindingId: string;
  pid: number;
  processStartMarker: string;
  acquiredAt: string;
}

export class RecoveryLockError extends Error {
  constructor(
    public readonly status: "ambiguous_ownership" | "recovery_waiting",
    message: string,
  ) {
    super(message);
    this.name = "RecoveryLockError";
  }
}

export function bindingLockFile(connectionBindingId: string): string {
  return path.join(stateSubdir("recovery"), "locks", `${connectionBindingId}.lock`);
}

export function processStartMarker(): string {
  // The marker is diagnostic only. PID liveness is checked separately and a
  // marker mismatch never authorizes breaking a live process's lock.
  return `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
}

function parseOwner(file: string): BindingLockOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BindingLockOwner>;
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.connectionBindingId !== "string" ||
      !raw.connectionBindingId ||
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.processStartMarker !== "string" ||
      !raw.processStartMarker ||
      typeof raw.acquiredAt !== "string" ||
      !raw.acquiredAt
    ) {
      return null;
    }
    return raw as BindingLockOwner;
  } catch {
    return null;
  }
}

function ownerLiveness(owner: BindingLockOwner): "present" | "missing" | "unknown" {
  try {
    process.kill(owner.pid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "missing";
    return "unknown";
  }
}

function removeStaleLock(file: string, expected: BindingLockOwner): boolean {
  const current = parseOwner(file);
  if (!current || current.connectionBindingId !== expected.connectionBindingId || current.pid !== expected.pid) return false;
  if (ownerLiveness(current) !== "missing") return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface BindingLock {
  readonly owner: BindingLockOwner;
  readonly file: string;
  release(): void;
}

export async function acquireBindingLock(
  connectionBindingId: string,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<BindingLock> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(connectionBindingId)) {
    throw new RecoveryLockError("ambiguous_ownership", "invalid connection binding lock identifier");
  }
  const file = bindingLockFile(connectionBindingId);
  ensureDir(path.dirname(file));
  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 5_000);
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const owner: BindingLockOwner = {
    schemaVersion: 1,
    connectionBindingId,
    pid: process.pid,
    processStartMarker: processStartMarker(),
    acquiredAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(owner), { encoding: "utf8" });
        try {
          fs.fsyncSync(fd);
        } catch {
          // best effort on filesystems without fsync
        }
      } finally {
        fs.closeSync(fd);
      }
      return {
        owner,
        file,
        release: () => {
          const current = parseOwner(file);
          if (current?.pid !== owner.pid || current.processStartMarker !== owner.processStartMarker) return;
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // Do not remove a lock that no longer belongs to this process.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const current = parseOwner(file);
      if (!current) {
        throw new RecoveryLockError("ambiguous_ownership", "binding lock metadata is malformed");
      }
      const liveness = ownerLiveness(current);
      if (liveness === "unknown") {
        throw new RecoveryLockError("ambiguous_ownership", "binding lock owner cannot be verified");
      }
      if (liveness === "missing") {
        if (!removeStaleLock(file, current)) {
          throw new RecoveryLockError("ambiguous_ownership", "stale binding lock changed during recovery");
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new RecoveryLockError("recovery_waiting", "binding lock is held by a live process");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  }
}

export function readBindingLockOwner(connectionBindingId: string): BindingLockOwner | null {
  return parseOwner(bindingLockFile(connectionBindingId));
}

export function recoveryLockDirectory(): string {
  return path.join(getStateDir(), "recovery", "locks");
}
