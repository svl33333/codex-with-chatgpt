import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** A small owner-checked lease used by A1 durable records. */
export interface LeaseRecord {
  schemaVersion: 1;
  leaseId: string;
  pid: number;
  acquiredAt: string;
  /** Legacy A0 event locks use `at`; retain it when reading for diagnostics. */
  at?: string;
}

export interface LeaseClock {
  now(): number;
}

export interface LeaseOptions {
  clock?: LeaseClock | (() => number);
  staleAfterMs?: number;
  processIsAlive?: (pid: number) => boolean;
  attempts?: number;
  /** Allow a caller to annotate the record without changing ownership rules. */
  legacyAt?: boolean;
}

export interface AcquiredLease {
  file: string;
  record: LeaseRecord;
  release(): void;
}

function clockNow(clock: LeaseOptions["clock"]): number {
  if (typeof clock === "function") return clock();
  return clock?.now() ?? Date.now();
}

function ownerAlive(pid: number, check: LeaseOptions["processIsAlive"]): boolean {
  if (check) return check(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLease(raw: string): LeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LeaseRecord> & { at?: unknown };
    if (typeof value.leaseId !== "string" || !value.leaseId || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    const acquiredAt = typeof value.acquiredAt === "string" ? value.acquiredAt : typeof value.at === "string" ? value.at : "";
    if (!acquiredAt) return null;
    return {
      schemaVersion: 1,
      leaseId: value.leaseId,
      pid: value.pid,
      acquiredAt,
      ...(typeof value.at === "string" ? { at: value.at } : {}),
    };
  } catch {
    return null;
  }
}

export function readLease(file: string): LeaseRecord | null {
  try {
    return parseLease(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function leaseAgeMs(file: string, record: LeaseRecord, now: number): number {
  const parsed = Date.parse(record.acquiredAt);
  if (Number.isFinite(parsed)) return Math.max(0, now - parsed);
  try {
    return Math.max(0, now - fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * Acquire a lock file without ever reclaiming a live owner merely because the
 * file is old.  Legacy `{at}` and current `{acquiredAt}` shapes are both
 * understood for recovery.
 */
export function acquireLease(file: string, options: LeaseOptions = {}): AcquiredLease {
  fs.mkdirSync(requireDirectory(file), { recursive: true, mode: 0o700 });
  const leaseId = randomUUID();
  const record: LeaseRecord = {
    schemaVersion: 1,
    leaseId,
    pid: process.pid,
    acquiredAt: new Date(clockNow(options.clock)).toISOString(),
    ...(options.legacyAt ? { at: new Date(clockNow(options.clock)).toISOString() } : {}),
  };
  const attempts = Math.max(1, options.attempts ?? 20);
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? 30_000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const descriptor = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record), "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      let released = false;
      return {
        file,
        record,
        release() {
          if (released) return;
          released = true;
          const current = readLease(file);
          if (current?.leaseId !== leaseId) return;
          try { fs.rmSync(file, { force: true }); } catch { /* another owner won */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readLease(file);
      if (!current) continue;
      const age = leaseAgeMs(file, current, clockNow(options.clock));
      if (age <= staleAfterMs || ownerAlive(current.pid, options.processIsAlive)) continue;
      // Re-read immediately before removal so a concurrent owner cannot be
      // removed after replacing the old record.
      const confirmed = readLease(file);
      if (confirmed?.leaseId !== current.leaseId) continue;
      try { fs.rmSync(file, { force: true }); } catch { /* retry */ }
    }
  }
  throw new Error("lease is locked");
}

export function releaseLease(lease: AcquiredLease): void {
  lease.release();
}

export function withLease<T>(file: string, action: () => T, options: LeaseOptions = {}): T {
  const lease = acquireLease(file, options);
  try {
    return action();
  } finally {
    lease.release();
  }
}

export const withOwnerLease = withLease;

function requireDirectory(file: string): string {
  const index = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return index >= 0 ? file.slice(0, index) || "." : ".";
}
