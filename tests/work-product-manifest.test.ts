import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Workspace } from "../src/workspace/manager.js";
import { listWorkProductManifest } from "../src/workspace/work-product-manifest.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanup(root); });
function createRepository() { const root = makeTmpDir("manifest"); roots.push(root); makeGitRepo(root); return root; }
function sha256(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function manifest(root: string, required: string[]) { return listWorkProductManifest(new Workspace(root), required); }

describe("bounded required work product manifest", () => {
  it("binds subtree-relative paths to both the workspace and actual Git worktree", () => {
    const root = createRepository(); const subtree = path.join(root, "src");
    const response = manifest(subtree, ["index.ts"]);
    expect(response.complete).toBe(true); expect(response.entries[0].head_blob).toBe(git(root, "rev-parse", "HEAD:src/index.ts").trim());
    const normalized = (file: string) => process.platform === "win32" || process.platform === "darwin" ? file.toLowerCase() : file;
    expect("identity" in response && response.identity).toMatchObject({ root: normalized(subtree), worktreeRoot: normalized(root) });
  });
  it("returns complete raw CRLF and distinct stage zero/worktree identities without changing the index", () => {
    const root = createRepository(); git(root, "config", "core.autocrlf", "false");
    write(root, "raw.txt", "base\r\n"); git(root, "add", "raw.txt"); git(root, "commit", "-m", "raw fixture");
    const headBlob = git(root, "rev-parse", "HEAD:raw.txt").trim();
    write(root, "raw.txt", "stage\r\n"); git(root, "add", "raw.txt"); write(root, "raw.txt", "worktree\r\n");
    const indexPath = path.join(root, ".git", "index"); const before = sha256(fs.readFileSync(indexPath));
    const response = manifest(root, ["raw.txt"]);
    expect(response).toMatchObject({ complete: true, terminal: true, requiredCount: 1, returnedCount: 1, entries: [{ path: "raw.txt", status: "staged_and_unstaged", head_blob: headBlob, index_digest: sha256("stage\r\n"), worktree_digest: sha256("worktree\r\n"), mode: "100644" }] });
    expect(sha256(fs.readFileSync(indexPath))).toBe(before);
  });
  it("covers deleted, untracked, rename endpoints and recreation after staged deletion", () => {
    const root = createRepository(); fs.unlinkSync(path.join(root, "hello.txt"));
    write(root, "untracked.txt", "untracked\n"); git(root, "mv", "src/index.ts", "src/renamed.ts");
    let response = manifest(root, ["hello.txt", "untracked.txt", "src/index.ts", "src/renamed.ts"]);
    expect(response.complete).toBe(true);
    expect(response.entries.map((entry) => [entry.path, entry.status])).toEqual([["hello.txt", "deleted"], ["untracked.txt", "untracked"], ["src/index.ts", "deleted"], ["src/renamed.ts", "staged"]]);
    git(root, "rm", "hello.txt"); write(root, "hello.txt", "recreated\n");
    response = manifest(root, ["hello.txt"]);
    expect(response.entries[0]).toMatchObject({ status: "staged_and_unstaged", index_digest: null, worktree_digest: sha256("recreated\n") });
  });
  it("reports each layer mode and detects staged mode changes", () => {
    const root = createRepository(); git(root, "update-index", "--chmod=+x", "hello.txt");
    const response = manifest(root, ["hello.txt"]);
    expect(response.complete).toBe(true); expect(response.entries[0].status).toMatch(/^staged/);
    expect("modes" in response && response.modes[0]).toMatchObject({ head: "100644", index: "100755", worktree: "100644" });
  });
  it.each([[], ["hello.txt", "hello.txt"], ["missing.txt"], ["../outside.txt"], ["/hello.txt"], ["C:/hello.txt"], [".git/config"], [".env"], ["src"], Array.from({ length: 257 }, (_, index) => `file${index}`)])("returns incomplete rather than accepting absent, denied, or invalid required coverage: %j", (required) => {
    const root = createRepository(); write(root, ".env", "SYNTHETIC_SECRET_SENTINEL");
    const response = manifest(root, required); expect(response.complete).toBe(false); expect(response.entries).toEqual([]); expect(JSON.stringify(response)).not.toContain("SYNTHETIC_SECRET_SENTINEL");
  });
  it("refuses oversize files and unsupported stage or symlink modes", () => {
    const root = createRepository(); write(root, "huge.txt", "x".repeat(1024 * 1024 + 1));
    expect(manifest(root, ["huge.txt"])).toMatchObject({ complete: false, errors: ["FILE_TOO_LARGE"] });
    const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
    git(root, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    expect(manifest(root, ["link"]).complete).toBe(false);
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD").trim()},gitlink`);
    expect(manifest(root, ["gitlink"]).complete).toBe(false);
  });
  it("rejects directory junction escapes including missing leaf paths", () => {
    const root = createRepository(); const outside = makeTmpDir("manifest-outside"); roots.push(outside); write(outside, "secret.txt", "SYNTHETIC_OUTSIDE_SENTINEL");
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(manifest(root, ["escape/secret.txt"]).complete).toBe(false); expect(manifest(root, ["escape/missing.txt"]).complete).toBe(false);
  });
  it("refuses conflict stages and unreadable policy without substituting default rules", () => {
    const root = createRepository(); git(root, "checkout", "-b", "side"); write(root, "hello.txt", "side\n"); git(root, "add", "hello.txt"); git(root, "commit", "-m", "side fixture");
    git(root, "checkout", "main"); write(root, "hello.txt", "main\n"); git(root, "add", "hello.txt"); git(root, "commit", "-m", "main fixture");
    expect(() => git(root, "merge", "side")).toThrow();
    expect(manifest(root, ["hello.txt"])).toMatchObject({ complete: false, errors: ["UNSUPPORTED_INDEX_STAGE_OR_MODE"] });
    const policy = write(root, ".c2cignore", "hidden.txt\n"); const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === policy) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
      return Reflect.apply(original, fs, args) as number;
    });
    expect(manifest(root, ["src/index.ts"])).toMatchObject({ complete: false, errors: ["IGNORE_POLICY_UNAVAILABLE"] });
  });
  it("uses fresh policy bytes while preserving the Workspace caller's existing rules", () => {
    const root = createRepository(); const workspace = new Workspace(root); write(root, ".c2cignore", "hello.txt\n");
    expect(workspace.ignoreRules.isSensitive("hello.txt")).toBe(false);
    expect(listWorkProductManifest(workspace, ["hello.txt"]).complete).toBe(false);
    fs.unlinkSync(path.join(root, ".c2cignore")); fs.mkdirSync(path.join(root, ".c2cignore"));
    expect(listWorkProductManifest(workspace, ["hello.txt"])).toMatchObject({ complete: false, errors: ["IGNORE_POLICY_UNAVAILABLE"] });
  });
  it.each(["content", "policy", "index", "head", "repository"])("refuses %s drift observed during collection", (layer) => {
    const root = createRepository(); write(root, ".c2cignore", "hidden.txt\n");
    const original = fs.readSync; let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (!changed && count > 0 && Buffer.isBuffer(args[1]) && args[1].subarray(0, count).toString("utf8").startsWith("Hello from Codex")) {
        changed = true;
        if (layer === "content") write(root, "hello.txt", "changed during capture\n");
        if (layer === "policy") write(root, ".c2cignore", "hello.txt\n");
        if (layer === "index") { write(root, "unrelated.txt", "new stage\n"); git(root, "add", "unrelated.txt"); }
        if (layer === "head") git(root, "commit", "--allow-empty", "-m", "drift fixture");
        if (layer === "repository") git(root, "remote", "add", "origin", "https://github.com/example/changed");
      }
      return count;
    });
    expect(manifest(root, ["hello.txt"]).complete).toBe(false);
  });
  it("refuses identity drift at the end of the second file observation", () => {
    const root = createRepository(); const original = fs.readSync; let observed = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (count > 0 && Buffer.isBuffer(args[1]) && args[1].subarray(0, count).toString("utf8").startsWith("Hello from Codex") && ++observed === 2) git(root, "commit", "--allow-empty", "-m", "late drift fixture");
      return count;
    });
    expect(manifest(root, ["hello.txt"])).toMatchObject({ complete: false, errors: ["MANIFEST_CHANGED"] });
  });
  it("does not run configured clean filters, external diff or fsmonitor while reading raw layers", () => {
    const root = createRepository(); const marker = path.join(root, "PROCESS_SENTINEL");
    const script = write(root, "forbidden.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
    const command = `"${process.execPath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"`;
    git(root, "config", "filter.forbidden.clean", command); git(root, "config", "filter.forbidden.smudge", command); git(root, "config", "core.fsmonitor", command); git(root, "config", "diff.external", command);
    write(root, ".gitattributes", "*.txt filter=forbidden\n");
    expect(manifest(root, ["hello.txt"]).complete).toBe(true); expect(fs.existsSync(marker)).toBe(false);
  });
  it("refuses a whole response beyond the output bound instead of returning truncated entries", () => {
    const root = createRepository();
    const required = Array.from({ length: 256 }, (_, index) => `${"a".repeat(100)}/${"b".repeat(100)}/${index}.txt`);
    for (const file of required) write(root, file, "bounded fixture\n");
    const response = manifest(root, required);
    expect(response).toMatchObject({ complete: false, returnedCount: 0, errors: ["MANIFEST_RESPONSE_TOO_LARGE"] });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(262144);
  }, 180_000);
});
