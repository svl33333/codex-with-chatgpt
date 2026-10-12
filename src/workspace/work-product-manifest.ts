import fs from "node:fs";
import path from "node:path";
import { Workspace } from "./manager.js";
import { EvidenceError, canonicalPath, digest, observeGitRoot, readEvidenceGit, readEvidencePolicy, runEvidenceGit, safeEvidencePath } from "./git-evidence.js";
import { resolveWorkspaceRepository } from "./repository.js";

const MAX_PATHS = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type Layer = { blob: string; mode: string } | null;

export interface WorkProductEntry {
  path: string;
  status: "tracked" | "staged" | "unstaged" | "untracked" | "deleted" | "staged_and_unstaged";
  head_blob: string | null;
  index_digest: string | null;
  worktree_digest: string | null;
  mode: string;
}

function readRegularBytes(file: string, maxBytes: number): { bytes: Buffer; mode: string } | null {
  let descriptor: number | undefined;
  try {
    let before: fs.Stats;
    try { before = fs.lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw new EvidenceError("UNSUPPORTED_FILE_MODE");
    if (before.size > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.size > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
    const expectedPath = process.platform === "win32" || process.platform === "darwin" ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || canonicalPath(file) !== expectedPath) throw new EvidenceError("FILE_CHANGED");
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) throw new EvidenceError("FILE_TOO_LARGE");
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new EvidenceError("FILE_CHANGED");
    return { bytes: buffer.subarray(0, count), mode: (opened.mode & 0o111) ? "100755" : "100644" };
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

function readHeadLayer(root: string, head: string, file: string): Layer {
  const text = readEvidenceGit(root, ["ls-tree", "-z", head, "--", `:(literal)${file}`], 8192);
  if (!text) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(text);
  if (!match || !SHA.test(match[2]) || match[3] !== file) throw new EvidenceError("UNSUPPORTED_HEAD_MODE");
  return { mode: match[1], blob: match[2] };
}

function readIndexLayer(root: string, file: string): Layer {
  const text = readEvidenceGit(root, ["ls-files", "--stage", "-z", "--", `:(literal)${file}`], 8192);
  if (!text) return null;
  const match = /^(100644|100755) ([a-f0-9]+) 0\t([^\0]+)\0$/.exec(text);
  if (!match || !SHA.test(match[2]) || match[3] !== file) throw new EvidenceError("UNSUPPORTED_INDEX_STAGE_OR_MODE");
  return { mode: match[1], blob: match[2] };
}

function readBlobDigest(root: string, blob: string): string {
  const size = readEvidenceGit(root, ["cat-file", "-s", blob], 1024).trim();
  if (!/^[0-9]+$/.test(size) || Number(size) > MAX_FILE_BYTES) throw new EvidenceError("FILE_TOO_LARGE");
  const object = runEvidenceGit(root, ["cat-file", "blob", blob], MAX_FILE_BYTES + 1);
  if (object.code !== 0 || object.stdout.length !== Number(size)) throw new EvidenceError("BLOB_UNAVAILABLE");
  return digest(object.stdout);
}

function observeBoundary(workspace: Workspace) {
  const identity = observeGitRoot(workspace.root, { allowSubtree: true });
  const repository = resolveWorkspaceRepository(workspace.root);
  const policy = readEvidencePolicy(workspace.root);
  const index = readRegularBytes(path.join(identity.gitDir, "index"), 64 * 1024 * 1024);
  return { identity, repository, policy, indexDigest: index ? digest(index.bytes) : null };
}

function observeManifest(workspace: Workspace, requiredPaths: string[]) {
  const boundary = observeBoundary(workspace);
  const { identity, policy } = boundary;
  const entries: WorkProductEntry[] = [];
  const modes: Array<{ path: string; head: string | null; index: string | null; worktree: string | null }> = [];
  for (const file of requiredPaths) {
    const absolute = validateRequiredPath(workspace, file, policy);
    const head = readHeadLayer(workspace.root, identity.head, file);
    const stage = readIndexLayer(workspace.root, file);
    const worktree = readRegularBytes(absolute, MAX_FILE_BYTES);
    const indexDigest = stage ? readBlobDigest(workspace.root, stage.blob) : null;
    const worktreeDigest = worktree ? digest(worktree.bytes) : null;
    if (!head && !stage && !worktree) throw new EvidenceError("REQUIRED_FILE_ABSENT");
    const staged = head?.blob !== stage?.blob || head?.mode !== stage?.mode;
    const unstaged = indexDigest !== worktreeDigest || stage?.mode !== worktree?.mode;
    const status = !head && !stage ? "untracked" : staged && unstaged ? "staged_and_unstaged" : !worktree ? "deleted" : staged ? "staged" : unstaged ? "unstaged" : "tracked";
    entries.push({ path: file, status, head_blob: head?.blob ?? null, index_digest: indexDigest, worktree_digest: worktreeDigest, mode: worktree?.mode ?? stage?.mode ?? head!.mode });
    modes.push({ path: file, head: head?.mode ?? null, index: stage?.mode ?? null, worktree: worktree?.mode ?? null });
  }
  return { identity, repository: boundary.repository, policy: { present: policy.present, digest: policy.hash }, indexDigest: boundary.indexDigest, entries, modes };
}

export function listWorkProductManifest(workspace: Workspace, requiredPaths: string[]) {
  const incomplete = (code: string) => ({ complete: false, terminal: true, requiredCount: Array.isArray(requiredPaths) ? requiredPaths.length : 0, returnedCount: 0, entries: [] as WorkProductEntry[], errors: [code] });
  try {
    if (!Array.isArray(requiredPaths) || requiredPaths.length === 0 || requiredPaths.length > MAX_PATHS || requiredPaths.some((file) => typeof file !== "string") || new Set(requiredPaths).size !== requiredPaths.length) throw new EvidenceError("INVALID_REQUIRED_PATHS");
    requiredPaths = [...requiredPaths];
    const first = observeManifest(workspace, requiredPaths);
    const last = observeManifest(workspace, requiredPaths);
    if (JSON.stringify(first) !== JSON.stringify(last)) throw new EvidenceError("MANIFEST_CHANGED");
    const final = observeBoundary(workspace);
    if (JSON.stringify({ identity: final.identity, repository: final.repository, policy: { present: final.policy.present, digest: final.policy.hash }, indexDigest: final.indexDigest }) !== JSON.stringify({ identity: last.identity, repository: last.repository, policy: last.policy, indexDigest: last.indexDigest })) throw new EvidenceError("MANIFEST_CHANGED");
    const response = { complete: true, terminal: true, requiredPaths, requiredCount: requiredPaths.length, returnedCount: first.entries.length, ...first, errors: [] as string[] };
    const envelope = { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RESPONSE_BYTES) throw new EvidenceError("MANIFEST_RESPONSE_TOO_LARGE");
    return response;
  } catch (error) { return incomplete(error instanceof EvidenceError ? error.code : "MANIFEST_UNAVAILABLE"); }
}
