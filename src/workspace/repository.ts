import { createHash } from "node:crypto";
import { EvidenceError, canonicalPath, observeGitRoot, readEvidenceGit, runEvidenceGit, validateEvidenceRevision, type EvidenceReadOptions } from "./git-evidence.js";

export interface WorkspaceRepository {
  owner: string;
  name: string;
  repository: string;
  remote: string;
  branch: string;
  upstream: string | null;
  selection: "branch-upstream" | "unique-github-remote";
  rootIdentity: string;
}

export function parseGitHubRepository(remoteUrl: string): { owner: string; name: string; repository: string } {
  if (Buffer.byteLength(remoteUrl) > 2048 || /[\x00-\x20\x7f]/.test(remoteUrl) || /\/\.{1,2}\//.test(remoteUrl)) throw new EvidenceError("INVALID_REPOSITORY_REMOTE");
  let owner: string;
  let name: string;
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(remoteUrl);
  if (ssh) [, owner, name] = ssh;
  else {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(remoteUrl)) throw new EvidenceError("INVALID_REPOSITORY_REMOTE");
    let url: URL;
    try { url = new URL(remoteUrl); } catch { throw new EvidenceError("INVALID_REPOSITORY_REMOTE"); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash
      || !/^https:\/\/github\.com\//i.test(remoteUrl) || /%|\\/.test(remoteUrl)) throw new EvidenceError("INVALID_REPOSITORY_REMOTE");
    const parts = url.pathname.split("/");
    if (parts.length !== 3) throw new EvidenceError("INVALID_REPOSITORY_REMOTE");
    [, owner, name] = parts;
  }
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") throw new EvidenceError("INVALID_REPOSITORY_REMOTE");
  owner = owner.toLowerCase();
  name = name.toLowerCase();
  return { owner, name, repository: `https://github.com/${owner}/${name}` };
}

function safeConfigName(value: string): boolean {
  return Buffer.byteLength(value) <= 256 && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) && !value.includes("..") && !value.includes("//");
}

function readOptionalConfig(root: string, key: string, options: EvidenceReadOptions = {}): string | null {
  const result = runEvidenceGit(root, ["config", "--null", "--get-all", key], 4096, options);
  if (result.code === 1) return null;
  if (result.code !== 0) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const values = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).split("\0");
  if (values.pop() !== "") throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  if (values.length !== 1 || !values[0]) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
  return values[0];
}

export function resolveWorkspaceRepository(root: string, options: EvidenceReadOptions = {}): WorkspaceRepository | { repository: string; selection: "local-only" } {
  const inside = runEvidenceGit(root, ["rev-parse", "--is-inside-work-tree"], 1024, options);
  if (inside.code !== 0) return { repository: `file:${canonicalPath(root)}`, selection: "local-only" };
  const identity = observeGitRoot(root, { allowSubtree: true, readOptions: options });
  const symbolic = runEvidenceGit(root, ["symbolic-ref", "--quiet", "HEAD"], 4096, options);
  if (symbolic.code !== 0) throw new EvidenceError("DETACHED_REPOSITORY_UNAVAILABLE");
  const ref = new TextDecoder("utf-8", { fatal: true }).decode(symbolic.stdout).trim();
  if (!ref.startsWith("refs/heads/")) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const branch = ref.slice(11);
  if (!safeConfigName(branch)) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const upstreamRemote = readOptionalConfig(root, `branch.${branch}.remote`, options);
  const upstreamRef = readOptionalConfig(root, `branch.${branch}.merge`, options);
  let remote: string;
  let selection: WorkspaceRepository["selection"];
  let resolved: ReturnType<typeof parseGitHubRepository>;
  if (upstreamRemote !== null || upstreamRef !== null) {
    if (!upstreamRemote || !upstreamRef || !safeConfigName(upstreamRemote) || !safeConfigName(upstreamRef)) throw new EvidenceError("INVALID_UPSTREAM_REMOTE");
    try {
      validateEvidenceRevision(upstreamRef);
      if (!upstreamRef.startsWith("refs/") || /[~^]/.test(upstreamRef)) throw new Error("invalid upstream ref");
    } catch { throw new EvidenceError("INVALID_UPSTREAM_REMOTE"); }
    remote = upstreamRemote;
    const url = readOptionalConfig(root, `remote.${remote}.url`, options);
    if (!url) throw new EvidenceError("INVALID_UPSTREAM_REMOTE");
    resolved = parseGitHubRepository(url);
    selection = "branch-upstream";
  } else {
    const remotes = readEvidenceGit(root, ["remote"], 16 * 1024, options).trim().split("\n").filter(Boolean);
    if (remotes.length === 0) return { repository: `file:${identity.root}`, selection: "local-only" };
    if (remotes.length > 32 || remotes.some((name) => !safeConfigName(name))) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
    const candidates: Array<{ remote: string; parsed: ReturnType<typeof parseGitHubRepository> }> = [];
    for (const name of remotes) {
      const url = readOptionalConfig(root, `remote.${name}.url`, options);
      if (!url) continue;
      try { candidates.push({ remote: name, parsed: parseGitHubRepository(url) }); }
      catch (error) { if (!(error instanceof EvidenceError)) throw error; }
    }
    if (candidates.length !== 1) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
    ({ remote, parsed: resolved } = candidates[0]);
    selection = "unique-github-remote";
  }
  return {
    ...resolved, branch, remote, upstream: upstreamRef, selection,
    rootIdentity: createHash("sha256").update(identity.root + "\0" + identity.gitIdentity).digest("hex"),
  };
}

export function resolveRestartRepository(root: string, expectedRepository: string) {
  const identity = observeGitRoot(root, { allowSubtree: true });
  if (readEvidenceGit(root, ["cat-file", "-t", identity.head], 1024).trim() !== "commit") {
    throw new EvidenceError("RESTART_HEAD_UNAVAILABLE");
  }
  const expected = parseGitHubRepository(expectedRepository).repository;
  const symbolic = runEvidenceGit(root, ["symbolic-ref", "--quiet", "HEAD"], 4096);
  let repository: string;
  let remote: string;
  let branch: string | null = null;
  if (symbolic.code === 0) {
    const selected = resolveWorkspaceRepository(root);
    if (!("remote" in selected)) throw new EvidenceError("RESTART_REPOSITORY_UNAVAILABLE");
    ({ repository, remote, branch } = selected);
  } else if (symbolic.code === 1) {
    const remotes = readEvidenceGit(root, ["remote"], 16 * 1024).trim().split("\n").filter(Boolean);
    if (remotes.length !== 1 || !safeConfigName(remotes[0])) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
    remote = remotes[0];
    const url = readOptionalConfig(root, "remote." + remote + ".url");
    if (!url) throw new EvidenceError("RESTART_REPOSITORY_UNAVAILABLE");
    repository = parseGitHubRepository(url).repository;
  } else {
    throw new EvidenceError("RESTART_REPOSITORY_UNAVAILABLE");
  }
  if (repository !== expected) throw new EvidenceError("RESTART_REPOSITORY_MISMATCH");
  return { identity, repository, remote, branch };
}
