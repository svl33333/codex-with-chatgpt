import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubRepository, resolveWorkspaceRepository } from "../src/workspace/repository.js";
import { canonicalRepositoryFor, getInstallationIdentity, readWorktreeIdentity, makeConnectionBinding, readConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const roots: string[] = [];
const originalStateDir = process.env.C2C_STATE_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) cleanup(root);
});
function createRepository() { const root = makeTmpDir("repository-selector"); roots.push(root); makeGitRepo(root); return root; }

describe("shared workspace repository selection", () => {
  it("reads full worktree identity using the upstream repository without changing v2 binding fields", () => {
    const root = createRepository();
    process.env.C2C_STATE_DIR = root;
    git(root, "remote", "add", "origin", "https://github.com/example/fork");
    git(root, "remote", "add", "upstream", "https://github.com/example/source");
    git(root, "config", "branch.main.remote", "upstream");
    git(root, "config", "branch.main.merge", "refs/heads/main");
    const installation = getInstallationIdentity();
    const saved = writeConnectionBinding(makeConnectionBinding({
      workspaceRoot: root, workspaceId: "main-v2", workspace: "main", endpoint: "https://synthetic.invalid/mcp",
      accountFingerprint: "synthetic-account", selectedSurface: "chatgpt_web", reviewerBinding: "synthetic-reviewer",
      readOnlyRequired: true, readOnlyProof: "verified", projectId: "synthetic-project", projectName: "retained",
    }));
    const before = fs.readFileSync(path.join(root, "bindings", "main-v2.json"));
    expect(readWorktreeIdentity({ workspaceRoot: root })).toMatchObject({
      canonicalRepository: "https://github.com/example/source", installationId: installation.installationId,
      branch: "main", observedCommit: git(root, "rev-parse", "HEAD").trim(), worktreeRoot: root,
    });
    expect(readConnectionBinding("main-v2")).toEqual(saved);
    expect(fs.readFileSync(path.join(root, "bindings", "main-v2.json"))).toEqual(before);
  });

  it("refuses missing installation and ambiguous repository identities without manufacturing state", () => {
    const root = createRepository(); process.env.C2C_STATE_DIR = root;
    expect(() => readWorktreeIdentity({ workspaceRoot: root })).toThrow("INSTALLATION_IDENTITY_UNAVAILABLE");
    expect(fs.existsSync(path.join(root, "installation.json"))).toBe(false);
    getInstallationIdentity();
    git(root, "remote", "add", "origin", "https://github.com/example/fork");
    git(root, "remote", "add", "upstream", "https://github.com/example/source");
    expect(() => readWorktreeIdentity({ workspaceRoot: root })).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
  });

  it("reports failed Git status as unknown and refuses an unavailable commit", () => {
    const root = createRepository(); process.env.C2C_STATE_DIR = root; getInstallationIdentity();
    const original = actualChildProcess.spawnSync;
    vi.spyOn(childProcess, "spawnSync").mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
      const result = Reflect.apply(original, childProcess, args);
      if ((args[1] as string[]).includes("diff")) return { ...result, status: 2 };
      return result;
    });
    expect(readWorktreeIdentity({ workspaceRoot: root }).dirtyState).toBe("unknown");
    vi.mocked(childProcess.spawnSync).mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
      const result = Reflect.apply(original, childProcess, args);
      if ((args[1] as string[]).includes("--verify")) return { ...result, status: 1 };
      return result;
    });
    expect(() => readWorktreeIdentity({ workspaceRoot: root })).toThrow("WORKTREE_IDENTITY_UNAVAILABLE");
  });

  it("ignores inherited Git directory overrides for both worktree and repository identity", () => {
    const root = createRepository(); const foreign = createRepository();
    process.env.C2C_STATE_DIR = root; getInstallationIdentity();
    const expected = readWorktreeIdentity({ workspaceRoot: root });
    const previous = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = path.join(foreign, ".git");
      expect(readWorktreeIdentity({ workspaceRoot: root })).toEqual(expected);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
  it("propagates cancellation through remote config reads and refuses an expired deadline", () => {
    const root = createRepository(); git(root, "remote", "add", "origin", "https://github.com/example/demo");
    const controller = new AbortController(); const original = actualChildProcess.spawnSync; let reachedConfig = false;
    vi.spyOn(childProcess, "spawnSync").mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
      const result = Reflect.apply(original, childProcess, args);
      if ((args[1] as string[]).includes("remote.origin.url")) { reachedConfig = true; controller.abort(); }
      return result;
    });
    expect(() => resolveWorkspaceRepository(root, { signal: controller.signal, deadline: performance.now() + 60_000 })).toThrow("MANIFEST_CANCELLED");
    expect(reachedConfig).toBe(true);
    expect(() => resolveWorkspaceRepository(root, { deadline: performance.now() - 1 })).toThrow("MANIFEST_TIMEOUT");
  });
  it("uses the unique GitHub remote when origin is absent", () => {
    const root = createRepository(); git(root, "remote", "add", "canonical", "git@github.com:Example/Demo.git");
    expect(resolveWorkspaceRepository(root)).toMatchObject({ repository: "https://github.com/example/demo", remote: "canonical", selection: "unique-github-remote" });
    expect(canonicalRepositoryFor(root)).toBe("https://github.com/example/demo");
  });
  it("uses the configured upstream when origin names another repository", () => {
    const root = createRepository(); git(root, "remote", "add", "origin", "https://github.com/example/fork.git");
    git(root, "remote", "add", "upstream", "https://github.com/example/source.git");
    git(root, "config", "branch.main.remote", "upstream"); git(root, "config", "branch.main.merge", "refs/heads/main");
    expect(resolveWorkspaceRepository(root)).toMatchObject({ remote: "upstream", selection: "branch-upstream" });
    expect(canonicalRepositoryFor(root)).toBe("https://github.com/example/source");
  });
  it("refuses ambiguous remotes and incomplete upstream instead of silently using origin", () => {
    const root = createRepository(); git(root, "remote", "add", "origin", "https://github.com/example/one"); git(root, "remote", "add", "other", "https://github.com/example/two");
    expect(() => canonicalRepositoryFor(root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
    git(root, "config", "branch.main.remote", "origin");
    expect(() => canonicalRepositoryFor(root)).toThrow("INVALID_UPSTREAM_REMOTE");
  });
  it("refuses detached heads and unknown-only hosts while preserving local-only identities", () => {
    const root = createRepository(); expect(resolveWorkspaceRepository(root).selection).toBe("local-only");
    git(root, "remote", "add", "origin", "https://unknown.invalid/example/demo");
    expect(() => canonicalRepositoryFor(root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
    git(root, "checkout", "--detach"); expect(() => canonicalRepositoryFor(root)).toThrow("DETACHED_REPOSITORY_UNAVAILABLE");
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-no-git-")); roots.push(local);
    expect(resolveWorkspaceRepository(local).selection).toBe("local-only");
  });
  it("preserves repository selection for a workspace rooted in a legitimate Git subtree", () => {
    const root = createRepository(); git(root, "remote", "add", "origin", "https://github.com/example/demo");
    expect(canonicalRepositoryFor(path.join(root, "src"))).toBe(canonicalRepositoryFor(root));
  });
  it("honors effective worktree upstream settings and refuses conflicting URL overrides", () => {
    const root = createRepository(); git(root, "remote", "add", "origin", "https://github.com/example/fork"); git(root, "remote", "add", "upstream", "https://github.com/example/source");
    git(root, "config", "extensions.worktreeConfig", "true");
    git(root, "config", "--worktree", "branch.main.remote", "upstream"); git(root, "config", "--worktree", "branch.main.merge", "refs/heads/main");
    expect(canonicalRepositoryFor(root)).toBe("https://github.com/example/source");
    git(root, "config", "--worktree", "remote.upstream.url", "https://github.com/example/override");
    expect(() => canonicalRepositoryFor(root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
  });
  it.each(["https://user:password@github.com/example/demo", "https://github.com:443/example/demo", "https://github.com/example/demo?token=private", "https://github.com/example/demo#private", "https://github.com/example/../demo", "ssh://git@github.com/example/demo", "https://github.com/example/%64emo"])("refuses unsafe repository URLs without including them in errors: %s", (remote) => {
    expect(() => parseGitHubRepository(remote)).toThrow("INVALID_REPOSITORY_REMOTE");
    const root = createRepository(); git(root, "remote", "add", "origin", remote);
    expect(() => canonicalRepositoryFor(root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
  });
});
