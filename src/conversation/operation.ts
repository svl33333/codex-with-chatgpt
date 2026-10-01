import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeAtomicSecureJson } from "../config/paths.js";

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
  /** Monotonic record generation checked while holding the operation lease. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

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

interface OperationLeaseRecord {
  leaseId: string;
  pid: number;
  acquiredAt: string;
}

function readOperationLease(file: string): OperationLeaseRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OperationLeaseRecord>;
    const pid = value.pid;
    if (typeof value.leaseId !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.acquiredAt !== "string") return null;
    return { leaseId: value.leaseId, pid, acquiredAt: value.acquiredAt };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeDeadOperationLease(file: string, expected: OperationLeaseRecord): void {
  const current = readOperationLease(file);
  if (!current || current.leaseId !== expected.leaseId) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Another owner may have released or replaced the lease.
  }
}

function withOperationLease<T>(key: string, action: () => T): T {
  const file = operationLockFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const leaseId = randomUUID();
  let descriptor: number | null = null;
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      acquired = true;
      fs.writeFileSync(descriptor, JSON.stringify({ leaseId, pid: process.pid, acquiredAt: new Date().toISOString() } satisfies OperationLeaseRecord), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = readOperationLease(file);
        const age = Date.now() - fs.statSync(file).mtimeMs;
        // An old lease is reclaimable only when its recorded owner is no
        // longer alive. Never delete a live owner's lock based on age alone.
        if (age > 30_000 && owner && !processIsAlive(owner.pid)) removeDeadOperationLease(file, owner);
      } catch {
        // A concurrent owner may have released the lease.
      }
    }
  }
  if (descriptor === null) throw new Error("GitHub operation is locked");
  try {
    return action();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    if (acquired) {
      try {
        const current = readOperationLease(file);
        if (current?.leaseId === leaseId) fs.rmSync(file, { force: true });
      } catch { /* stale lease recovery handles cleanup */ }
    }
  }
}

/** Persist one immutable target identity; a changed payload for its key fails closed. */
export function prepareGitHubOperation(target: GitHubOperationTarget, payloadHash: string): GitHubOperationRecord {
  const normalizedTarget = boundedTarget(target);
  if (!normalizedTarget.repository || !normalizedTarget.logicalOperationId || !payloadHash) throw new Error("GitHub operation identity is incomplete");
  const key = operationKey(normalizedTarget);
  return withOperationLease(key, () => {
    const file = operationFile(key);
    const existing = readJsonIfExists<GitHubOperationRecord>(file);
    if (existing) {
      if (
        existing.schemaVersion !== 1 ||
        existing.operationKey !== key ||
        !Number.isSafeInteger(existing.generation) ||
        existing.generation < 0 ||
        existing.payloadHash !== payloadHash ||
        !sameTarget(existing.target, normalizedTarget)
      ) {
        throw new Error("GitHub operation key already has a different payload or target");
      }
      // Use the persisted generation as a compare-and-swap guard even when
      // this call only rehydrates an already-prepared logical operation.
      const observedGeneration = existing.generation;
      const current = readJsonIfExists<GitHubOperationRecord>(file);
      if (!current || current.generation !== observedGeneration || current.operationKey !== key) {
        throw new Error("GitHub operation generation changed during preparation");
      }
      const next: GitHubOperationRecord = {
        ...existing,
        generation: observedGeneration + 1,
        updatedAt: new Date().toISOString(),
      };
      writeAtomicSecureJson(file, next);
      const committed = readJsonIfExists<GitHubOperationRecord>(file);
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
  return readJsonIfExists<GitHubOperationRecord>(operationFile(operationKeyValue));
}
