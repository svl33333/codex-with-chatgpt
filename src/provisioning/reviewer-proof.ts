import { createHash } from "node:crypto";

export const REVIEWER_PROOF_SCHEMA_VERSION = 1;

export interface ReviewerWorkspaceInfo {
  workspaceId: string;
  workspaceName?: string;
  rootAlias?: string;
  root?: string;
  repository?: string;
  git: {
    isRepo: boolean;
    branch: string | null;
    commit: string | null;
    dirty?: boolean;
  };
}

export interface ReviewerGitStatus {
  isRepo: boolean;
  branch: string | null;
  staged?: readonly unknown[];
  unstaged?: readonly unknown[];
  untracked?: readonly unknown[];
}

export interface ReviewerGitDiff {
  isRepo: boolean;
  mode: "unstaged" | "staged" | "head";
  diff: string;
  hasMore: boolean;
  /** Byte offset of this page in the complete diff. */
  offset: number;
  /** UTF-8 byte count returned in this page. */
  returnedBytes: number;
  /** UTF-8 byte count of the complete diff. */
  totalBytes: number;
  /** The next page offset, or null when the complete diff was returned. */
  nextOffset: number | null;
}

export interface ReviewerProofIdentity {
  workspaceId: string;
  connectorName: string;
  installationId?: string;
  repository: string;
  root: string;
  branch: string;
  head: string;
  readOnly: true;
}

export interface ReviewerProof {
  schemaVersion: typeof REVIEWER_PROOF_SCHEMA_VERSION;
  messageKey: string;
  appIdentity: {
    connectorName: string;
    installationId?: string;
    workspaceId: string;
  };
  capability: "read-only";
  repository: string;
  root: string;
  branch: string;
  head: string;
  workspaceInfo: ReviewerWorkspaceInfo;
  gitStatus: ReviewerGitStatus;
  gitDiff: ReviewerGitDiff;
  evidenceDigest: string;
  observedAt: string;
}

export interface ReviewerProofInput {
  messageKey: string;
  appIdentity: ReviewerProof["appIdentity"];
  capability: "read-only";
  repository: string;
  root: string;
  workspaceInfo: ReviewerWorkspaceInfo;
  gitStatus: ReviewerGitStatus;
  gitDiff: ReviewerGitDiff;
}

export type ReviewerProofValidation = { ok: true } | { ok: false; reason: string };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function digestEvidence(input: ReviewerProofInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        messageKey: input.messageKey,
        appIdentity: input.appIdentity,
        capability: input.capability,
        repository: input.repository,
        root: input.root,
        workspaceInfo: input.workspaceInfo,
        gitStatus: input.gitStatus,
        gitDiff: input.gitDiff,
      })
    )
    .digest("hex");
}

export function buildReviewerProof(input: ReviewerProofInput): ReviewerProof {
  if (!input.messageKey.trim()) throw new Error("reviewer proof requires a message key");
  if (input.capability !== "read-only") throw new Error("reviewer proof requires read-only capability");
  const head = input.workspaceInfo.git.commit;
  const branch = input.workspaceInfo.git.branch;
  if (!head || !branch) throw new Error("reviewer proof requires branch and full HEAD evidence");
  const proof: ReviewerProof = {
    schemaVersion: REVIEWER_PROOF_SCHEMA_VERSION,
    messageKey: input.messageKey.trim(),
    appIdentity: { ...input.appIdentity },
    capability: "read-only",
    repository: input.repository,
    root: input.root,
    branch,
    head,
    workspaceInfo: input.workspaceInfo,
    gitStatus: input.gitStatus,
    gitDiff: input.gitDiff,
    evidenceDigest: digestEvidence(input),
    observedAt: new Date().toISOString(),
  };
  const validation = validateReviewerProof(proof, {
    workspaceId: input.appIdentity.workspaceId,
    connectorName: input.appIdentity.connectorName,
    installationId: input.appIdentity.installationId,
    repository: input.repository,
    root: input.root,
    branch,
    head,
    readOnly: true,
  });
  if (!validation.ok) throw new Error(`invalid reviewer proof: ${validation.reason}`);
  return proof;
}

