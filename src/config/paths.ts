import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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

export interface AtomicWriteTestHook {
  beforeReplace?: (file: string, temporary: string) => void;
}

let atomicWriteTestHook: AtomicWriteTestHook | null = null;

/** Test-only fault injection seam; production callers leave this unset. */
export function setAtomicWriteTestHook(hook: AtomicWriteTestHook | null): void {
  atomicWriteTestHook = hook;
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
 * Write a recovery-owned JSON document without exposing a partially written
 * state file to another process. The temporary file is created beside the
 * destination so rename stays on one filesystem.
 */
export function writeSecureAtomicJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const directory = path.dirname(file);
  const base = path.basename(file);
  const temporary = path.join(directory, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    try {
      fs.fsyncSync(fd);
    } catch {
      // Some filesystems do not expose fsync; close/rename still preserves
      // the all-or-nothing visibility guarantee.
    }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    atomicWriteTestHook?.beforeReplace?.(file, temporary);
    if (process.platform === "win32" && fs.existsSync(file)) {
      // File.Replace maps to the Windows ReplaceFile API: the destination is
      // never removed first, so readers see either the old or new document.
      const backup = path.join(directory, `.${base}.${randomUUID()}.bak`);
      const replacement = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // File.Move(..., overwrite:true) maps to MoveFileEx with replace
          // semantics on Windows and avoids the delete-then-rename crash gap.
          // Paths travel through private process environment entries because
          // powershell.exe does not reliably bind trailing -Command args to
          // `$args` when launched through CreateProcess.
          "$source=[Environment]::GetEnvironmentVariable('C2C_ATOMIC_SOURCE'); $destination=[Environment]::GetEnvironmentVariable('C2C_ATOMIC_DESTINATION'); $backup=[Environment]::GetEnvironmentVariable('C2C_ATOMIC_BACKUP'); [System.IO.File]::Replace($source,$destination,$backup,$true); Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            C2C_ATOMIC_SOURCE: temporary,
            C2C_ATOMIC_DESTINATION: file,
            C2C_ATOMIC_BACKUP: backup,
          },
        },
      );
      if (replacement.status !== 0) {
        throw new Error("Windows atomic state replacement failed");
      }
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        // best effort cleanup of the unique backup path created by this call
      }
    } else {
      fs.renameSync(temporary, file);
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore cleanup errors
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // only remove the temporary path created by this invocation
    }
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
