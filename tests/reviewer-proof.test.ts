import { describe, expect, it } from "vitest";
import { buildReviewerProof, validateReviewerProof, validateReviewerProofIntegrity } from "../src/provisioning/reviewer-proof.js";

const base = {
  messageKey: "task:iteration:message",
  appIdentity: { workspaceId: "workspace-c", connectorName: "connector-c", installationId: "install-c" },
  capability: "read-only" as const,
  repository: "svl33333/codex-with-chatgpt",
  root: "C:/work/codex-with-chatgpt",
  workspaceInfo: {
    workspaceId: "workspace-c",
    workspaceName: "codex-with-chatgpt",
    rootAlias: "workspace:/",
    root: "C:/work/codex-with-chatgpt",
    repository: "svl33333/codex-with-chatgpt",
    git: { isRepo: true, branch: "requirements/full-auto-c2c-provisioning-revision", commit: "c".repeat(40), dirty: true },
  },
  gitStatus: { isRepo: true, branch: "requirements/full-auto-c2c-provisioning-revision", staged: [], unstaged: [], untracked: [".harness/"] },
  gitDiff: { isRepo: true, mode: "unstaged" as const, diff: "" },
};

describe("structured read-only reviewer proof", () => {
  it("requires the exact app, workspace, full HEAD and diff evidence", () => {
    const proof = buildReviewerProof(base);
    expect(validateReviewerProof(proof, {
      ...base.appIdentity,
      repository: base.repository,
      root: base.root,
      branch: base.workspaceInfo.git.branch!,
      head: base.workspaceInfo.git.commit!,
      readOnly: true,
    })).toEqual({ ok: true });
  });

  it("fails closed on a current-HEAD mismatch", () => {
    const proof = buildReviewerProof(base);
    expect(validateReviewerProof(proof, {
      ...base.appIdentity,
      repository: base.repository,
      root: base.root,
      branch: base.workspaceInfo.git.branch!,
      head: "d".repeat(40),
      readOnly: true,
    })).toMatchObject({ ok: false, reason: "head_mismatch" });
  });

  it("fails closed when machine-observed repository/root or diff pagination is incomplete", () => {
    const proof = buildReviewerProof(base);
    expect(validateReviewerProof({
      ...proof,
      workspaceInfo: { ...proof.workspaceInfo, repository: "https://wrong.example/repo" },
    }, {
      ...base.appIdentity,
      repository: base.repository,
      root: base.root,
      branch: base.workspaceInfo.git.branch!,
      head: base.workspaceInfo.git.commit!,
      readOnly: true,
    })).toMatchObject({ ok: false, reason: "workspace_info_repository_mismatch" });

    expect(validateReviewerProof({
      ...proof,
      gitDiff: { ...proof.gitDiff, hasMore: true },
    }, {
      ...base.appIdentity,
      repository: base.repository,
      root: base.root,
      branch: base.workspaceInfo.git.branch!,
      head: base.workspaceInfo.git.commit!,
      readOnly: true,
    })).toMatchObject({ ok: false, reason: "git_diff_missing" });
  });

  it("rejects a tampered evidence digest", () => {
    const proof = buildReviewerProof(base);
    expect(validateReviewerProofIntegrity({ ...proof, evidenceDigest: "0".repeat(64) }))
      .toMatchObject({ ok: false, reason: "evidence_digest_mismatch" });
  });
});
