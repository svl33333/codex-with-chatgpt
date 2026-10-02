import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/**
 * Durable A1 delegation state is kept separate from the A0 transport records.
 * Keeping this helper in the state-path module makes the boundary explicit and
 * gives tests one deterministic root to isolate with C2C_STATE_DIR.
 */
export function delegationRoot(): string {
  return stateSubdir("delegation");
}

export function delegationSubdir(name: string): string {
  return ensureDir(path.join(delegationRoot(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

/**
 * Replace one state record only after the complete JSON payload is durable.
 * The temporary sibling is deliberately cleaned up without touching the last
 * valid record when a write or rename fails.
 */
export function writeAtomicSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Best effort on platforms without chmod semantics.
    }
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on platforms without chmod semantics.
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor may already be closed by the failed write.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original error and leave the prior record untouched.
    }
    throw error;
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
