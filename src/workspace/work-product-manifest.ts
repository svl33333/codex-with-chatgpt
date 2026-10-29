import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Workspace } from "./manager.js";
import { EvidenceError, assertEvidenceReadAllowed, canonicalPath, observeGitRoot, readEvidenceBlobDigest, readEvidenceGit, readEvidencePolicy, safeEvidencePath, type EvidenceReadOptions } from "./git-evidence.js";
import { resolveWorkspaceRepository } from "./repository.js";

const MAX_PATHS = 256;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 512 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type Layer = { blob: string; mode: string } | null;
type FileState = Pick<fs.Stats, "dev" | "ino" | "size" | "mode" | "mtimeMs" | "ctimeMs">;

export interface WorkProductEntry {
  path: string;
  status: "tracked" | "staged" | "unstaged" | "untracked" | "deleted" | "staged_and_unstaged";
  head_blob: string | null;
  index_digest: string | null;
  worktree_digest: string | null;
  mode: string;
}

function sameFileState(left: fs.Stats, right: fs.Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readRegularDigest(file: string, maxBytes: number, options: EvidenceReadOptions): Promise<{ digest: string; mode: string; state: FileState } | null> {
  let descriptor: number | undefined;
  try {
    assertEvidenceReadAllowed(options);
    let before: fs.Stats;
    try { before = fs.lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw new EvidenceError("UNSUPPORTED_FILE_MODE");
    if (before.size > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.size > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
    const expectedPath = process.platform === "win32" || process.platform === "darwin" ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (!sameFileState(before, opened) || canonicalPath(file) !== expectedPath) throw new EvidenceError("FILE_CHANGED");
    options.reserveBytes?.(opened.size + 1);
    const buffer = Buffer.alloc(READ_BUFFER_BYTES);
    const hash = createHash("sha256");
    let count = 0;
    while (count <= opened.size) {
      assertEvidenceReadAllowed(options);
      const read = await new Promise<number>((resolve, reject) => {
        fs.read(descriptor!, buffer, 0, Math.min(buffer.length, opened.size - count + 1), null,
          (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
      });
      count += read;
      if (read) options.onBytes?.(read);
      assertEvidenceReadAllowed(options);
      if (!read) break;
      if (count > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
      if (count > opened.size) throw new EvidenceError("FILE_CHANGED");
      hash.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor);
    let pathAfter: fs.Stats;
    try { pathAfter = fs.lstatSync(file); } catch { throw new EvidenceError("FILE_CHANGED"); }
    if (count !== opened.size || !sameFileState(opened, after) || !sameFileState(opened, pathAfter) || canonicalPath(file) !== expectedPath) throw new EvidenceError("FILE_CHANGED");
    assertEvidenceReadAllowed(options);
    const state = { dev: opened.dev, ino: opened.ino, size: opened.size, mode: opened.mode, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
    return { digest: hash.digest("hex"), mode: (opened.mode & 0o111) ? "100755" : "100644", state };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("FILE_UNAVAILABLE");
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function validateRequiredPath(workspace: Workspace, requested: string, policy: ReturnType<typeof readEvidencePolicy>): string {
  if (!safeEvidencePath(requested, policy.rules)) throw new EvidenceError("PATH_REFUSED");
  const resolved = workspace.resolve(requested, { allowSensitive: true });
  if (resolved.rel !== requested) throw new EvidenceError("NONREGULAR_PATH_REFUSED");
  let ancestor = workspace.root;
  for (const component of requested.split("/")) {
    ancestor = path.join(ancestor, component);
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new EvidenceError("NONREGULAR_PATH_REFUSED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return resolved.abs;
}

function readHeadLayer(root: string, head: string, file: string, options: EvidenceReadOptions): Layer {
  const text = readEvidenceGit(root, ["ls-tree", "-z", head, "--", `:(literal)${file}`], 8192, options);
  if (!text) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(text);
  if (!match || !SHA.test(match[2]) || match[3] !== file) throw new EvidenceError("UNSUPPORTED_HEAD_MODE");
  return { mode: match[1], blob: match[2] };
}

function readIndexLayer(root: string, file: string, options: EvidenceReadOptions): Layer {
  const text = readEvidenceGit(root, ["ls-files", "--stage", "-z", "--", `:(literal)${file}`], 8192, options);
  if (!text) return null;
  const match = /^(100644|100755) ([a-f0-9]+) 0\t([^\0]+)\0$/.exec(text);
  if (!match || !SHA.test(match[2]) || match[3] !== file) throw new EvidenceError("UNSUPPORTED_INDEX_STAGE_OR_MODE");
  return { mode: match[1], blob: match[2] };
}

async function readBlobDigest(root: string, blob: string, options: EvidenceReadOptions): Promise<string> {
  const size = readEvidenceGit(root, ["cat-file", "-s", blob], 1024, options).trim();
  if (!/^[0-9]+$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > MAX_FILE_BYTES) throw new EvidenceError("FILE_TOO_LARGE");
  return readEvidenceBlobDigest(root, blob, Number(size), options);
}

async function observeBoundary(workspace: Workspace, options: EvidenceReadOptions) {
  const identity = observeGitRoot(workspace.root, { allowSubtree: true, readOptions: options });
  const repository = resolveWorkspaceRepository(workspace.root, options);
  const policy = readEvidencePolicy(workspace.root);
  const index = await readRegularDigest(path.join(identity.gitDir, "index"), MAX_FILE_BYTES, options);
  return { identity, repository, policy, indexDigest: index?.digest ?? null, indexState: index?.state ?? null };
}

async function observeManifest(workspace: Workspace, requiredPaths: string[], options: EvidenceReadOptions) {
  const boundary = await observeBoundary(workspace, options);
  const { identity, policy } = boundary;
  const entries: WorkProductEntry[] = [];
  const modes: Array<{ path: string; head: string | null; index: string | null; worktree: string | null }> = [];
  const fileStates: Array<{ path: string; state: FileState | null }> = [];
  let reservedBytes = 0;
  const contentOptions: EvidenceReadOptions = { ...options, reserveBytes(count) {
    if (count > MAX_OBSERVATION_BYTES - reservedBytes) throw new EvidenceError("MANIFEST_IO_LIMIT");
    reservedBytes += count;
  } };
  for (const file of requiredPaths) {
    assertEvidenceReadAllowed(options);
    const absolute = validateRequiredPath(workspace, file, policy);
    const head = readHeadLayer(workspace.root, identity.head, file, options);
    const stage = readIndexLayer(workspace.root, file, options);
    const worktree = await readRegularDigest(absolute, MAX_FILE_BYTES, contentOptions);
    const indexDigest = stage ? await readBlobDigest(workspace.root, stage.blob, contentOptions) : null;
    const worktreeDigest = worktree?.digest ?? null;
    if (!head && !stage && !worktree) throw new EvidenceError("REQUIRED_FILE_ABSENT");
    const staged = head?.blob !== stage?.blob || head?.mode !== stage?.mode;
    const unstaged = indexDigest !== worktreeDigest || stage?.mode !== worktree?.mode;
    const status = !head && !stage ? "untracked" : staged && unstaged ? "staged_and_unstaged" : !worktree ? "deleted" : staged ? "staged" : unstaged ? "unstaged" : "tracked";
    entries.push({ path: file, status, head_blob: head?.blob ?? null, index_digest: indexDigest, worktree_digest: worktreeDigest, mode: worktree?.mode ?? stage?.mode ?? head!.mode });
    modes.push({ path: file, head: head?.mode ?? null, index: stage?.mode ?? null, worktree: worktree?.mode ?? null });
    fileStates.push({ path: file, state: worktree?.state ?? null });
  }
  return { identity, repository: boundary.repository, policy: { present: policy.present, digest: policy.hash }, indexDigest: boundary.indexDigest, entries, modes, fileStates, indexState: boundary.indexState };
}

export async function listWorkProductManifest(workspace: Workspace, requiredPaths: string[], options: EvidenceReadOptions = {}) {
  const incomplete = (code: string) => ({ complete: false, terminal: true, requiredCount: Array.isArray(requiredPaths) ? requiredPaths.length : 0, returnedCount: 0, entries: [] as WorkProductEntry[], errors: [code] });
  try {
    if (!Array.isArray(requiredPaths) || requiredPaths.length === 0 || requiredPaths.length > MAX_PATHS || requiredPaths.some((file) => typeof file !== "string") || new Set(requiredPaths).size !== requiredPaths.length) throw new EvidenceError("INVALID_REQUIRED_PATHS");
    requiredPaths = [...requiredPaths];
    options = { ...options, deadline: Math.min(options.deadline ?? Infinity, performance.now() + 60_000) };
    assertEvidenceReadAllowed(options);
    const first = await observeManifest(workspace, requiredPaths, options);
    const response = { complete: true, terminal: true, requiredPaths, requiredCount: requiredPaths.length, returnedCount: first.entries.length,
      identity: first.identity, repository: first.repository, policy: first.policy, indexDigest: first.indexDigest,
      entries: first.entries, modes: first.modes, errors: [] as string[] };
    const envelope = { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RESPONSE_BYTES) throw new EvidenceError("MANIFEST_RESPONSE_TOO_LARGE");
    const last = await observeManifest(workspace, requiredPaths, options);
    if (JSON.stringify(first) !== JSON.stringify(last)) throw new EvidenceError("MANIFEST_CHANGED");
    const final = await observeBoundary(workspace, options);
    if (JSON.stringify({ identity: final.identity, repository: final.repository, policy: { present: final.policy.present, digest: final.policy.hash }, indexDigest: final.indexDigest, indexState: final.indexState }) !== JSON.stringify({ identity: last.identity, repository: last.repository, policy: last.policy, indexDigest: last.indexDigest, indexState: last.indexState })) throw new EvidenceError("MANIFEST_CHANGED");
    assertEvidenceReadAllowed(options);
    return response;
  } catch (error) { return incomplete(error instanceof EvidenceError ? error.code : "MANIFEST_UNAVAILABLE"); }
}
