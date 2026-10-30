import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { operationKey, prepareGitHubOperation, reconcileGitHubOperation } from "../src/conversation/operation.js";
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
