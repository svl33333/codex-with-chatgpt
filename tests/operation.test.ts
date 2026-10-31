import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { operationKey, prepareGitHubOperation, readGitHubOperation, reconcileGitHubOperation, type GitHubOperationRecord } from "../src/conversation/operation.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("operation-specific GitHub reconciliation", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = isolateStateDir();
  });
  afterEach(() => cleanup(stateDir));

  it("accepts only exact push evidence", () => {
    const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "push-main", ref: "refs/heads/main", expectedCommit: "abc123" };
    expect(reconcileGitHubOperation({ target, payloadHash: "payload", observedRepository: target.repository, observedRef: "refs/heads/main", observedCommit: "abc123" }).outcome).toBe("accepted");
    expect(reconcileGitHubOperation({ target, payloadHash: "payload", observedRepository: target.repository, observedRef: "refs/heads/main", observedCommit: "different" }).outcome).toBe("ambiguous");
  });

  it("keeps multiple PR candidates ambiguous and rejects a changed payload for one key", () => {
    const target = { kind: "pr_create" as const, repository: "https://github.com/example/repo", logicalOperationId: "pr-a0", headRef: "feature/a0", baseRef: "main", expectedCommit: "abc123" };
    expect(reconcileGitHubOperation({ target, payloadHash: "payload", remoteId: "1", remoteUrl: "https://github.com/example/repo/pull/1", observedRepository: target.repository, observedHeadRef: "feature/a0", observedBaseRef: "main", observedCommit: "abc123", candidateCount: 2 }).outcome).toBe("ambiguous");
    expect(operationKey(target, "payload")).toBe(operationKey(target, "different-payload"));
    expect(operationKey(target, "payload")).toBe(operationKey({ ...target, expectedCommit: "different-commit" }, "payload"));
    expect(operationKey(target, "payload")).toBe(operationKey({ ...target, ref: "refs/heads/other" }, "payload"));
    prepareGitHubOperation(target, "payload");
    expect(prepareGitHubOperation(target, "payload").generation).toBe(1);
    expect(() => prepareGitHubOperation(target, "different-payload")).toThrow(/different payload/);
    expect(() => prepareGitHubOperation({ ...target, expectedCommit: "different-commit" }, "payload")).toThrow(/different payload or target/);
    expect(() => prepareGitHubOperation({ ...target, ref: "refs/heads/other" }, "payload")).toThrow(/different payload or target/);
  });

  it("requires positive proof for Issue, PR, review, and publication operations", () => {
    const payloadHash = "payload-hash";
    expect(
      reconcileGitHubOperation({
        target: { kind: "issue_create", repository: "https://github.com/example/repo", logicalOperationId: "issue-new", expectedContentHash: "content-hash" },
        payloadHash,
        remoteId: "7",
        remoteUrl: "https://github.com/example/repo/issues/7",
        observedRepository: "https://github.com/example/repo",
        observedPayloadHash: "content-hash",
        candidateCount: 1,
      }).outcome
    ).toBe("accepted");
    expect(
      reconcileGitHubOperation({
        target: { kind: "issue_create", repository: "https://github.com/example/repo", logicalOperationId: "issue-new", expectedContentHash: "content-hash" },
        payloadHash,
        candidateCount: 0,
        observedRepository: "https://github.com/example/repo",
        absenceProven: true,
      }).outcome
    ).toBe("definite_not_accepted");
    expect(
      reconcileGitHubOperation({
        target: { kind: "issue_create", repository: "https://github.com/example/repo", logicalOperationId: "issue-new", expectedContentHash: "content-hash" },
        payloadHash,
      }).outcome
    ).toBe("ambiguous");
    expect(
      reconcileGitHubOperation({
        target: { kind: "issue_update", repository: "https://github.com/example/repo", logicalOperationId: "issue-update-6", issueNumber: 6, expectedRevision: "revision-6" },
        payloadHash,
        observedRepository: "https://github.com/example/repo",
        observedIssueNumber: 6,
        observedRevision: "revision-6",
      }).outcome
    ).toBe("accepted");
    expect(
      reconcileGitHubOperation({
        target: { kind: "pr_create", repository: "https://github.com/example/repo", logicalOperationId: "pr-create-a0", headRef: "feature/a0", baseRef: "main", expectedCommit: "abc123" },
        payloadHash,
        remoteId: "4",
        remoteUrl: "https://github.com/example/repo/pull/4",
        observedRepository: "https://github.com/example/repo",
        observedHeadRef: "feature/a0",
        observedBaseRef: "main",
        observedCommit: "abc123",
        candidateCount: 1,
      }).outcome
    ).toBe("accepted");
    for (const kind of ["pr_update", "review", "publication"] as const) {
      expect(
        reconcileGitHubOperation({
          target: { kind, repository: "https://github.com/example/repo", logicalOperationId: `${kind}-4`, pullRequestNumber: 4, marker: "c2c-marker" },
          payloadHash,
          observedRepository: "https://github.com/example/repo",
          observedPullRequestNumber: 4,
          observedMarker: "c2c-marker",
        }).outcome
      ).toBe("accepted");
    }
  });

  it("does not reclaim a stale-age lease while its recorded owner is alive", () => {
    const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "live-owner", ref: "refs/heads/main", expectedCommit: "abc123" };
    const key = operationKey(target);
    const lock = path.join(stateDir, "transport", "operations", ".locks", `${key}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ leaseId: "live-owner-lease", pid: process.pid, acquiredAt: new Date(0).toISOString() }));
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => prepareGitHubOperation(target, "payload")).toThrow(/locked/);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock, { force: true });
  });

  it("fails closed when competing processes prepare the same logical operation with conflicting payload/effect", () => {
    const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "competing-process", ref: "refs/heads/main", expectedCommit: "abc123" };
    const script = `import { prepareGitHubOperation } from './src/conversation/operation.ts';\nconst target = JSON.parse(process.env.C2C_TARGET);\ntry { prepareGitHubOperation(target, process.env.C2C_PAYLOAD); process.exit(0); } catch { process.exit(2); }`;
    const env = { ...process.env, C2C_STATE_DIR: stateDir, C2C_TARGET: JSON.stringify(target), C2C_PAYLOAD: "payload-a" };
    const first = spawnSync(process.execPath, ["--import", "tsx/esm", "-e", script], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });
    if (first.status !== 0 && /uv_os_get_passwd|ENOMEM/.test(first.stderr ?? "")) return;
    expect(first.status).toBe(0);
    const second = spawnSync(process.execPath, ["--import", "tsx/esm", "-e", script], {
      cwd: process.cwd(),
      env: { ...env, C2C_TARGET: JSON.stringify({ ...target, expectedCommit: "different-commit" }), C2C_PAYLOAD: "payload-b" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(second.status).toBe(2);
  });
});

describe("persisted operation records", () => {
  let stateDir: string;
  const target = { kind: "push" as const, repository: "https://github.com/example/repo", logicalOperationId: "persisted-operation", ref: "refs/heads/main", expectedCommit: "before" };
  const key = operationKey(target);
  const file = () => path.join(stateDir, "transport", "operations", `${key}.json`);
  beforeEach(() => { stateDir = isolateStateDir(); });
  afterEach(() => { vi.restoreAllMocks(); cleanup(stateDir); });

  it.each([
    ["malformed JSON", () => '{"schemaVersion":1,'],
    ["empty bytes", () => ""],
    ["null", () => "null"],
    ["duplicate keys", () => '{"schemaVersion":1,"schemaVersion":2}'],
    ["unknown schema", (record: GitHubOperationRecord) => JSON.stringify({ ...record, schemaVersion: 2 })],
    ["wrong key", (record: GitHubOperationRecord) => JSON.stringify({ ...record, operationKey: "other" })],
    ["missing target", (record: GitHubOperationRecord) => JSON.stringify({ ...record, target: null })],
    ["misbound target", (record: GitHubOperationRecord) => JSON.stringify({ ...record, target: { ...record.target, logicalOperationId: "other" } })],
    ["invalid generation", (record: GitHubOperationRecord) => JSON.stringify({ ...record, generation: "0" })],
    ["invalid payload", (record: GitHubOperationRecord) => JSON.stringify({ ...record, payloadHash: null })],
  ] as const)("preserves %s and refuses a replacement operation before caller effects", (_name, corrupt) => {
    const record = prepareGitHubOperation(target, "original-payload");
    const raw = Buffer.from(corrupt(record));
    fs.writeFileSync(file(), raw);
    expect.soft(() => readGitHubOperation(key)).toThrow();
    const authorize = vi.fn();
    const submit = vi.fn();
    let refused = false;
    try {
      prepareGitHubOperation({ ...target, expectedCommit: "replacement" }, "replacement-payload");
      authorize();
      submit();
    } catch { refused = true; }
    expect.soft(fs.readFileSync(file())).toEqual(raw);
    expect.soft(authorize).not.toHaveBeenCalled();
    expect.soft(submit).not.toHaveBeenCalled();
    expect(refused).toBe(true);
  });

  it("preserves an unreadable operation and reports failure to readers and preparers", () => {
    prepareGitHubOperation(target, "original-payload");
    const raw = fs.readFileSync(file());
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (String(args[0]) === file()) throw Object.assign(new Error("synthetic denied operation read"), { code: "EACCES" });
      return Reflect.apply(read, fs, args);
    });
    expect.soft(() => readGitHubOperation(key)).toThrow();
    expect.soft(() => prepareGitHubOperation({ ...target, expectedCommit: "replacement" }, "replacement-payload")).toThrow();
    vi.restoreAllMocks();
    expect(fs.readFileSync(file())).toEqual(raw);
  });

  it("preserves a target changed at the generation check", () => {
    const record = prepareGitHubOperation(target, "original-payload");
    const changed = Buffer.from(JSON.stringify({ ...record, target: { ...record.target, expectedCommit: "other-writer" } }));
    const read = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (String(args[0]) === file() && ++reads === 2) fs.writeFileSync(file(), changed);
      return Reflect.apply(read, fs, args);
    });
    expect.soft(() => prepareGitHubOperation(target, "original-payload")).toThrow();
    vi.restoreAllMocks();
    expect(fs.readFileSync(file())).toEqual(changed);
  });

  it("refuses generation exhaustion without rewriting the record", () => {
    const record = prepareGitHubOperation(target, "original-payload");
    const raw = Buffer.from(JSON.stringify({ ...record, generation: Number.MAX_SAFE_INTEGER }));
    fs.writeFileSync(file(), raw);
    expect.soft(() => prepareGitHubOperation(target, "original-payload")).toThrow();
    expect(fs.readFileSync(file())).toEqual(raw);
  });

  it("creates only missing records and recovers valid legacy records with their optional fields intact", () => {
    expect(readGitHubOperation(key)).toBeNull();
    const created = prepareGitHubOperation(target, "original-payload");
    expect(created.generation).toBe(0);
    fs.writeFileSync(file(), JSON.stringify({ ...created, reconciliationPath: "local_persisted", legacyExtension: "retained" }));
    const recovered = prepareGitHubOperation(target, "original-payload");
    expect(recovered).toMatchObject({ target: created.target, payloadHash: created.payloadHash, createdAt: created.createdAt, generation: 1, reconciliationPath: "local_persisted", legacyExtension: "retained" });
    expect(readGitHubOperation(key)).toEqual(recovered);
  });
});
