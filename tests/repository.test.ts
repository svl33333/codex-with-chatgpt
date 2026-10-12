import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubRepository, resolveWorkspaceRepository } from "../src/workspace/repository.js";
import { canonicalRepositoryFor } from "../src/connection/identity.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function createRepository() { const root = makeTmpDir("repository-selector"); roots.push(root); makeGitRepo(root); return root; }

describe("shared workspace repository selection", () => {
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
