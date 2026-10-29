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
async function manifest(root: string, required: string[]) { return (await listWorkProductManifest(new Workspace(root), required)); }

function afterFileRead(action: (descriptor: number, bytes: Buffer, count: number) => void) {
  const original = fs.read;
  const intercepted = (descriptor: number, bytes: Buffer, offset: number, length: number, position: number | null,
    callback: (error: NodeJS.ErrnoException | null, count: number, buffer: Buffer) => void) => {
    original(descriptor, bytes, offset, length, position, (error, count, buffer) => {
      if (!error) action(descriptor, buffer, count);
      callback(error, count, buffer);
    });
  };
  vi.spyOn(fs, "read").mockImplementation(intercepted as typeof fs.read);
}

describe("bounded required work product manifest", () => {
  it("binds subtree-relative paths to both the workspace and actual Git worktree", async () => {
    const root = createRepository(); const subtree = path.join(root, "src");
    const response = (await manifest(subtree, ["index.ts"]));
    expect(response.complete).toBe(true); expect(response.entries[0].head_blob).toBe(git(root, "rev-parse", "HEAD:src/index.ts").trim());
    const normalized = (file: string) => process.platform === "win32" || process.platform === "darwin" ? file.toLowerCase() : file;
    expect("identity" in response && response.identity).toMatchObject({ root: normalized(subtree), worktreeRoot: normalized(root) });
  });
  it("returns complete raw CRLF and distinct stage zero/worktree identities without changing the index", async () => {
    const root = createRepository(); git(root, "config", "core.autocrlf", "false");
    write(root, "raw.txt", "base\r\n"); git(root, "add", "raw.txt"); git(root, "commit", "-m", "raw fixture");
    const headBlob = git(root, "rev-parse", "HEAD:raw.txt").trim();
    write(root, "raw.txt", "stage\r\n"); git(root, "add", "raw.txt"); write(root, "raw.txt", "worktree\r\n");
    const indexPath = path.join(root, ".git", "index"); const before = sha256(fs.readFileSync(indexPath));
    const response = (await manifest(root, ["raw.txt"]));
    expect(response).toMatchObject({ complete: true, terminal: true, requiredCount: 1, returnedCount: 1, entries: [{ path: "raw.txt", status: "staged_and_unstaged", head_blob: headBlob, index_digest: sha256("stage\r\n"), worktree_digest: sha256("worktree\r\n"), mode: "100644" }] });
    expect(sha256(fs.readFileSync(indexPath))).toBe(before);
  });
  it("covers deleted, untracked, rename endpoints and recreation after staged deletion", async () => {
    const root = createRepository(); fs.unlinkSync(path.join(root, "hello.txt"));
    write(root, "untracked.txt", "untracked\n"); git(root, "mv", "src/index.ts", "src/renamed.ts");
    let response = (await manifest(root, ["hello.txt", "untracked.txt", "src/index.ts", "src/renamed.ts"]));
    expect(response.complete).toBe(true);
    expect(response.entries.map((entry) => [entry.path, entry.status])).toEqual([["hello.txt", "deleted"], ["untracked.txt", "untracked"], ["src/index.ts", "deleted"], ["src/renamed.ts", "staged"]]);
    git(root, "rm", "hello.txt"); write(root, "hello.txt", "recreated\n");
    response = (await manifest(root, ["hello.txt"]));
    expect(response.entries[0]).toMatchObject({ status: "staged_and_unstaged", index_digest: null, worktree_digest: sha256("recreated\n") });
  });
  it("reports each layer mode and detects staged mode changes", async () => {
    const root = createRepository(); git(root, "update-index", "--chmod=+x", "hello.txt");
    const response = (await manifest(root, ["hello.txt"]));
    expect(response.complete).toBe(true); expect(response.entries[0].status).toMatch(/^staged/);
    expect("modes" in response && response.modes[0]).toMatchObject({ head: "100644", index: "100755", worktree: "100644" });
  });
  it.each([[], ["hello.txt", "hello.txt"], ["missing.txt"], ["../outside.txt"], ["/hello.txt"], ["C:/hello.txt"], [".git/config"], [".env"], ["src"], Array.from({ length: 257 }, (_, index) => `file${index}`)])("returns incomplete rather than accepting absent, denied, or invalid required coverage: %j", async (required) => {
    const root = createRepository(); write(root, ".env", "SYNTHETIC_SECRET_SENTINEL");
    const response = (await manifest(root, required)); expect(response.complete).toBe(false); expect(response.entries).toEqual([]); expect(JSON.stringify(response)).not.toContain("SYNTHETIC_SECRET_SENTINEL");
  });
  it("refuses oversize files and unsupported stage or symlink modes", async () => {
    const root = createRepository(); write(root, "huge.txt", ""); fs.truncateSync(path.join(root, "huge.txt"), 64 * 1024 * 1024 + 1);
    expect((await manifest(root, ["huge.txt"]))).toMatchObject({ complete: false, errors: ["FILE_TOO_LARGE"] });
    const blob = git(root, "rev-parse", "HEAD:hello.txt").trim();
    git(root, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    expect((await manifest(root, ["link"])).complete).toBe(false);
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD").trim()},gitlink`);
    expect((await manifest(root, ["gitlink"])).complete).toBe(false);
  });
  it("rejects directory junction escapes including missing leaf paths", async () => {
    const root = createRepository(); const outside = makeTmpDir("manifest-outside"); roots.push(outside); write(outside, "secret.txt", "SYNTHETIC_OUTSIDE_SENTINEL");
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect((await manifest(root, ["escape/secret.txt"])).complete).toBe(false); expect((await manifest(root, ["escape/missing.txt"])).complete).toBe(false);
  });
  it("refuses conflict stages and unreadable policy without substituting default rules", async () => {
    const root = createRepository(); git(root, "checkout", "-b", "side"); write(root, "hello.txt", "side\n"); git(root, "add", "hello.txt"); git(root, "commit", "-m", "side fixture");
    git(root, "checkout", "main"); write(root, "hello.txt", "main\n"); git(root, "add", "hello.txt"); git(root, "commit", "-m", "main fixture");
    expect(() => git(root, "merge", "side")).toThrow();
    expect((await manifest(root, ["hello.txt"]))).toMatchObject({ complete: false, errors: ["UNSUPPORTED_INDEX_STAGE_OR_MODE"] });
    const policy = write(root, ".c2cignore", "hidden.txt\n"); const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === policy) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
      return Reflect.apply(original, fs, args) as number;
    });
    expect((await manifest(root, ["src/index.ts"]))).toMatchObject({ complete: false, errors: ["IGNORE_POLICY_UNAVAILABLE"] });
  });
  it("uses fresh policy bytes while preserving the Workspace caller's existing rules", async () => {
    const root = createRepository(); const workspace = new Workspace(root); write(root, ".c2cignore", "hello.txt\n");
    expect(workspace.ignoreRules.isSensitive("hello.txt")).toBe(false);
    expect((await listWorkProductManifest(workspace, ["hello.txt"])).complete).toBe(false);
    fs.unlinkSync(path.join(root, ".c2cignore")); fs.mkdirSync(path.join(root, ".c2cignore"));
    expect((await listWorkProductManifest(workspace, ["hello.txt"]))).toMatchObject({ complete: false, errors: ["IGNORE_POLICY_UNAVAILABLE"] });
  });
  it.each(["content", "policy", "index", "head", "repository"])("refuses %s drift observed during collection", async (layer) => {
    const root = createRepository(); write(root, ".c2cignore", "hidden.txt\n");
    let changed = false;
    afterFileRead((_descriptor, bytes, count) => {
      if (!changed && count > 0 && bytes.subarray(0, count).toString("utf8").startsWith("Hello from Codex")) {
        changed = true;
        if (layer === "content") write(root, "hello.txt", "changed during capture\n");
        if (layer === "policy") write(root, ".c2cignore", "hello.txt\n");
        if (layer === "index") { write(root, "unrelated.txt", "new stage\n"); git(root, "add", "unrelated.txt"); }
        if (layer === "head") git(root, "commit", "--allow-empty", "-m", "drift fixture");
        if (layer === "repository") git(root, "remote", "add", "origin", "https://github.com/example/changed");
      }
    });
    expect((await manifest(root, ["hello.txt"])).complete).toBe(false);
  });
  it("refuses identity drift at the end of the second file observation", async () => {
    const root = createRepository(); let observed = 0;
    afterFileRead((_descriptor, bytes, count) => {
      if (count > 0 && bytes.subarray(0, count).toString("utf8").startsWith("Hello from Codex") && ++observed === 2) git(root, "commit", "--allow-empty", "-m", "late drift fixture");
    });
    expect((await manifest(root, ["hello.txt"]))).toMatchObject({ complete: false, errors: ["MANIFEST_CHANGED"] });
  });
  it("does not run configured clean filters, external diff or fsmonitor while reading raw layers", async () => {
    const root = createRepository(); const marker = path.join(root, "PROCESS_SENTINEL");
    const script = write(root, "forbidden.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
    const command = `"${process.execPath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"`;
    git(root, "config", "filter.forbidden.clean", command); git(root, "config", "filter.forbidden.smudge", command); git(root, "config", "core.fsmonitor", command); git(root, "config", "diff.external", command);
    write(root, ".gitattributes", "*.txt filter=forbidden\n");
    expect((await manifest(root, ["hello.txt"])).complete).toBe(true); expect(fs.existsSync(marker)).toBe(false);
  });
  it("refuses a whole response beyond the output bound instead of returning truncated entries", async () => {
    const root = createRepository();
    const required = Array.from({ length: 256 }, (_, index) => `${"a".repeat(100)}/${"b".repeat(100)}/${index}.txt`);
    for (const file of required) write(root, file, "bounded fixture\n");
    const response = (await manifest(root, required));
    expect(response).toMatchObject({ complete: false, returnedCount: 0, errors: ["MANIFEST_RESPONSE_TOO_LARGE"] });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(262144);
  }, 180_000);

  it("hashes the three refused artifact sizes without whole-file buffers or body transfer", async () => {
    const root = createRepository();
    const required = ["built.js", "package.tgz", "installed.js"];
    const sizes = [6_755_678, 1_739_135, 6_755_678];
    const expected = sizes.map((size, index) => {
      const bytes = Buffer.alloc(size, index === 1 ? 0xff : 0x61);
      fs.writeFileSync(path.join(root, required[index]), bytes);
      return sha256(bytes);
    });
    const indexPath = path.join(root, ".git", "index");
    const indexBefore = fs.readFileSync(indexPath);
    const beforeHead = git(root, "rev-parse", "HEAD");
    const allocated: number[] = [];
    const originalAllocate = Buffer.alloc;
    vi.spyOn(Buffer, "alloc").mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      allocated.push(args[0]); return Reflect.apply(originalAllocate, Buffer, args);
    });
    let readBytes = 0;
    const started = performance.now();
    const response = await listWorkProductManifest(new Workspace(root), required, { onBytes(count) { readBytes += count; } });
    const elapsedMs = performance.now() - started;
    expect(response).toMatchObject({ complete: true, returnedCount: 3 });
    expect(response.entries.map((entry) => entry.worktree_digest)).toEqual(expected);
    expect(response.entries.every((entry) => entry.index_digest === null)).toBe(true);
    expect(readBytes).toBe(2 * sizes.reduce((total, size) => total + size, 0) + 3 * indexBefore.length);
    expect(Math.max(...allocated)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(response).length).toBeLessThan(10_000);
    expect(fs.readFileSync(indexPath)).toEqual(indexBefore);
    expect(git(root, "rev-parse", "HEAD")).toBe(beforeHead);
    console.info(JSON.stringify({ fixture: "three-artifact-sizes", readBytes, elapsedMs, maximumBufferAllocation: Math.max(...allocated) }));
  }, 60_000);

  it("streams distinct large binary index and worktree layers without normalization", async () => {
    const root = createRepository(); git(root, "config", "core.autocrlf", "false");
    const staged = Buffer.alloc(2 * 1024 * 1024, 0xff); staged.write("stage\r\n");
    const working = Buffer.alloc(2 * 1024 * 1024, 0x80); working.write("worktree\r\n");
    fs.writeFileSync(path.join(root, "large.bin"), staged); git(root, "add", "large.bin");
    fs.writeFileSync(path.join(root, "large.bin"), working);
    const response = await manifest(root, ["large.bin"]);
    expect(response.entries[0]).toMatchObject({ status: "staged_and_unstaged", index_digest: sha256(staged), worktree_digest: sha256(working) });
  });

  it("accepts the 64 MiB boundary and refuses an aggregate above 512 MiB before reading the excess file", async () => {
    const root = createRepository();
    const bytes = Buffer.alloc(64 * 1024 * 1024);
    const first = path.join(root, "large0.bin"); fs.writeFileSync(first, bytes);
    const boundary = await manifest(root, ["large0.bin"]);
    expect(boundary).toMatchObject({ complete: true });
    expect(boundary.entries[0].worktree_digest).toBe(sha256(bytes));
    const required = Array.from({ length: 8 }, (_, index) => `large${index}.bin`);
    for (const name of required.slice(1, -1)) fs.linkSync(first, path.join(root, name));
    const last = path.join(root, required.at(-1)!); fs.writeFileSync(last, ""); fs.truncateSync(last, bytes.length - required.length);
    expect(await manifest(root, required)).toMatchObject({ complete: true, returnedCount: 8 });
    write(root, "excess.bin", "x"); required.push("excess.bin");
    let readBytes = 0;
    const response = await listWorkProductManifest(new Workspace(root), required, { onBytes(count) { readBytes += count; } });
    expect(response).toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_IO_LIMIT"] });
    expect(readBytes).toBe(512 * 1024 * 1024 - 8 + fs.statSync(path.join(root, ".git", "index")).size);
  }, 60_000);

  it.each(["truncate", "grow", "replace"])("refuses a %s during asynchronous reading and closes the descriptor", async (mutation) => {
    const root = createRepository(); const file = path.join(root, "changing.bin");
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x7e));
    const originalOpen = fs.openSync; let targetDescriptor: number | undefined; let changed = false;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = Reflect.apply(originalOpen, fs, args) as number;
      if (args[0] === file) targetDescriptor = descriptor;
      return descriptor;
    });
    afterFileRead((descriptor, _bytes, count) => {
      if (descriptor !== targetDescriptor || changed || !count) return;
      changed = true;
      if (mutation === "truncate") fs.truncateSync(file, 1);
      if (mutation === "grow") fs.appendFileSync(file, "extra");
      if (mutation === "replace") { fs.renameSync(file, file + ".old"); fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x7e)); }
    });
    expect(await manifest(root, ["changing.bin"])).toMatchObject({ complete: false, entries: [], errors: ["FILE_CHANGED"] });
    expect(changed).toBe(true);
    expect(() => fs.fstatSync(targetDescriptor!)).toThrow();
  });

  it("cancels mid-read, returns no digest, and closes the open file", async () => {
    const root = createRepository(); const file = path.join(root, "cancel.bin");
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 0x7e));
    const controller = new AbortController(); let targetDescriptor: number | undefined;
    const originalOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = Reflect.apply(originalOpen, fs, args) as number;
      if (args[0] === file) targetDescriptor = descriptor;
      return descriptor;
    });
    afterFileRead((descriptor, _bytes, count) => { if (descriptor === targetDescriptor && count) controller.abort(); });
    let readBytes = 0;
    expect(await listWorkProductManifest(new Workspace(root), ["cancel.bin"], { signal: controller.signal, onBytes(count) { readBytes += count; } }))
      .toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_CANCELLED"] });
    expect(readBytes).toBe(fs.statSync(path.join(root, ".git", "index")).size + 64 * 1024);
    expect(() => fs.fstatSync(targetDescriptor!)).toThrow();
  });

  it.each(["hello.txt", ".git/index"])("refuses a same-byte %s replacement after the first read has closed", async (relative) => {
    const root = createRepository(); const file = path.join(root, relative);
    const comparablePath = (value: string) => process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
    const originalState = fs.statSync(file); const originalOpen = fs.openSync; const originalClose = fs.closeSync;
    let descriptor: number | undefined; let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const opened = Reflect.apply(originalOpen, fs, args) as number;
      if (typeof args[0] === "string" && comparablePath(args[0]) === comparablePath(file)) descriptor = opened;
      return opened;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((closing) => {
      originalClose(closing);
      if (closing === descriptor && !replaced) {
        replaced = true; fs.renameSync(file, file + ".old"); fs.copyFileSync(file + ".old", file);
        fs.chmodSync(file, originalState.mode & 0o777); fs.utimesSync(file, originalState.atime, originalState.mtime);
      }
    });
    expect(await manifest(root, ["hello.txt"])).toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_CHANGED"] });
    expect(replaced).toBe(true);
  });

  it("expires during asynchronous reading and closes the descriptor without returning a digest", async () => {
    const root = createRepository(); const file = path.join(root, "deadline.bin");
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
    const deadline = performance.now() + 60_000; const originalNow = performance.now.bind(performance);
    let expired = false; let descriptor: number | undefined; const originalOpen = fs.openSync;
    vi.spyOn(performance, "now").mockImplementation(() => expired ? deadline + 1 : originalNow());
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const opened = Reflect.apply(originalOpen, fs, args) as number;
      if (args[0] === file) descriptor = opened; return opened;
    });
    afterFileRead((reading, _bytes, count) => { if (reading === descriptor && count) expired = true; });
    let readBytes = 0;
    expect(await listWorkProductManifest(new Workspace(root), ["deadline.bin"], { deadline, onBytes(count) { readBytes += count; } }))
      .toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_TIMEOUT"] });
    expect(readBytes).toBe(fs.statSync(path.join(root, ".git", "index")).size + 64 * 1024);
    expect(expired).toBe(true); expect(() => fs.fstatSync(descriptor!)).toThrow();
  });

  it("closes the descriptor and refuses partial entries on an asynchronous file I/O error", async () => {
    const root = createRepository(); const file = write(root, "io-error.bin", "fixture bytes");
    const originalOpen = fs.openSync; const originalRead = fs.read; let descriptor: number | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const opened = Reflect.apply(originalOpen, fs, args) as number;
      if (args[0] === file) descriptor = opened; return opened;
    });
    vi.spyOn(fs, "read").mockImplementation(((...args: unknown[]) => {
      if (args[0] !== descriptor) return Reflect.apply(originalRead, fs, args);
      const callback = args[5] as (error: NodeJS.ErrnoException, count: number, buffer: Buffer) => void;
      queueMicrotask(() => callback(Object.assign(new Error("fixture I/O failure"), { code: "EIO" }), 0, args[1] as Buffer));
    }) as typeof fs.read);
    expect(await manifest(root, ["io-error.bin"])).toMatchObject({ complete: false, entries: [], errors: ["FILE_UNAVAILABLE"] });
    expect(() => fs.fstatSync(descriptor!)).toThrow();
  });

  it("refuses already cancelled and expired requests before reading evidence", async () => {
    const root = createRepository(); const workspace = new Workspace(root);
    const controller = new AbortController(); controller.abort();
    expect(await listWorkProductManifest(workspace, ["hello.txt"], { signal: controller.signal }))
      .toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_CANCELLED"] });
    expect(await listWorkProductManifest(workspace, ["hello.txt"], { deadline: performance.now() - 1 }))
      .toMatchObject({ complete: false, entries: [], errors: ["MANIFEST_TIMEOUT"] });
  });
});
