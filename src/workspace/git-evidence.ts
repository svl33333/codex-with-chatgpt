import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IgnoreRules } from "./ignore.js";

const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_PATHS = 2000;
const MAX_POLICY = 256 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const readCommands = new Set(["rev-parse", "symbolic-ref", "config", "remote", "for-each-ref", "cat-file", "rev-list", "merge-base", "diff", "diff-tree", "ls-tree", "ls-files"]);

export class EvidenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EvidenceError";
  }
}

export interface EvidenceReadOptions {
  signal?: AbortSignal;
  deadline?: number;
  reserveBytes?: (count: number) => void;
  onBytes?: (count: number) => void;
}

export function assertEvidenceReadAllowed(options: EvidenceReadOptions): void {
  if (options.signal?.aborted) throw new EvidenceError("MANIFEST_CANCELLED");
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || performance.now() >= options.deadline)) {
    throw new EvidenceError("MANIFEST_TIMEOUT");
  }
}

function evidenceGitTimeout(options: EvidenceReadOptions): number {
  assertEvidenceReadAllowed(options);
  return options.deadline === undefined ? 10_000 : Math.min(10_000, Math.max(1, Math.ceil(options.deadline - performance.now())));
}

function evidenceGitInvocation(root: string, args: string[]) {
  if (!readCommands.has(args[0])) throw new EvidenceError("UNSUPPORTED_GIT_OPERATION");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const emptyConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C",
  });
  return {
    args: ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "core.quotePath=true", ...args],
    options: { cwd: root, env, windowsHide: true, shell: false as const },
  };
}

export function runEvidenceGit(root: string, args: string[], maxBytes = MAX_OUTPUT, options: EvidenceReadOptions = {}) {
  const timeout = evidenceGitTimeout(options);
  const invocation = evidenceGitInvocation(root, args);
  const command = spawnSync("git", invocation.args, { ...invocation.options, timeout, maxBuffer: maxBytes });
  assertEvidenceReadAllowed(options);
  if (command.error || command.signal || command.stdout.length > maxBytes) throw new EvidenceError("GIT_EVIDENCE_UNAVAILABLE");
  return { code: command.status, stdout: command.stdout };
}

export function readEvidenceGit(root: string, args: string[], maxBytes = MAX_OUTPUT, options: EvidenceReadOptions = {}): string {
  const command = runEvidenceGit(root, args, maxBytes, options);
  if (command.code !== 0) throw new EvidenceError("GIT_EVIDENCE_UNAVAILABLE");
  try { return decoder.decode(command.stdout); }
  catch { throw new EvidenceError("INVALID_GIT_ENCODING"); }
}

