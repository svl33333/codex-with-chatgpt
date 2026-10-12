import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readGitComparison, readGitHistory, resolveEvidenceCommit, validateEvidenceRevision } from "../src/workspace/git-evidence.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function repository() { const root = makeTmpDir("git-evidence"); roots.push(root); makeGitRepo(root); return root; }
function commit(root: string, file: string, body: string, subject = "fixture change") {
  write(root, file, body); git(root, "add", "-f", "--", file); git(root, "commit", "-m", subject); return git(root, "rev-parse", "HEAD").trim();
}
function snapshot(root: string) {
  const index = path.resolve(root, git(root, "rev-parse", "--git-path", "index").trim());
  return {
    head: git(root, "rev-parse", "HEAD"), refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: createHash("sha256").update(fs.readFileSync(index)).digest("hex"),
    status: git(root, "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

describe("bounded read-only local Git evidence", () => {
  it("returns full SHAs, object parents, oldest-to-newest order and exact endpoint diff without mutations", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    const head = commit(root, "src/index.ts", "export const answer = 43;\n");
    write(root, "uncommitted.txt", "preserve me\n");
    const before = snapshot(root);
    const history = readGitHistory(root);
    expect(history.limit).toBe(100); expect(history.commits.map((entry) => entry.sha)).toEqual([base, head]);
    expect(history.commits[1].parents).toEqual([base]); expect(history.completeness.commits).toBe(true);
    const comparison = readGitComparison(root, { base, head });
    expect(comparison).toMatchObject({ base, head, mergeBases: [base], relation: "base-ancestor", hasMore: false });
    expect(comparison.history.commits.map((entry) => entry.sha)).toEqual([head]);
    expect(comparison.diff).toContain("+export const answer = 43;");
    expect(snapshot(root)).toEqual(before); expect(fs.readFileSync(path.join(root, "uncommitted.txt"), "utf8")).toBe("preserve me\n");
  });

  it.each(["-h", "HEAD\n--all", "HEAD:secret", "HEAD..main", "HEAD@{1}", "refs/*", "a".repeat(257), "refs/../main", "refs/heads/cache.lock/main"])("rejects revision input before attempting to inspect Git: %j", (revision) => {
    expect(() => validateEvidenceRevision(revision)).toThrow("INVALID_REVISION");
    expect(() => readGitComparison("a-root-that-does-not-exist", { base: "HEAD", head: revision })).toThrow("INVALID_REVISION");
  });

  it("resolves explicit refs, unique short SHAs and ancestry while rejecting missing and ambiguous names", () => {
    const root = repository(); const first = git(root, "rev-parse", "HEAD").trim();
    commit(root, "hello.txt", "second\n");
    expect(resolveEvidenceCommit(root, "HEAD^1")).toBe(first);
    expect(resolveEvidenceCommit(root, first.slice(0, 12))).toBe(first);
    git(root, "tag", "main", first);
    expect(() => resolveEvidenceCommit(root, "main")).toThrow("AMBIGUOUS_REVISION");
    expect(resolveEvidenceCommit(root, "refs/tags/main")).toBe(first);
    expect(() => resolveEvidenceCommit(root, "missing")).toThrow("MISSING_REVISION");
    const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
    expect(() => resolveEvidenceCommit(root, blob)).toThrow("MISSING_OR_AMBIGUOUS_COMMIT");
  });

  it("reports merge history against every real object parent", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-b", "side"); const side = commit(root, "side.txt", "side\n");
    git(root, "checkout", "main"); const main = commit(root, "main.txt", "main\n");
    const diverged = readGitComparison(root, { base: main, head: side });
    expect(diverged.relation).toBe("diverged"); expect(diverged.mergeBases).toEqual([base]);
    expect(diverged.history.commits.map((entry) => entry.sha)).toEqual([side]);
    git(root, "merge", "--no-ff", "side", "-m", "merge fixture");
    const history = readGitHistory(root);
    const merged = history.commits.at(-1)!;
    expect(merged.parents).toEqual([main, side]);
    expect(merged.changedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "side.txt", parent: main }), expect.objectContaining({ path: "main.txt", parent: side }),
    ]));
    expect(readGitComparison(root, { base: side, head: base }).relation).toBe("head-ancestor");
    expect(readGitComparison(root, { base, head: base }).relation).toBe("same");
  });

  it("binds UTF-8 pages to evidence identity and rejects gaps disguised as complete evidence", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    const head = commit(root, "unicode.txt", "日本語é🙂".repeat(1000) + "\n");
    const first = readGitComparison(root, { base, head, max_bytes: 1024 });
    expect(first.hasMore).toBe(true); expect(first.returnedBytes).toBe(Buffer.byteLength(first.diff));
    expect(first.completeness.allPagesRetrieved).toBe(false);
    expect(() => readGitComparison(root, { base, head, offset: first.nextOffset!, max_bytes: 1024 })).toThrow("INVALID_PAGINATION");
    let combined = first.diff; let cursor = first.nextOffset;
    while (cursor !== null) {
      const page = readGitComparison(root, { base, head, offset: cursor, max_bytes: 262144, expected_evidence_id: first.evidenceId });
      expect(page.coverage.start).toBe(cursor); expect(page.returnedBytes).toBe(Buffer.byteLength(page.diff));
      expect(page.diff).not.toContain("�"); combined += page.diff; cursor = page.nextOffset;
    }
    expect(createHash("sha256").update(combined).digest("hex")).toBe(first.diffDigest);
    const end = readGitComparison(root, { base, head, offset: first.totalBytes, expected_evidence_id: first.evidenceId });
    expect(end).toMatchObject({ returnedBytes: 0, hasMore: false, nextOffset: null });
    expect(() => readGitComparison(root, { base, head, offset: first.totalBytes + 1, expected_evidence_id: first.evidenceId })).toThrow("INVALID_PAGINATION");
    const bytes = Buffer.from(combined); const continuationByte = bytes.findIndex((byte) => (byte & 0xc0) === 0x80);
    expect(() => readGitComparison(root, { base, head, offset: continuationByte, expected_evidence_id: first.evidenceId })).toThrow("INVALID_PAGINATION");
    write(root, ".c2cignore", "unicode.txt\n");
    expect(() => readGitComparison(root, { base, head, offset: first.nextOffset!, expected_evidence_id: first.evidenceId })).toThrow("EVIDENCE_CHANGED");
    const fresh = readGitComparison(root, { base, head });
    expect(fresh.diff).toBe(""); expect(fresh.completeness.sensitiveWithheld).toBe(1);
  });

  it.each([false, true])("withholds a sensitive copy and its reused source provenance (rewrite source=%s)", (rewrite) => {
    const root = repository();
    const secret = "SECRET_SENTINEL_OLD_CONTENT\n".repeat(100);
    const base = commit(root, ".env", secret);
    write(root, "public.txt", secret);
    if (rewrite) write(root, ".env", "replacement secret\n");
    git(root, "add", "-f", ".env", "public.txt"); git(root, "commit", "-m", "copy fixture");
    const head = git(root, "rev-parse", "HEAD").trim();
    const result = readGitComparison(root, { base, head });
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    expect(result.diff).not.toContain("public.txt");
    expect(result.completeness.sensitiveWithheld).toBeGreaterThan(0);
  });

  it("withholds both endpoints of a sensitive rename even when its safe old path is reused", () => {
    const root = repository(); const secret = "RENAME_SENTINEL\n".repeat(100);
    const base = commit(root, "public.txt", secret);
    git(root, "mv", "public.txt", ".env"); write(root, "public.txt", "safe replacement\n");
    git(root, "add", "-f", ".env", "public.txt"); git(root, "commit", "-m", "rename and reuse");
    const result = readGitComparison(root, { base, head: "HEAD" });
    expect(JSON.stringify(result)).not.toContain("RENAME_SENTINEL"); expect(result.diff).toBe("");
  });

  it("withholds a modified sensitive move when local configuration limits inexact rename detection", () => {
    const root = repository();
    const secret = Array.from({ length: 100 }, (_, index) => `LIMIT_SENTINEL_${index}=private value\n`).join("");
    commit(root, ".env", secret);
    const base = commit(root, "old-noise.txt", "old unrelated text\n".repeat(100));
    git(root, "config", "diff.renameLimit", "1");
    git(root, "rm", "-f", ".env", "old-noise.txt");
    write(root, "public.txt", secret.replace("private value", "edited value"));
    write(root, "new-noise.txt", "different unrelated data\n".repeat(100));
    git(root, "add", "public.txt", "new-noise.txt"); git(root, "commit", "-m", "modified sensitive move");
    const result = readGitComparison(root, { base, head: "HEAD" });
    expect(JSON.stringify(result)).not.toContain("LIMIT_SENTINEL");
    expect(result.diff).not.toContain("public.txt");
    expect(result.completeness.sensitiveWithheld).toBeGreaterThan(0);
    expect(JSON.stringify(readGitHistory(root))).not.toContain("LIMIT_SENTINEL");
  });

  it("keeps shallow parents from raw objects and never claims a complete range", () => {
    const source = repository(); commit(source, "hello.txt", "second\n");
    const shallow = makeTmpDir("shallow"); roots.push(shallow);
    git(shallow, "clone", "--depth=1", "--no-hardlinks", new URL(`file:///${source.replace(/\\/g, "/")}`).href, ".");
    const result = readGitHistory(shallow);
    expect(result.commits).toHaveLength(1); expect(result.commits[0].parents).toHaveLength(1);
    expect(result.completeness).toMatchObject({ shallow: true, commits: false, missingObjects: true });
  });

  it("rejects replaced history and inherited Git-directory overrides", () => {
    const root = repository(); const first = git(root, "rev-parse", "HEAD").trim();
    const second = commit(root, "hello.txt", "second\n");
    const previous = process.env.GIT_DIR;
    try { process.env.GIT_DIR = "nonexistent-forbidden-git-directory"; expect(readGitHistory(root).resolvedRef).toBe(second); }
    finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
    git(root, "replace", first, second);
    expect(() => readGitHistory(root)).toThrow("REPLACED_HISTORY_UNSUPPORTED");
  });

  it("bounds default history at 100 and maximum history at 200 with a truncation sentinel", () => {
    const root = repository(); let parent = git(root, "rev-parse", "HEAD").trim(); const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    for (let index = 0; index < 200; index++) parent = git(root, "commit-tree", tree, "-p", parent, "-m", `fixture ${index}`).trim();
    git(root, "update-ref", "refs/heads/main", parent);
    expect(readGitHistory(root)).toMatchObject({ truncated: true, commits: expect.any(Array) });
    const max = readGitHistory(root, { limit: 200 });
    expect(max.commits).toHaveLength(200); expect(max.truncated).toBe(true); expect(max.completeness.commits).toBe(false);
    expect(() => readGitHistory(root, { limit: 201 })).toThrow("INVALID_LIMIT");
  }, 180_000);

  it("rejects unavailable custom policy and hides unsupported symlink modes", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(root, ".c2cignore")); expect(() => readGitHistory(root)).toThrow("IGNORE_POLICY_UNAVAILABLE");
    fs.rmdirSync(path.join(root, ".c2cignore"));
    write(root, "target.txt", "target\n"); git(root, "add", "target.txt"); git(root, "commit", "-m", "target");
    const blob = git(root, "rev-parse", "HEAD:target.txt").trim();
    git(root, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    git(root, "commit", "-m", "symlink fixture");
    const comparison = readGitComparison(root, { base, head: "HEAD" });
    expect(comparison.completeness).toMatchObject({ safeDiff: false, unsupportedModes: 1 });
    expect(comparison.diff).not.toContain("b/link");
  });

  it("marks path inventories beyond 2000 incomplete and refuses a partial comparison patch", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    for (let index = 0; index < 2001; index++) write(root, `paths/${index}.txt`, `unique fixture ${index}\n`);
    git(root, "add", "paths"); git(root, "commit", "-m", "path cap fixture");
    const history = readGitHistory(root);
    expect(history.completeness.paths).toBe(false);
    expect(history.commits.flatMap((entry) => entry.changedPaths).length).toBeLessThanOrEqual(2000);
    expect(() => readGitComparison(root, { base, head: "HEAD" })).toThrow("PATH_INVENTORY_TRUNCATED");
  });

  it("returns all merge bases and distinguishes an unrelated range", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim(); const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    const left = git(root, "commit-tree", tree, "-p", base, "-m", "left").trim();
    const right = git(root, "commit-tree", tree, "-p", base, "-m", "right").trim();
    const leftMerge = git(root, "commit-tree", tree, "-p", left, "-p", right, "-m", "left merge").trim();
    const rightMerge = git(root, "commit-tree", tree, "-p", right, "-p", left, "-m", "right merge").trim();
    expect(readGitComparison(root, { base: leftMerge, head: rightMerge }).mergeBases.sort()).toEqual([left, right].sort());
    const orphan = git(root, "commit-tree", tree, "-m", "unrelated").trim();
    expect(readGitComparison(root, { base, head: orphan })).toMatchObject({ mergeBases: [], relation: "diverged", ancestryComplete: true });
  });

  it("refuses missing objects without fetching and never runs configured external diff or textconv", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    const head = commit(root, "hello.txt", "new content\n");
    const marker = path.join(root, "EXTERNAL_PROCESS_SENTINEL");
    const script = write(root, "forbidden.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const command = `"${process.execPath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"`;
    git(root, "config", "diff.external", command); git(root, "config", "diff.forbidden.textconv", command);
    write(root, ".gitattributes", "*.txt diff=forbidden\n");
    const before = snapshot(root);
    expect(readGitComparison(root, { base, head }).diff).toContain("new content");
    expect(fs.existsSync(marker)).toBe(false); expect(snapshot(root)).toEqual(before);
    const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
    const object = path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    expect(path.resolve(object).startsWith(path.resolve(root) + path.sep)).toBe(true);
    fs.unlinkSync(object);
    git(root, "config", "remote.forbidden.url", "https://attacker.invalid/no-network");
    git(root, "config", "remote.forbidden.promisor", "true");
    expect(() => readGitComparison(root, { base, head })).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("rejects continuation after a mutable ref changes and rejects unreadable policy encodings", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    commit(root, "large.txt", "first change\n".repeat(1000));
    const first = readGitComparison(root, { base, head: "HEAD", max_bytes: 1024 });
    commit(root, "large.txt", "second change\n".repeat(1000));
    expect(() => readGitComparison(root, { base, head: "HEAD", offset: first.nextOffset!, expected_evidence_id: first.evidenceId })).toThrow("EVIDENCE_CHANGED");
    fs.writeFileSync(path.join(root, ".c2cignore"), Buffer.from([0xff, 0xfe]));
    expect(() => readGitHistory(root)).toThrow("IGNORE_POLICY_UNAVAILABLE");
    fs.writeFileSync(path.join(root, ".c2cignore"), "x".repeat(262145));
    expect(() => readGitHistory(root)).toThrow("IGNORE_POLICY_UNAVAILABLE");
  });

  it("fails closed if custom policy bytes change while evidence is collected", () => {
    const root = repository(); const policy = write(root, ".c2cignore", "hidden.txt\n");
    const originalRead = fs.readSync; let changed = false;
    const intercepted = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(originalRead, fs, args) as number;
      if (!changed) { changed = true; fs.writeFileSync(policy, "hello.txt\n"); }
      return count;
    });
    try { expect(() => readGitHistory(root)).toThrow("IGNORE_POLICY_CHANGED"); }
    finally { intercepted.mockRestore(); }
  });

  it("refuses aggregate patches beyond 64 MiB without returning successful partial data", () => {
    const root = repository(); const base = git(root, "rev-parse", "HEAD").trim();
    const body = "diff fixture\n".repeat(Math.ceil((34 * 1024 * 1024) / 13));
    write(root, "large-a.txt", body); write(root, "large-b.txt", body);
    git(root, "add", "large-a.txt", "large-b.txt"); git(root, "commit", "-m", "aggregate bound fixture");
    expect(() => readGitComparison(root, { base, head: "HEAD" })).toThrow("DIFF_TOO_LARGE");
  }, 120_000);
});
