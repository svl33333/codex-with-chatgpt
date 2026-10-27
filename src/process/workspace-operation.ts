import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

const operations = new AsyncLocalStorage<ReadonlySet<string>>();

export function withWorkspaceOperation<T>(workspaceId: string, action: () => T): T {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("INVALID_WORKSPACE_ID");
  const lock = path.join(getStateDir(), "operations", workspaceId + ".lock");
  const inherited = operations.getStore();
  if (inherited?.has(lock)) return action();
  ensureDir(path.dirname(lock));
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("WORKSPACE_BUSY");
    throw error;
  }
  const owned = fs.fstatSync(descriptor);
  const release = (): void => {
    try {
      const current = fs.lstatSync(lock);
      if (current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  return operations.run(new Set([...(inherited ?? []), lock]), () => {
    let returned: T;
    try { returned = action(); }
    catch (error) { release(); throw error; }
    if (returned instanceof Promise) return returned.finally(release) as T;
    release();
    return returned;
  });
}