export async function readEvidenceBlobDigest(root: string, blob: string, expectedBytes: number, options: EvidenceReadOptions = {}): Promise<string> {
  if (!SHA.test(blob) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_OUTPUT) {
    throw new EvidenceError("BLOB_UNAVAILABLE");
  }
  const timeout = evidenceGitTimeout(options);
  options.reserveBytes?.(expectedBytes + 1);
  const invocation = evidenceGitInvocation(root, ["cat-file", "blob", blob]);
  const child = spawn("git", invocation.args, { ...invocation.options, stdio: ["ignore", "pipe", "pipe"] });
  const hash = createHash("sha256");
  let bytes = 0;
  let stderrBytes = 0;
  let failure: EvidenceError | undefined;
  const stop = (error: EvidenceError) => {
    failure ??= error;
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const abort = () => stop(new EvidenceError("MANIFEST_CANCELLED"));
  const timer = setTimeout(() => stop(new EvidenceError(
    options.deadline !== undefined && performance.now() >= options.deadline ? "MANIFEST_TIMEOUT" : "GIT_EVIDENCE_UNAVAILABLE"
  )), timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("readable", () => {
    if (failure) return;
    try {
      while (true) {
        assertEvidenceReadAllowed(options);
        const chunk = child.stdout.read(Math.min(64 * 1024, expectedBytes - bytes + 1)) as Buffer | null;
        if (!chunk) break;
        bytes += chunk.length;
        options.onBytes?.(chunk.length);
        if (bytes > expectedBytes) throw new EvidenceError("BLOB_UNAVAILABLE");
        hash.update(chunk);
      }
    } catch (error) {
      stop(error instanceof EvidenceError ? error : new EvidenceError("BLOB_UNAVAILABLE"));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) stop(new EvidenceError("GIT_EVIDENCE_UNAVAILABLE"));
  });
  child.stdout.on("error", () => stop(new EvidenceError("BLOB_UNAVAILABLE")));
  child.stderr.on("error", () => stop(new EvidenceError("GIT_EVIDENCE_UNAVAILABLE")));
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", () => { failure ??= new EvidenceError("GIT_EVIDENCE_UNAVAILABLE"); });
      child.once("close", (code, signal) => resolve({ code, signal }));
      if (options.signal?.aborted) abort();
    });
    if (failure) throw failure;
    assertEvidenceReadAllowed(options);
    if (exit.code !== 0 || exit.signal || bytes !== expectedBytes) throw new EvidenceError("BLOB_UNAVAILABLE");
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPath(value: string): string {
  const real = fs.realpathSync.native(value);
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

export function observeGitRoot(root: string, opts: { allowSubtree?: boolean; readOptions?: EvidenceReadOptions } = {}) {
  try {
    const physicalRoot = canonicalPath(root);
    const top = readEvidenceGit(root, ["rev-parse", "--show-toplevel"], 16 * 1024, opts.readOptions).trim();
    const worktreeRoot = canonicalPath(top);
    if (physicalRoot !== worktreeRoot && !physicalRoot.startsWith(worktreeRoot + path.sep)) throw new EvidenceError("WORKSPACE_ROOT_MISMATCH");
    if (!opts.allowSubtree && physicalRoot !== worktreeRoot) throw new EvidenceError("WORKSPACE_ROOT_MISMATCH");
    const gitDir = readEvidenceGit(root, ["rev-parse", "--absolute-git-dir"], 16 * 1024, opts.readOptions).trim();
    const common = readEvidenceGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024, opts.readOptions).trim();
    const head = readEvidenceGit(root, ["rev-parse", "--verify", "HEAD"], 1024, opts.readOptions).trim();
    if (!SHA.test(head)) throw new EvidenceError("INVALID_GIT_IDENTITY");
    if (readEvidenceGit(root, ["for-each-ref", "--format=%(refname)", "refs/replace"], 64 * 1024, opts.readOptions).trim()) throw new EvidenceError("REPLACED_HISTORY_UNSUPPORTED");
    const grafts = path.join(common, "info", "grafts");
    if (fs.existsSync(grafts) && fs.lstatSync(grafts).size !== 0) throw new EvidenceError("GRAFTED_HISTORY_UNSUPPORTED");
    const shallow = readEvidenceGit(root, ["rev-parse", "--is-shallow-repository"], 1024, opts.readOptions).trim() === "true";
    return { root: physicalRoot, worktreeRoot, gitDir: canonicalPath(gitDir), commonDir: canonicalPath(common), head, gitIdentity: digest(canonicalPath(gitDir) + "\0" + canonicalPath(common)), shallow };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("GIT_EVIDENCE_UNAVAILABLE");
  }
}

export function validateEvidenceRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== "string" || Buffer.byteLength(revision) > 256 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]{0,4}){0,16}$/.test(revision)
    || revision.includes("..") || revision.includes("//") || revision.includes("@{") || revision.endsWith("/") || revision.includes("/.")) {
    throw new EvidenceError("INVALID_REVISION");
  }
  const name = revision.split(/[~^]/)[0];
  if (name.split("/").some((component) => component.endsWith(".lock")) || name.endsWith(".")) throw new EvidenceError("INVALID_REVISION");
}

