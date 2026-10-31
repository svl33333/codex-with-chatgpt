import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

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
  writeSecureFile(file, JSON.stringify(data, null, 2));
}

export function writeSecureFile(file: string, content: string | Buffer, options: { durable?: boolean } = {}): void {
  ensureDir(path.dirname(file));
  const temporary = file + "." + randomUUID() + ".tmp";
  let descriptor: number | null = null;
  let ownsTemporary = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    ownsTemporary = true;
    fs.writeFileSync(descriptor, content);
    if (options.durable) fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    ownsTemporary = false;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the original I/O failure. */ }
    }
    if (ownsTemporary) {
      try { fs.unlinkSync(temporary); } catch { /* Cleanup cannot replace the failed save's diagnostic. */ }
    }
    throw error;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function writeAtomicSecureJson(file: string, data: unknown): void {
  writeSecureFile(file, JSON.stringify(data, null, 2), { durable: true });
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
