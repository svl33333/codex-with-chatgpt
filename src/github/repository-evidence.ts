import { createHash } from "node:crypto";
import { EvidenceError, observeGitRoot, readEvidenceGit, runEvidenceGit, validateEvidenceRevision } from "../workspace/git-evidence.js";

export interface IssueRepository {
  owner: string;
  name: string;
  repository: string;
  remote: string;
  branch: string;
  upstream: string | null;
  selection: "branch-upstream" | "unique-github-remote";
  rootIdentity: string;
}

export type IssueEvidenceContext = {
  workspaceId: string;
  root: string;
  binding: IssueRepository | null;
  unavailableCode: string | null;
};

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

function readOptionalConfig(root: string, key: string): string | null {
  const result = runEvidenceGit(root, ["config", "--local", "--null", "--get-all", key], 4096);
  if (result.code === 1) return null;
  if (result.code !== 0) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const values = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).split("\0");
  if (values.pop() !== "") throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  if (values.length !== 1 || !values[0]) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
  return values[0];
}

export function resolveIssueRepository(root: string): IssueRepository {
  const identity = observeGitRoot(root);
  const symbolic = runEvidenceGit(root, ["symbolic-ref", "--quiet", "HEAD"], 4096);
  if (symbolic.code !== 0) throw new EvidenceError("DETACHED_REPOSITORY_UNAVAILABLE");
  const ref = new TextDecoder("utf-8", { fatal: true }).decode(symbolic.stdout).trim();
  if (!ref.startsWith("refs/heads/")) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const branch = ref.slice(11);
  if (!safeConfigName(branch)) throw new EvidenceError("REPOSITORY_UNAVAILABLE");
  const upstreamRemote = readOptionalConfig(root, `branch.${branch}.remote`);
  const upstreamRef = readOptionalConfig(root, `branch.${branch}.merge`);
  let remote: string;
  let selection: IssueRepository["selection"];
  let resolved: ReturnType<typeof parseGitHubRepository>;
  if (upstreamRemote !== null || upstreamRef !== null) {
    if (!upstreamRemote || !upstreamRef || !safeConfigName(upstreamRemote) || !safeConfigName(upstreamRef)) throw new EvidenceError("INVALID_UPSTREAM_REMOTE");
    try {
      validateEvidenceRevision(upstreamRef);
      if (!upstreamRef.startsWith("refs/") || /[~^]/.test(upstreamRef)) throw new Error("invalid upstream ref");
    } catch { throw new EvidenceError("INVALID_UPSTREAM_REMOTE"); }
    remote = upstreamRemote;
    const url = readOptionalConfig(root, `remote.${remote}.url`);
    if (!url) throw new EvidenceError("INVALID_UPSTREAM_REMOTE");
    resolved = parseGitHubRepository(url);
    selection = "branch-upstream";
  } else {
    const remotes = readEvidenceGit(root, ["remote"], 16 * 1024).trim().split("\n").filter(Boolean);
    if (remotes.length > 32 || remotes.some((name) => !safeConfigName(name))) throw new EvidenceError("AMBIGUOUS_REPOSITORY_REMOTE");
    const candidates: Array<{ remote: string; parsed: ReturnType<typeof parseGitHubRepository> }> = [];
    for (const name of remotes) {
      const url = readOptionalConfig(root, `remote.${name}.url`);
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

export function createIssueEvidenceContext(root: string, workspaceId: string): IssueEvidenceContext {
  try { return { root, workspaceId, binding: resolveIssueRepository(root), unavailableCode: null }; }
  catch (error) {
    return { root, workspaceId, binding: null, unavailableCode: error instanceof EvidenceError ? error.code : "REPOSITORY_UNAVAILABLE" };
  }
}

export function verifyIssueEvidenceContext(context: IssueEvidenceContext, root: string, workspaceId: string): IssueRepository {
  if (root !== context.root || workspaceId !== context.workspaceId) throw new EvidenceError("WORKSPACE_BINDING_MISMATCH");
  if (!context.binding) throw new EvidenceError(context.unavailableCode ?? "REPOSITORY_UNAVAILABLE");
  let current: IssueRepository;
  try { current = resolveIssueRepository(root); }
  catch { throw new EvidenceError("REPOSITORY_BINDING_CHANGED"); }
  if (JSON.stringify(current) !== JSON.stringify(context.binding)) throw new EvidenceError("REPOSITORY_BINDING_CHANGED");
  return current;
}