export function resolveEvidenceCommit(root: string, revision: unknown): string {
  validateEvidenceRevision(revision);
  const name = revision.split(/[~^]/)[0];
  if (!name.startsWith("refs/") && name !== "HEAD") {
    const branches = runEvidenceGit(root, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${name}`], 1024);
    const tags = runEvidenceGit(root, ["rev-parse", "--verify", "--end-of-options", `refs/tags/${name}`], 1024);
    const objects = /^[a-fA-F0-9]{4,64}$/.test(name)
      ? readEvidenceGit(root, ["rev-parse", `--disambiguate=${name}`], 64 * 1024).trim().split("\n").filter(Boolean)
      : [];
    if (objects.length > 1 || (branches.code === 0 && tags.code === 0) || (objects.length && (branches.code === 0 || tags.code === 0))) throw new EvidenceError("AMBIGUOUS_REVISION");
    if (objects.length === 1) {
      revision = objects[0] + revision.slice(name.length);
    } else {
    if (branches.code !== 0 && tags.code !== 0) throw new EvidenceError("MISSING_REVISION");
    revision = `${branches.code === 0 ? "refs/heads/" : "refs/tags/"}${revision}`;
    }
  }
  const resolved = runEvidenceGit(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], 1024);
  if (resolved.code !== 0) throw new EvidenceError("MISSING_OR_AMBIGUOUS_COMMIT");
  const sha = decoder.decode(resolved.stdout).trim();
  if (!SHA.test(sha)) throw new EvidenceError("INVALID_GIT_IDENTITY");
  return sha;
}

export function readEvidencePolicy(root: string) {
  const policyPath = path.join(root, ".c2cignore");
  let descriptor: number | undefined;
  try {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(policyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, bytes: Buffer.alloc(0), hash: digest("absent"), rules: new IgnoreRules(root, "") };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY || canonicalPath(policyPath) !== canonicalPath(root) + path.sep + ".c2cignore") throw new Error("unsafe policy");
    descriptor = fs.openSync(policyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw new Error("policy changed");
    const buffer = Buffer.alloc(MAX_POLICY + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > MAX_POLICY) throw new Error("oversized policy");
    const bytes = buffer.subarray(0, count);
    return { present: true, bytes, hash: digest(Buffer.concat([Buffer.from("present\0"), bytes])), rules: new IgnoreRules(root, decoder.decode(bytes)) };
  } catch { throw new EvidenceError("IGNORE_POLICY_UNAVAILABLE"); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function beginOperation(root: string) {
  const identity = observeGitRoot(root);
  const policy = readEvidencePolicy(root);
  return {
    identity, policy,
    finish() {
      if (JSON.stringify(observeGitRoot(root)) !== JSON.stringify(identity)) throw new EvidenceError("GIT_IDENTITY_CHANGED");
      const current = readEvidencePolicy(root);
      if (current.present !== policy.present || !current.bytes.equals(policy.bytes)) throw new EvidenceError("IGNORE_POLICY_CHANGED");
    },
  };
}

type ChangedPath = { status: string; path: string; oldPath?: string };

export function safeEvidencePath(value: string, rules: IgnoreRules): boolean {
  if (!value || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.includes(":")
    || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return false;
  try { return !rules.isSensitive(value); } catch { return false; }
}

function readInventory(root: string, base: string | null, head: string, rules: IgnoreRules) {
  // A local rename limit can silently omit sensitive provenance; the command deadline remains enforced.
  const args = base === null
    ? ["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", "--find-renames=1%", "--find-copies=1%", "--find-copies-harder", "-l0", head, "--"]
    : ["diff", "--name-status", "-z", "--find-renames=1%", "--find-copies=1%", "--find-copies-harder", "-l0", base, head, "--"];
  const tokens = readEvidenceGit(root, args).split("\0");
  const entries: ChangedPath[] = [];
  const unsafePaths = new Set<string>();
  let withheld = 0;
  let safeCount = 0;
  let truncated = false;
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new EvidenceError("INVALID_GIT_INVENTORY");
    const first = tokens[index++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const destination = renamed ? tokens[index++] : first;
    if (destination === undefined || first === undefined) throw new EvidenceError("INVALID_GIT_INVENTORY");
    if (!safeEvidencePath(first, rules) || !safeEvidencePath(destination, rules)) {
      unsafePaths.add(first);
      unsafePaths.add(destination);
      withheld++;
      continue;
    }
    const pathCount = renamed ? 2 : 1;
    if (safeCount + pathCount > MAX_PATHS) { truncated = true; continue; }
    safeCount += pathCount;
    entries.push({ status, path: destination, ...(renamed ? { oldPath: first } : {}) });
  }
  const safeEntries = entries.filter((entry) => {
    if (unsafePaths.has(entry.path) || (entry.oldPath && unsafePaths.has(entry.oldPath))) {
      withheld++;
      return false;
    }
    return true;
  });
  return { entries: safeEntries, withheld, safeCount, truncated };
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new EvidenceError("INVALID_LIMIT");
}

function listHistory(root: string, range: string, limit: number, rules: IgnoreRules, pathBudget = MAX_PATHS) {
  const observed = readEvidenceGit(root, ["rev-list", "--topo-order", `--max-count=${limit + 1}`, range, "--"]).trim().split("\n").filter(Boolean);
  if (observed.some((sha) => !SHA.test(sha))) throw new EvidenceError("INVALID_GIT_HISTORY");
  const truncated = observed.length > limit;
  const selected = observed.slice(0, limit).reverse();
  let pathCount = 0;
  let pathTruncated = false;
  let metadataTruncated = false;
  let withheld = 0;
  let missingParents = false;
  const commits = selected.map((sha) => {
    const object = readEvidenceGit(root, ["cat-file", "commit", sha], 1024 * 1024);
    const separator = object.indexOf("\n\n");
    if (separator < 0) throw new EvidenceError("INVALID_COMMIT_OBJECT");
    const headers = object.slice(0, separator).split("\n");
    const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
    if (parents.some((parent) => !SHA.test(parent)) || parents.length > 200) throw new EvidenceError("INVALID_COMMIT_OBJECT");
    const committer = headers.find((line) => line.startsWith("committer "));
    const timestamp = committer?.match(/ ([0-9]+) [+-][0-9]{4}$/)?.[1] ?? null;
    const subjectBytes = Buffer.from(object.slice(separator + 2).split("\n")[0]);
    let end = Math.min(subjectBytes.length, 512);
    while (end > 0 && end < subjectBytes.length && (subjectBytes[end] & 0xc0) === 0x80) end--;
    metadataTruncated ||= end < subjectBytes.length;
    const subject = subjectBytes.subarray(0, end).toString("utf8").replace(/[\x00-\x1f\x7f]/g, " ");
    const changes: Array<ChangedPath & { parent: string | null }> = [];
    for (const parent of parents.length ? parents : [null]) {
      if (parent !== null && runEvidenceGit(root, ["cat-file", "-e", `${parent}^{commit}`], 1024).code !== 0) { missingParents = true; continue; }
      const inventory = readInventory(root, parent, sha, rules);
      withheld += inventory.withheld;
      pathTruncated ||= inventory.truncated;
      for (const entry of inventory.entries) {
        const count = entry.oldPath ? 2 : 1;
        if (pathCount + count > pathBudget) { pathTruncated = true; continue; }
        pathCount += count;
        changes.push({ ...entry, parent });
      }
    }
    return { sha, parents, timestamp, subject, changedPaths: changes };
  });
  return { commits, truncated, pathTruncated, metadataTruncated, withheld, missingParents, order: "topological-oldest-to-newest" as const, range };
}

export function readGitHistory(root: string, opts: { ref?: string; limit?: number } = {}) {
  const ref = opts.ref ?? "HEAD";
  validateEvidenceRevision(ref);
  const limit = opts.limit ?? 100;
  validateLimit(limit);
  const operation = beginOperation(root);
  const resolvedRef = resolveEvidenceCommit(root, ref);
  const history = listHistory(root, resolvedRef, limit, operation.policy.rules);
  if (resolveEvidenceCommit(root, ref) !== resolvedRef) throw new EvidenceError("EVIDENCE_CHANGED");
  operation.finish();
  return {
    resolvedRef, requestedRef: ref, limit, gitIdentity: operation.identity.gitIdentity,
    policyDigest: operation.policy.hash, ...history,
    completeness: {
      commits: !history.truncated && !operation.identity.shallow && !history.missingParents,
      paths: !history.pathTruncated && !history.missingParents,
      metadata: !history.metadataTruncated, sensitiveWithheld: history.withheld,
      shallow: operation.identity.shallow, missingObjects: history.missingParents,
    },
  };
}

function renderSafeDiff(root: string, base: string, head: string, inventory: ReturnType<typeof readInventory>) {
  if (inventory.truncated) throw new EvidenceError("PATH_INVENTORY_TRUNCATED");
  const uniquePaths = [...new Set(inventory.entries.flatMap((entry) => entry.oldPath ? [entry.oldPath, entry.path] : [entry.path]))];
  const chunks: Buffer[] = [];
  let total = 0;
  let unsupported = 0;
  // Rendering each endpoint path without rename inference cannot import a hidden origin.
  for (const file of uniquePaths) {
    const modes = [base, head].map((sha) => readEvidenceGit(root, ["ls-tree", "-z", sha, "--", `:(literal)${file}`], 16 * 1024));
    if (modes.some((entry) => entry && !/^(?:100644|100755) blob [a-f0-9]+\t/.test(entry))) { unsupported++; continue; }
    const patch = runEvidenceGit(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", base, head, "--", `:(literal)${file}`]);
    if (patch.code !== 0) throw new EvidenceError("GIT_DIFF_UNAVAILABLE");
    total += patch.stdout.length;
    if (total > MAX_OUTPUT) throw new EvidenceError("DIFF_TOO_LARGE");
    try { decoder.decode(patch.stdout); } catch { throw new EvidenceError("INVALID_GIT_ENCODING"); }
    chunks.push(patch.stdout);
  }
  return { bytes: Buffer.concat(chunks), unsupported };
}

export function readGitComparison(root: string, opts: { base: string; head: string; limit?: number; offset?: number; max_bytes?: number; expected_evidence_id?: string }) {
  validateEvidenceRevision(opts.base);
  validateEvidenceRevision(opts.head);
  const limit = opts.limit ?? 100;
  validateLimit(limit);
  const offset = opts.offset ?? 0;
  const maxBytes = opts.max_bytes ?? 65536;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 262144
    || (offset > 0 && !opts.expected_evidence_id) || (opts.expected_evidence_id !== undefined && !/^[a-f0-9]{64}$/.test(opts.expected_evidence_id))) throw new EvidenceError("INVALID_PAGINATION");
  const operation = beginOperation(root);
  const base = resolveEvidenceCommit(root, opts.base);
  const head = resolveEvidenceCommit(root, opts.head);
  const merge = runEvidenceGit(root, ["merge-base", "--all", base, head], 64 * 1024);
  if (merge.code !== 0 && merge.code !== 1) throw new EvidenceError("ANCESTRY_UNAVAILABLE");
  const mergeBases = decoder.decode(merge.stdout).trim().split("\n").filter(Boolean);
  if (mergeBases.some((sha) => !SHA.test(sha))) throw new EvidenceError("INVALID_GIT_HISTORY");
  const isAncestor = (ancestor: string, descendant: string) => {
    const answer = runEvidenceGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], 1024);
    if (answer.code !== 0 && answer.code !== 1) throw new EvidenceError("ANCESTRY_UNAVAILABLE");
    return answer.code === 0;
  };
  const relation = base === head ? "same" : isAncestor(base, head) ? "base-ancestor" : isAncestor(head, base) ? "head-ancestor" : "diverged";
  const inventory = readInventory(root, base, head, operation.policy.rules);
  const history = listHistory(root, `${base}..${head}`, limit, operation.policy.rules, MAX_PATHS - inventory.safeCount);
  const safeDiff = renderSafeDiff(root, base, head, inventory);
  const evidenceId = digest(JSON.stringify({ base, head, identity: operation.identity.gitIdentity, policy: operation.policy.hash, inventory, diffDigest: digest(safeDiff.bytes) }));
  if (opts.expected_evidence_id !== undefined && opts.expected_evidence_id !== evidenceId) throw new EvidenceError("EVIDENCE_CHANGED");
  if (offset > safeDiff.bytes.length || (offset < safeDiff.bytes.length && (safeDiff.bytes[offset] & 0xc0) === 0x80)) throw new EvidenceError("INVALID_PAGINATION");
  let end = Math.min(offset + maxBytes, safeDiff.bytes.length);
  while (end > offset && end < safeDiff.bytes.length && (safeDiff.bytes[end] & 0xc0) === 0x80) end--;
  if (end === offset && offset < safeDiff.bytes.length) throw new EvidenceError("INVALID_PAGINATION");
  if (resolveEvidenceCommit(root, opts.base) !== base || resolveEvidenceCommit(root, opts.head) !== head) throw new EvidenceError("EVIDENCE_CHANGED");
  operation.finish();
  return {
    base, head, mergeBases, relation, ancestryComplete: !operation.identity.shallow,
    rangeMeaning: "head-side base..head; endpoint diff compares base to head", limit, history,
    changedPaths: inventory.entries, evidenceId, policyDigest: operation.policy.hash,
    diff: safeDiff.bytes.subarray(offset, end).toString("utf8"), diffDigest: digest(safeDiff.bytes),
    totalBytes: safeDiff.bytes.length, offset, returnedBytes: end - offset,
    coverage: { start: offset, end, extent: safeDiff.bytes.length },
    hasMore: end < safeDiff.bytes.length, nextOffset: end < safeDiff.bytes.length ? end : null,
    completeness: {
      commits: !history.truncated && !operation.identity.shallow && !history.missingParents,
      paths: !inventory.truncated, historyPaths: !history.pathTruncated && !history.missingParents,
      metadata: !history.metadataTruncated, safeDiff: safeDiff.unsupported === 0,
      sensitiveWithheld: inventory.withheld, historySensitiveWithheld: history.withheld,
      unsupportedModes: safeDiff.unsupported, shallow: operation.identity.shallow, missingObjects: history.missingParents,
      allPagesRetrieved: offset === 0 && end === safeDiff.bytes.length,
    },
  };
}
