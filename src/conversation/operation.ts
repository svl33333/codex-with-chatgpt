import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, writeAtomicSecureJson } from "../config/paths.js";
import { withLease } from "../config/lease.js";
import { readStrictJsonFile } from "../config/strict-json.js";

export type GitHubOperationKind =
  | "issue_create"
  | "issue_update"
  | "push"
  | "pr_create"
  | "pr_update"
  | "review"
  | "publication";

export type OperationEvidenceOutcome = "accepted" | "definite_not_accepted" | "ambiguous";

export interface GitHubOperationTarget {
  kind: GitHubOperationKind;
  repository: string;
  /** Workflow-issued identity; effect/proof fields are deliberately excluded from operationKey. */
  logicalOperationId: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  ref?: string;
  expectedCommit?: string;
  expectedContentHash?: string;
  expectedRevision?: string;
  headRef?: string;
  baseRef?: string;
  marker?: string;
}

export interface GitHubOperationEvidence {
  outcome: OperationEvidenceOutcome;
  target: GitHubOperationTarget;
  payloadHash: string;
  remoteId?: string;
  remoteUrl?: string;
  observedRepository?: string;
  observedIssueNumber?: number;
  observedPullRequestNumber?: number;
  observedCommit?: string;
  observedRef?: string;
  observedHeadRef?: string;
  observedBaseRef?: string;
  observedPayloadHash?: string;
  observedRevision?: string;
  observedMarker?: string;
  candidateCount?: number;
  reason?: string;
}

export interface GitHubOperationObservation {
  target: GitHubOperationTarget;
  payloadHash: string;
  remoteId?: string;
  remoteUrl?: string;
  observedRepository?: string;
  observedIssueNumber?: number;
  observedPullRequestNumber?: number;
  observedCommit?: string;
  observedRef?: string;
  observedHeadRef?: string;
  observedBaseRef?: string;
  observedPayloadHash?: string;
  observedRevision?: string;
  observedMarker?: string;
  candidateCount?: number;
  absenceProven?: boolean;
}

