import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createIssueEvidenceContext, parseGitHubRepository, resolveIssueRepository, verifyIssueEvidenceContext } from "../src/github/repository-evidence.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function repository() {
  const root = makeTmpDir("issue-repository"); roots.push(root); makeGitRepo(root); return root;
}
function upstream(root: string, url = "https://github.com/example/reviewer.git") {
  git(root, "remote", "add", "canonical", url);
  git(root, "config", "branch.main.remote", "canonical");
  git(root, "config", "branch.main.merge", "refs/heads/main");
}

describe("workspace-bound GitHub repository evidence", () => {
  it("selects the configured non-origin upstream and ignores unrelated origin", () => {
    const root = repository(); upstream(root);
    git(root, "remote", "add", "origin", "https://github.com/foreign/unrelated.git");
    expect(resolveIssueRepository(root)).toMatchObject({ owner: "example", name: "reviewer", remote: "canonical", selection: "branch-upstream" });
  });

  it.each(["file:///private/repo", "https://other.example/owner/repo", "https://user:secret@github.com/owner/repo"])("rejects an invalid upstream without falling back to origin: %s", (url) => {
    const root = repository(); upstream(root, url);
    git(root, "remote", "add", "origin", "https://github.com/example/reviewer.git");
    expect(() => resolveIssueRepository(root)).toThrow();
  });

  it("uses one GitHub remote only when upstream is absent and rejects duplicate authority", () => {
    const root = repository();
    git(root, "remote", "add", "public", "git@github.com:Example/Reviewer.git");
    expect(resolveIssueRepository(root)).toMatchObject({ repository: "https://github.com/example/reviewer", selection: "unique-github-remote" });
    git(root, "remote", "add", "same", "https://github.com/example/reviewer.git");
    expect(() => resolveIssueRepository(root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
  });

  it("does not silently approve a changed branch, remote or caller workspace within a bridge", () => {
    const root = repository(); upstream(root);
    const context = createIssueEvidenceContext(root, "fixture-workspace");
    expect(verifyIssueEvidenceContext(context, root, "fixture-workspace")).toEqual(context.binding);
    expect(() => verifyIssueEvidenceContext(context, root, "other")).toThrow("WORKSPACE_BINDING_MISMATCH");
    git(root, "remote", "set-url", "canonical", "https://github.com/foreign/reviewer.git");
    expect(() => verifyIssueEvidenceContext(context, root, "fixture-workspace")).toThrow("REPOSITORY_BINDING_CHANGED");
    git(root, "remote", "set-url", "canonical", "https://github.com/example/reviewer.git");
    git(root, "checkout", "-b", "other");
    expect(() => verifyIssueEvidenceContext(context, root, "fixture-workspace")).toThrow("REPOSITORY_BINDING_CHANGED");
  });

  it("rejects detached and nested workspace roots", () => {
    const root = repository(); upstream(root);
    fs.mkdirSync(path.join(root, "nested"));
    expect(() => resolveIssueRepository(path.join(root, "nested"))).toThrow("WORKSPACE_ROOT_MISMATCH");
    git(root, "checkout", "--detach");
    expect(() => resolveIssueRepository(root)).toThrow("DETACHED_REPOSITORY_UNAVAILABLE");
  });

  it("rejects malformed configured upstream refs and trailing remote whitespace without fallback", () => {
    const root = repository(); upstream(root);
    git(root, "config", "branch.main.merge", "refs/heads/main/");
    expect(() => resolveIssueRepository(root)).toThrow("INVALID_UPSTREAM_REMOTE");
    git(root, "config", "branch.main.merge", "refs/heads/cache.lock/main");
    expect(() => resolveIssueRepository(root)).toThrow("INVALID_UPSTREAM_REMOTE");
    git(root, "config", "branch.main.merge", "refs/heads/main");
    git(root, "config", "remote.canonical.url", "https://github.com/example/reviewer.git ");
    expect(() => resolveIssueRepository(root)).toThrow("INVALID_REPOSITORY_REMOTE");
  });

  it.each([
    "http://github.com/example/reviewer", "https://github.com:443/example/reviewer", "https://github.com/example/reviewer?x=y",
    "https://github.com/example/reviewer#fragment", "https://github.com/example%2freviewer/repo", "https://github.com/example/../reviewer",
    "https://github.com/example/reviewer/extra", "ssh://git@github.com/example/reviewer", "git@other.example:example/reviewer",
    "https://github.com/a/../example/reviewer", "https://github.com/example/./reviewer",
  ])("rejects noncanonical URL input %s", (url) => { expect(() => parseGitHubRepository(url)).toThrow(); });
});