export function validateReviewerProof(
  proof: ReviewerProof | null | undefined,
  expected: ReviewerProofIdentity
): ReviewerProofValidation {
  if (!proof || proof.schemaVersion !== REVIEWER_PROOF_SCHEMA_VERSION) return { ok: false, reason: "proof_schema_mismatch" };
  if (!proof.messageKey.trim()) return { ok: false, reason: "message_key_missing" };
  if (proof.capability !== "read-only") return { ok: false, reason: "read_only_capability_missing" };
  if (proof.appIdentity.workspaceId !== expected.workspaceId) return { ok: false, reason: "workspace_mismatch" };
  if (proof.appIdentity.connectorName !== expected.connectorName) return { ok: false, reason: "connector_mismatch" };
  if (expected.installationId !== undefined && proof.appIdentity.installationId !== expected.installationId) {
    return { ok: false, reason: "installation_mismatch" };
  }
  if (proof.repository !== expected.repository) return { ok: false, reason: "repository_mismatch" };
  if (proof.root !== expected.root) return { ok: false, reason: "root_mismatch" };
  if (proof.branch !== expected.branch) return { ok: false, reason: "branch_mismatch" };
  if (proof.head !== expected.head || !/^[0-9a-f]{40}$/i.test(proof.head)) return { ok: false, reason: "head_mismatch" };
  if (proof.workspaceInfo.workspaceId !== expected.workspaceId) return { ok: false, reason: "workspace_info_mismatch" };
  if (proof.workspaceInfo.repository !== expected.repository) return { ok: false, reason: "workspace_info_repository_mismatch" };
  if (proof.workspaceInfo.root !== expected.root) return { ok: false, reason: "workspace_info_root_mismatch" };
  if (!proof.workspaceInfo.git.isRepo || proof.workspaceInfo.git.branch !== expected.branch || proof.workspaceInfo.git.commit !== expected.head || !/^[0-9a-f]{40}$/i.test(proof.workspaceInfo.git.commit)) {
    return { ok: false, reason: "workspace_info_git_mismatch" };
  }
  if (!proof.gitStatus.isRepo || proof.gitStatus.branch !== expected.branch) return { ok: false, reason: "git_status_mismatch" };
  if (
    !proof.gitDiff ||
    proof.gitDiff.isRepo !== true ||
    !proof.gitDiff.mode ||
    typeof proof.gitDiff.diff !== "string" ||
    proof.gitDiff.hasMore !== false ||
    !Number.isSafeInteger(proof.gitDiff.offset) ||
    proof.gitDiff.offset < 0 ||
    proof.gitDiff.offset !== 0 ||
    !Number.isSafeInteger(proof.gitDiff.returnedBytes) ||
    proof.gitDiff.returnedBytes < 0 ||
    !Number.isSafeInteger(proof.gitDiff.totalBytes) ||
    proof.gitDiff.totalBytes < 0 ||
    proof.gitDiff.returnedBytes !== proof.gitDiff.totalBytes ||
    proof.gitDiff.returnedBytes !== Buffer.byteLength(proof.gitDiff.diff, "utf8") ||
    proof.gitDiff.nextOffset !== null
  ) {
    return { ok: false, reason: "git_diff_missing" };
  }
  const expectedDigest = digestEvidence({
    messageKey: proof.messageKey,
    appIdentity: proof.appIdentity,
    capability: proof.capability,
    repository: proof.repository,
    root: proof.root,
    workspaceInfo: proof.workspaceInfo,
    gitStatus: proof.gitStatus,
    gitDiff: proof.gitDiff,
  });
  if (proof.evidenceDigest !== expectedDigest) return { ok: false, reason: "evidence_digest_mismatch" };
  return { ok: true };
}

export function isReviewerProofValid(proof: ReviewerProof | null | undefined, expected: ReviewerProofIdentity): boolean {
  return validateReviewerProof(proof, expected).ok;
}

/** Validate the proof's internal evidence and digest when the live binding is
 * not available to the caller. Production acceptance paths must additionally
 * pass the exact current workspace/connector identity to validateReviewerProof.
 */
export function validateReviewerProofIntegrity(proof: ReviewerProof | null | undefined): ReviewerProofValidation {
  if (!proof) return { ok: false, reason: "proof_missing" };
  return validateReviewerProof(proof, {
    workspaceId: proof.appIdentity.workspaceId,
    connectorName: proof.appIdentity.connectorName,
    installationId: proof.appIdentity.installationId,
    repository: proof.repository,
    root: proof.root,
    branch: proof.branch,
    head: proof.head,
    readOnly: true,
  });
}

export const verifyReviewerProof = validateReviewerProof;