export interface GitHubOperationRecord {
  schemaVersion: 1;
  operationKey: string;
  target: GitHubOperationTarget;
  payloadHash: string;
  /** Policy-owned discriminator used only by A1 reconciliation. */
  reconciliationPath?: "local_persisted" | "provider_bound";
  /** Monotonic record generation checked while holding the operation lease. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

const OPERATION_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const operationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationKey: z.string().min(1),
  target: z.object({
    kind: z.enum(["issue_create", "issue_update", "push", "pr_create", "pr_update", "review", "publication"]),
    repository: z.string().min(1),
    logicalOperationId: z.string().min(1),
    issueNumber: z.number().int().positive().safe().optional(),
    pullRequestNumber: z.number().int().positive().safe().optional(),
    ref: z.string().optional(),
    expectedCommit: z.string().optional(),
    expectedContentHash: z.string().optional(),
    expectedRevision: z.string().optional(),
    headRef: z.string().optional(),
    baseRef: z.string().optional(),
    marker: z.string().optional(),
  }).passthrough(),
  payloadHash: z.string().min(1),
  reconciliationPath: z.enum(["local_persisted", "provider_bound"]).optional(),
  generation: z.number().int().nonnegative().safe(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();

function bounded(value: string | undefined, max = 256): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/[\r\n]+/g, " ");
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameTarget(left: GitHubOperationTarget, right: GitHubOperationTarget): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

export function operationKey(target: GitHubOperationTarget, _payloadHash?: string): string {
  // Expected effect/proof fields are deliberately excluded: a changed payload
  // or expected commit must collide on the same workflow-issued operation key
  // and fail closed at prepareGitHubOperation.
  const identity = {
    kind: target.kind,
    repository: target.repository,
    logicalOperationId: target.logicalOperationId,
  };
  return createHash("sha256").update(stableSerialize(identity)).digest("hex").slice(0, 32);
}

/** Validate the minimum exact remote proof for one GitHub operation kind. */
export function reconcileGitHubOperation(input: GitHubOperationObservation): GitHubOperationEvidence {
  const target = input.target;
  const candidateCount = input.candidateCount;
  const common = {
    target,
    payloadHash: bounded(input.payloadHash, 128) ?? "",
    ...(bounded(input.remoteId) ? { remoteId: bounded(input.remoteId) } : {}),
    ...(bounded(input.remoteUrl) ? { remoteUrl: bounded(input.remoteUrl) } : {}),
    ...(bounded(input.observedRepository, 256) ? { observedRepository: bounded(input.observedRepository, 256) } : {}),
    ...(typeof input.observedIssueNumber === "number" ? { observedIssueNumber: input.observedIssueNumber } : {}),
    ...(typeof input.observedPullRequestNumber === "number" ? { observedPullRequestNumber: input.observedPullRequestNumber } : {}),
    ...(bounded(input.observedCommit) ? { observedCommit: bounded(input.observedCommit, 128) } : {}),
    ...(bounded(input.observedRef) ? { observedRef: bounded(input.observedRef, 256) } : {}),
    ...(bounded(input.observedHeadRef) ? { observedHeadRef: bounded(input.observedHeadRef, 256) } : {}),
    ...(bounded(input.observedBaseRef) ? { observedBaseRef: bounded(input.observedBaseRef, 256) } : {}),
    ...(bounded(input.observedPayloadHash) ? { observedPayloadHash: bounded(input.observedPayloadHash, 128) } : {}),
    ...(bounded(input.observedRevision) ? { observedRevision: bounded(input.observedRevision, 128) } : {}),
    ...(bounded(input.observedMarker) ? { observedMarker: bounded(input.observedMarker) } : {}),
    ...(candidateCount === undefined ? {} : { candidateCount }),
  } satisfies Omit<GitHubOperationEvidence, "outcome">;
  if (!target.repository || !target.logicalOperationId || !input.payloadHash) return { ...common, outcome: "ambiguous", reason: "operation identity is incomplete" };
  if (candidateCount !== undefined && (candidateCount < 0 || candidateCount > 1)) {
    return { ...common, outcome: "ambiguous", reason: "remote candidate count is not unique" };
  }
  switch (target.kind) {
    case "issue_create":
      return input.remoteId && input.remoteUrl && input.observedRepository === target.repository && (candidateCount === undefined || candidateCount === 1) &&
        ((target.expectedContentHash && input.observedPayloadHash === target.expectedContentHash) ||
          (target.marker && input.observedMarker === target.marker))
        ? { ...common, outcome: "accepted" }
        : input.absenceProven && candidateCount === 0 && input.observedRepository === target.repository
          ? { ...common, outcome: "definite_not_accepted", reason: "authoritative remote query found no matching Issue" }
          : { ...common, outcome: "ambiguous", reason: "Issue identity query did not prove acceptance or definite absence" };
    case "issue_update":
      return typeof target.issueNumber === "number" && input.observedRepository === target.repository && input.observedIssueNumber === target.issueNumber &&
        ((target.expectedRevision && input.observedRevision === target.expectedRevision) ||
          (target.expectedContentHash && input.observedPayloadHash === target.expectedContentHash) ||
          (target.marker && input.observedMarker === target.marker))
        ? { ...common, outcome: "accepted" }
        : { ...common, outcome: "ambiguous", reason: "Issue revision or marker proof is missing" };
    case "push":
      return target.ref && target.expectedCommit && input.observedRepository === target.repository && input.observedRef === target.ref && input.observedCommit === target.expectedCommit
        ? { ...common, outcome: "accepted" }
        : { ...common, outcome: "ambiguous", reason: "remote ref and expected commit are not both proven" };
    case "pr_create":
      return target.headRef && target.baseRef && target.expectedCommit && input.observedRepository === target.repository &&
        input.observedHeadRef === target.headRef && input.observedBaseRef === target.baseRef &&
        input.observedCommit === target.expectedCommit && input.remoteId && input.remoteUrl
        ? { ...common, outcome: "accepted" }
        : { ...common, outcome: "ambiguous", reason: "PR head/base/commit and unique identity are not all proven" };
    case "pr_update":
    case "review":
    case "publication":
      return (typeof target.pullRequestNumber === "number" || typeof target.issueNumber === "number") &&
        input.observedRepository === target.repository &&
        (target.pullRequestNumber === undefined || input.observedPullRequestNumber === target.pullRequestNumber) &&
        (target.issueNumber === undefined || input.observedIssueNumber === target.issueNumber) &&
        ((target.expectedRevision && input.observedRevision === target.expectedRevision) ||
          (target.expectedContentHash && input.observedPayloadHash === target.expectedContentHash) ||
          (target.marker && input.observedMarker === target.marker))
        ? { ...common, outcome: "accepted" }
        : { ...common, outcome: "ambiguous", reason: "target revision or durable marker proof is missing" };
  }
}

export function operationTargetsMatch(left: GitHubOperationTarget, right: GitHubOperationTarget): boolean {
  return sameTarget(left, right);
}

function boundedTarget(target: GitHubOperationTarget): GitHubOperationTarget {
  return {
    kind: target.kind,
    repository: bounded(target.repository, 256) ?? "",
    logicalOperationId: bounded(target.logicalOperationId, 256) ?? "",
    ...(typeof target.issueNumber === "number" ? { issueNumber: target.issueNumber } : {}),
    ...(typeof target.pullRequestNumber === "number" ? { pullRequestNumber: target.pullRequestNumber } : {}),
    ...(bounded(target.ref) ? { ref: bounded(target.ref) } : {}),
    ...(bounded(target.expectedCommit, 128) ? { expectedCommit: bounded(target.expectedCommit, 128) } : {}),
    ...(bounded(target.expectedContentHash, 128) ? { expectedContentHash: bounded(target.expectedContentHash, 128) } : {}),
    ...(bounded(target.expectedRevision, 128) ? { expectedRevision: bounded(target.expectedRevision, 128) } : {}),
    ...(bounded(target.headRef) ? { headRef: bounded(target.headRef) } : {}),
    ...(bounded(target.baseRef) ? { baseRef: bounded(target.baseRef) } : {}),
    ...(bounded(target.marker) ? { marker: bounded(target.marker) } : {}),
  };
}

function operationFile(key: string): string {
  return path.join(getStateDir(), "transport", "operations", `${key}.json`);
}

function operationLockFile(key: string): string {
  return path.join(getStateDir(), "transport", "operations", ".locks", `${key}.lock`);
}

function withOperationLease<T>(key: string, action: () => T): T {
  return withLease(operationLockFile(key), action);
}

/** Persist one immutable target identity; a changed payload for its key fails closed. */
export function prepareGitHubOperation(target: GitHubOperationTarget, payloadHash: string): GitHubOperationRecord {
  const normalizedTarget = boundedTarget(target);
  if (!normalizedTarget.repository || !normalizedTarget.logicalOperationId || !payloadHash) throw new Error("GitHub operation identity is incomplete");
  const key = operationKey(normalizedTarget);
  return withOperationLease(key, () => {
    const file = operationFile(key);
    const existing = readGitHubOperation(key);
    if (existing) {
      if (
        existing.payloadHash !== payloadHash ||
        !sameTarget(existing.target, normalizedTarget)
      ) {
        throw new Error("GitHub operation key already has a different payload or target");
      }
      // Use the persisted generation as a compare-and-swap guard even when
      // this call only rehydrates an already-prepared logical operation.
      const observedGeneration = existing.generation;
      if (observedGeneration === Number.MAX_SAFE_INTEGER) throw new Error("GitHub operation generation is exhausted");
      const current = readGitHubOperation(key);
      if (!current || current.generation !== observedGeneration || current.payloadHash !== payloadHash || !sameTarget(current.target, normalizedTarget)) {
        throw new Error("GitHub operation generation changed during preparation");
      }
      const next: GitHubOperationRecord = {
        ...existing,
        generation: observedGeneration + 1,
        updatedAt: new Date().toISOString(),
      };
      writeAtomicSecureJson(file, next);
      const committed = readGitHubOperation(key);
      if (!committed || committed.generation !== next.generation || committed.payloadHash !== payloadHash || !sameTarget(committed.target, normalizedTarget)) {
        throw new Error("GitHub operation generation CAS failed");
      }
      return committed;
    }
    const timestamp = new Date().toISOString();
    const record: GitHubOperationRecord = {
      schemaVersion: 1,
      operationKey: key,
      target: normalizedTarget,
      payloadHash,
      generation: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeAtomicSecureJson(file, record);
    return record;
  });
}

export function readGitHubOperation(operationKeyValue: string): GitHubOperationRecord | null {
  if (!OPERATION_KEY_PATTERN.test(operationKeyValue)) throw new Error("GitHub operation key is invalid");
  const result = readStrictJsonFile<unknown>(operationFile(operationKeyValue));
  if (result.status === "MISSING") return null;
  if (result.status !== "OK") throw new Error(`GitHub operation record is ${result.status.toLowerCase()}`);
  const parsed = operationRecordSchema.safeParse(result.value);
  if (!parsed.success || parsed.data.operationKey !== operationKeyValue || operationKey(parsed.data.target) !== operationKeyValue) {
    throw new Error("GitHub operation record identity or schema is invalid");
  }
  return parsed.data;
}

/**
 * Read-only projection for the A1 known-operation route.  It deliberately
 * aliases the existing persisted lookup and never creates or mutates an
 * operation record.
 */
export function readKnownLogicalOperation(operationKeyValue: string): GitHubOperationRecord | null {
  if (!OPERATION_KEY_PATTERN.test(operationKeyValue)) return null;
  return readGitHubOperation(operationKeyValue);
}
