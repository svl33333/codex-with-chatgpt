import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

export interface JanitorLease {
  ownerNonce: string;
  release(): void;
}

export function leaseFile(name = "apply"): string {
  return path.join(ensureDir(path.join(getStateDir(), "janitor")), `${name}.lease`);
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process owner-nonce lease shared with protection/reference writers. */
export function acquireJanitorLease(name = "apply", staleAfterMs = 120_000): JanitorLease {
  const file = leaseFile(name);
  const ownerNonce = randomBytes(24).toString("base64url");
  const payload = { ownerNonce, pid: process.pid, createdAt: new Date().toISOString() };
  ensureDir(path.dirname(file));
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(payload), { encoding: "utf8" });
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          let currentPid: unknown;
          try { currentPid = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown }).pid; } catch { currentPid = undefined; }
          if (processIsAlive(currentPid)) throw new Error("JANITOR_BUSY: live owner heartbeat is stale");
          fs.rmSync(file, { force: true });
        } else throw new Error("JANITOR_BUSY: another protection-state write is active");
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("JANITOR_BUSY")) throw inner;
        throw new Error("JANITOR_BUSY: lease state is unavailable");
      }
      return acquireJanitorLease(name, staleAfterMs);
    }
    throw error;
  }
  let released = false;
  const heartbeatMs = Math.max(1_000, Math.floor(staleAfterMs / 3));
  const heartbeat = setInterval(() => {
    if (released) return;
    try {
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as { ownerNonce?: unknown };
      if (current.ownerNonce !== ownerNonce) return;
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // The guarded operation will fail closed if its lease disappears.
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    ownerNonce,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { ownerNonce?: unknown };
        if (current.ownerNonce === ownerNonce) fs.rmSync(file, { force: true });
      } catch {
        // Crash recovery handles stale leases.
      }
    },
  };
}

export function acquireProtectionFinalizationLease(): JanitorLease {
  return acquireJanitorLease("protection-finalization");
}

export function withProtectionFinalizationLease<T>(operation: () => T): T {
  const lease = acquireProtectionFinalizationLease();
  try {
    return operation();
  } finally {
    lease.release();
  }
}
