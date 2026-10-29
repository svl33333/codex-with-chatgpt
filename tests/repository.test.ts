import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubRepository, resolveWorkspaceRepository } from "../src/workspace/repository.js";
import { canonicalRepositoryFor } from "../src/connection/identity.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanup(root); });
function createRepository() { const root = makeTmpDir("repository-selector"); roots.push(root); makeGitRepo(root); return root; }

describe("shared workspace repository selection", () => {
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
