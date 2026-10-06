import { createHash } from "node:crypto";

export const JANITOR_SCHEMA_VERSION = 1 as const;
export const JANITOR_RESOURCE_KINDS = ["project", "plugin", "custom_mcp", "connector"] as const;
export type JanitorResourceKind = (typeof JANITOR_RESOURCE_KINDS)[number];
export const JANITOR_DECISIONS = ["keep", "delete", "unknown"] as const;
export type JanitorDecision = (typeof JANITOR_DECISIONS)[number];

export type JanitorCapabilityStatus = "available" | "unsupported" | "route_drift" | "ambiguous" | "unauthenticated";

/** Metadata deliberately excludes URLs, page content, credentials, and tokens. */
export interface JanitorSafeMetadata {
  name?: string;
  workspaceId?: string;
  connectorName?: string;
  endpointFingerprint?: string;
  projectId?: string;
}
export interface JanitorResourceIdentity {
  stableId: string;
  kind: JanitorResourceKind;
  metadata: JanitorSafeMetadata;
}

export interface JanitorResourceObservation extends JanitorResourceIdentity {
  capability: JanitorCapabilityStatus;
  protected?: boolean;
  protectionReason?: string;
  classification?: "active" | "unknown" | "ambiguous";
  reason?: string;
}

export interface ExactProtectionReference {
  kind: JanitorResourceKind;
  stableId: string;
  source: string;
  reason: string;
}

export interface ProtectionIndex {
  exact: readonly ExactProtectionReference[];
  legacy: readonly string[];
}

export interface JanitorInventorySnapshot {
  schemaVersion: typeof JANITOR_SCHEMA_VERSION;
  inventoryId: string;
  accountFingerprint: string;
  createdAt: string;
  resources: JanitorResourceObservation[];
  diagnostics: string[];
}

export interface JanitorPlanEntry {
  stableId: string;
  kind: JanitorResourceKind;
  metadata: JanitorSafeMetadata;
  action: JanitorDecision;
  protected: boolean;
  protectionReason?: string;
  classification: "active" | "unknown" | "ambiguous";
  reason: string;
}

export interface JanitorCleanupPlan {
  schemaVersion: typeof JANITOR_SCHEMA_VERSION;
  inventoryId: string;
  accountFingerprint: string;
  createdAt: string;
  entries: JanitorPlanEntry[];
  digest?: string;
}

export type JanitorTargetStatus =
  | "removed"
  | "already_absent"
  | "skipped_protected"
  | "skipped_drift"
  | "skipped_ambiguous"
  | "unsupported"
  | "account_mismatch"
  | "failed";

export interface JanitorTargetOutcome {
  stableId: string;
  kind: JanitorResourceKind;
  status: JanitorTargetStatus;
  reason: string;
}

export interface JanitorApplyResult {
  schemaVersion: typeof JANITOR_SCHEMA_VERSION;
  planDigest: string;
  inventoryId: string;
  startedAt: string;
  completedAt: string;
  outcomes: JanitorTargetOutcome[];
}

export interface JanitorRescanTarget {
  stableId: string;
  kind: JanitorResourceKind;
  plannedAction: JanitorDecision;
  observed: boolean;
  status: JanitorTargetStatus | "still_present" | "not_observed";
  reason: string;
}

export interface JanitorRescanSummary {
  repeatSafe: boolean;
  targets: JanitorRescanTarget[];
}

const SAFE_METADATA_KEYS = new Set(["name", "workspaceId", "connectorName", "endpointFingerprint", "projectId"]);
const PLAN_KEYS = new Set(["schemaVersion", "inventoryId", "accountFingerprint", "createdAt", "entries", "digest"]);
const ENTRY_KEYS = new Set(["stableId", "kind", "metadata", "action", "protected", "protectionReason", "classification", "reason"]);
const INVENTORY_KEYS = new Set(["schemaVersion", "inventoryId", "accountFingerprint", "createdAt", "resources", "diagnostics"]);
const RESOURCE_KEYS = new Set(["stableId", "kind", "metadata", "capability", "protected", "protectionReason", "classification", "reason"]);
const RESULT_KEYS = new Set(["schemaVersion", "planDigest", "inventoryId", "startedAt", "completedAt", "outcomes"]);
const OUTCOME_KEYS = new Set(["stableId", "kind", "status", "reason"]);
const CAPABILITIES: JanitorCapabilityStatus[] = ["available", "unsupported", "route_drift", "ambiguous", "unauthenticated"];
const TARGET_STATUSES: JanitorTargetStatus[] = ["removed", "already_absent", "skipped_protected", "skipped_drift", "skipped_ambiguous", "unsupported", "account_mismatch", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`JANITOR_INVALID_PLAN: ${field} must be a non-empty string`);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`JANITOR_INVALID_PLAN: unknown ${label} field '${key}'`);
  }
}

function normalizeMetadata(value: unknown): JanitorSafeMetadata {
  if (!isRecord(value)) throw new Error("JANITOR_INVALID_PLAN: metadata must be an object");
  assertAllowedKeys(value, SAFE_METADATA_KEYS, "metadata");
  const result: JanitorSafeMetadata = {};
  for (const key of SAFE_METADATA_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined) {
      assertNonEmpty(candidate, `metadata.${key}`);
      result[key as keyof JanitorSafeMetadata] = candidate;
    }
  }
  return result;
}

function normalizeKind(value: unknown): JanitorResourceKind {
  if (typeof value !== "string" || !JANITOR_RESOURCE_KINDS.includes(value as JanitorResourceKind)) {
    throw new Error(`JANITOR_INVALID_PLAN: unsupported resource kind '${String(value)}'`);
  }
  return value as JanitorResourceKind;
}

/** Sort object keys recursively so whitespace and insertion order never alter a digest. */
export function canonicalizeJanitorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJanitorValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJanitorValue(value[key])])
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJanitorValue(value));
}

export function planAuthorizationPayload(plan: JanitorCleanupPlan): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    inventoryId: plan.inventoryId,
    accountFingerprint: plan.accountFingerprint,
    entries: plan.entries.map((entry) => ({
      stableId: entry.stableId,
      kind: entry.kind,
      metadata: entry.metadata,
      action: entry.action,
    })),
  };
}

export function calculatePlanDigest(plan: JanitorCleanupPlan): string {
  return createHash("sha256").update(canonicalJson(planAuthorizationPayload(plan)), "utf8").digest("hex");
}

export function assertPlanDigest(plan: JanitorCleanupPlan, expectedDigest: string): void {
  if (!/^[0-9a-f]{64}$/i.test(expectedDigest) || calculatePlanDigest(plan) !== expectedDigest.toLowerCase()) {
    throw new Error("JANITOR_PLAN_DIGEST_MISMATCH: edited or stale plan");
  }
}

export function buildProtectionIndex(
  exact: readonly ExactProtectionReference[],
  legacy: readonly string[] = []
): ProtectionIndex {
  const seen = new Set<string>();
  const normalized: ExactProtectionReference[] = [];
  for (const reference of exact) {
    const kind = normalizeKind(reference.kind);
    assertNonEmpty(reference.stableId, "protection.stableId");
    const key = `${kind}\0${reference.stableId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind, stableId: reference.stableId, source: reference.source, reason: reference.reason });
  }
  return { exact: normalized.sort((left, right) => `${left.kind}\0${left.stableId}`.localeCompare(`${right.kind}\0${right.stableId}`)), legacy: [...legacy] };
}

function protectionFor(index: ProtectionIndex, kind: JanitorResourceKind, stableId: string): ExactProtectionReference | undefined {
  return index.exact.find((reference) => reference.kind === kind && reference.stableId === stableId);
}

/** Normalize observations and make duplicate/conflicting observations non-destructive. */
export function normalizeInventory(
  observations: readonly JanitorResourceObservation[],
  input: { inventoryId: string; accountFingerprint: string; createdAt?: string; protection: ProtectionIndex }
): JanitorInventorySnapshot {
  assertNonEmpty(input.inventoryId, "inventoryId");
  assertNonEmpty(input.accountFingerprint, "accountFingerprint");
  const byKey = new Map<string, JanitorResourceObservation>();
  const diagnostics: string[] = [];
  for (const observation of observations) {
    const kind = normalizeKind(observation.kind);
    assertNonEmpty(observation.stableId, "stableId");
    const metadata = normalizeMetadata(observation.metadata);
    const key = `${kind}\0${observation.stableId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (canonicalJson(existing.metadata) !== canonicalJson(metadata) || existing.capability !== observation.capability) {
        byKey.set(key, {
          ...existing,
          metadata: {},
          capability: "ambiguous",
          classification: "ambiguous",
          reason: "conflicting observations for the same exact resource",
        });
        diagnostics.push(`ambiguous:${kind}:${observation.stableId}`);
      }
      continue;
    }
    const protection = protectionFor(input.protection, kind, observation.stableId);
    byKey.set(key, {
      stableId: observation.stableId,
      kind,
      metadata,
      capability: observation.capability,
      protected: Boolean(protection),
      ...(protection ? { protectionReason: protection.reason } : {}),
      classification: observation.classification ?? (observation.capability === "ambiguous" ? "ambiguous" : "unknown"),
      reason: observation.reason,
    });
  }
  const resources = [...byKey.values()].sort((left, right) => `${left.kind}\0${left.stableId}`.localeCompare(`${right.kind}\0${right.stableId}`));
  return {
    schemaVersion: JANITOR_SCHEMA_VERSION,
    inventoryId: input.inventoryId,
    accountFingerprint: input.accountFingerprint,
    createdAt: input.createdAt ?? new Date().toISOString(),
    resources,
    diagnostics,
  };
}

export function buildCleanupPlan(snapshot: JanitorInventorySnapshot): JanitorCleanupPlan {
  const entries = snapshot.resources.map((resource) => {
    const protectedResource = resource.protected === true;
    const ambiguous = resource.classification === "ambiguous" || resource.capability === "ambiguous";
    return {
      stableId: resource.stableId,
      kind: resource.kind,
      metadata: resource.metadata,
      action: protectedResource ? "keep" : "unknown",
      protected: protectedResource,
      ...(resource.protectionReason ? { protectionReason: resource.protectionReason } : {}),
      classification: ambiguous ? "ambiguous" : resource.classification ?? "unknown",
      reason: resource.reason ?? (protectedResource ? resource.protectionReason ?? "exact protection reference" : ambiguous ? "ambiguous observation" : "requires human review"),
    } satisfies JanitorPlanEntry;
  });
  const plan: JanitorCleanupPlan = {
    schemaVersion: JANITOR_SCHEMA_VERSION,
    inventoryId: snapshot.inventoryId,
    accountFingerprint: snapshot.accountFingerprint,
    createdAt: new Date().toISOString(),
    entries,
  };
  return { ...plan, digest: calculatePlanDigest(plan) };
}

export function parseCleanupPlan(value: unknown): JanitorCleanupPlan {
  if (!isRecord(value)) throw new Error("JANITOR_INVALID_PLAN: plan must be an object");
  assertAllowedKeys(value, PLAN_KEYS, "plan");
  if (value.schemaVersion !== JANITOR_SCHEMA_VERSION) throw new Error("JANITOR_INVALID_PLAN: unsupported schema version");
  assertNonEmpty(value.inventoryId, "inventoryId");
  assertNonEmpty(value.accountFingerprint, "accountFingerprint");
  assertNonEmpty(value.createdAt, "createdAt");
  if (!Array.isArray(value.entries)) throw new Error("JANITOR_INVALID_PLAN: entries must be an array");
  const seen = new Set<string>();
  const entries = value.entries.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`JANITOR_INVALID_PLAN: entry ${index} must be an object`);
    assertAllowedKeys(raw, ENTRY_KEYS, `entry ${index}`);
    assertNonEmpty(raw.stableId, `entry ${index}.stableId`);
    const kind = normalizeKind(raw.kind);
    const key = `${kind}\0${raw.stableId}`;
    if (seen.has(key)) throw new Error(`JANITOR_INVALID_PLAN: duplicate entry ${kind}:${raw.stableId}`);
    seen.add(key);
    if (!JANITOR_DECISIONS.includes(raw.action as JanitorDecision)) throw new Error(`JANITOR_INVALID_PLAN: invalid action at entry ${index}`);
    if (typeof raw.protected !== "boolean") throw new Error(`JANITOR_INVALID_PLAN: protected must be boolean at entry ${index}`);
    if (!(["active", "unknown", "ambiguous"] as const).includes(raw.classification as "active" | "unknown" | "ambiguous")) {
      throw new Error(`JANITOR_INVALID_PLAN: invalid classification at entry ${index}`);
    }
    assertNonEmpty(raw.reason, `entry ${index}.reason`);
    const metadata = normalizeMetadata(raw.metadata);
    if (raw.protected && raw.action !== "keep") throw new Error(`JANITOR_INVALID_PLAN: protected entry ${index} must be keep`);
    if (raw.protected === false && raw.action === "keep" && raw.protectionReason) throw new Error(`JANITOR_INVALID_PLAN: unprotected entry ${index} has protection reason`);
    return {
      stableId: raw.stableId,
      kind,
      metadata,
      action: raw.action as JanitorDecision,
      protected: raw.protected,
      ...(typeof raw.protectionReason === "string" ? { protectionReason: raw.protectionReason } : {}),
      classification: raw.classification as JanitorPlanEntry["classification"],
      reason: raw.reason,
    } satisfies JanitorPlanEntry;
  });
  const plan: JanitorCleanupPlan = {
    schemaVersion: JANITOR_SCHEMA_VERSION,
    inventoryId: value.inventoryId,
    accountFingerprint: value.accountFingerprint,
    createdAt: value.createdAt,
    entries,
    ...(typeof value.digest === "string" ? { digest: value.digest.toLowerCase() } : {}),
  };
  if (plan.digest !== undefined && !/^[0-9a-f]{64}$/i.test(plan.digest)) {
    throw new Error("JANITOR_INVALID_PLAN: digest must be a SHA-256 hex string");
  }
  return plan;
}

export function parseInventorySnapshot(value: unknown): JanitorInventorySnapshot {
  if (!isRecord(value)) throw new Error("JANITOR_STATE_MALFORMED: inventory");
  assertAllowedKeys(value, INVENTORY_KEYS, "inventory");
  if (value.schemaVersion !== JANITOR_SCHEMA_VERSION) throw new Error("JANITOR_STATE_MALFORMED: inventory schema");
  assertNonEmpty(value.inventoryId, "inventoryId");
  assertNonEmpty(value.accountFingerprint, "accountFingerprint");
  assertNonEmpty(value.createdAt, "createdAt");
  if (!Array.isArray(value.resources) || !Array.isArray(value.diagnostics) || value.diagnostics.some((item) => typeof item !== "string")) {
    throw new Error("JANITOR_STATE_MALFORMED: inventory collections");
  }
  const resources = value.resources.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`JANITOR_STATE_MALFORMED: inventory resource ${index}`);
    assertAllowedKeys(raw, RESOURCE_KEYS, `inventory resource ${index}`);
    assertNonEmpty(raw.stableId, `inventory resource ${index}.stableId`);
    const kind = normalizeKind(raw.kind);
    const metadata = normalizeMetadata(raw.metadata);
    if (typeof raw.capability !== "string" || !CAPABILITIES.includes(raw.capability as JanitorCapabilityStatus)) throw new Error(`JANITOR_STATE_MALFORMED: inventory resource ${index}.capability`);
    if (raw.protected !== undefined && typeof raw.protected !== "boolean") throw new Error(`JANITOR_STATE_MALFORMED: inventory resource ${index}.protected`);
    if (raw.protectionReason !== undefined) assertNonEmpty(raw.protectionReason, `inventory resource ${index}.protectionReason`);
    if (raw.classification !== undefined && !(["active", "unknown", "ambiguous"] as const).includes(raw.classification as "active" | "unknown" | "ambiguous")) throw new Error(`JANITOR_STATE_MALFORMED: inventory resource ${index}.classification`);
    if (raw.reason !== undefined) assertNonEmpty(raw.reason, `inventory resource ${index}.reason`);
    return {
      stableId: raw.stableId,
      kind,
      metadata,
      capability: raw.capability as JanitorCapabilityStatus,
      ...(typeof raw.protected === "boolean" ? { protected: raw.protected } : {}),
      ...(typeof raw.protectionReason === "string" ? { protectionReason: raw.protectionReason } : {}),
      ...(typeof raw.classification === "string" ? { classification: raw.classification as JanitorResourceObservation["classification"] } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    } satisfies JanitorResourceObservation;
  });
  return { schemaVersion: JANITOR_SCHEMA_VERSION, inventoryId: value.inventoryId, accountFingerprint: value.accountFingerprint, createdAt: value.createdAt, resources, diagnostics: [...value.diagnostics] };
}

export function parseApplyResult(value: unknown): JanitorApplyResult {
  if (!isRecord(value)) throw new Error("JANITOR_STATE_MALFORMED: apply result");
  assertAllowedKeys(value, RESULT_KEYS, "apply result");
  if (value.schemaVersion !== JANITOR_SCHEMA_VERSION) throw new Error("JANITOR_STATE_MALFORMED: apply result schema");
  assertNonEmpty(value.planDigest, "planDigest");
  if (!/^[0-9a-f]{64}$/i.test(value.planDigest)) throw new Error("JANITOR_STATE_MALFORMED: apply result digest");
  assertNonEmpty(value.inventoryId, "inventoryId");
  assertNonEmpty(value.startedAt, "startedAt");
  assertNonEmpty(value.completedAt, "completedAt");
  if (!Array.isArray(value.outcomes)) throw new Error("JANITOR_STATE_MALFORMED: apply result outcomes");
  const outcomes = value.outcomes.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`JANITOR_STATE_MALFORMED: outcome ${index}`);
    assertAllowedKeys(raw, OUTCOME_KEYS, `outcome ${index}`);
    assertNonEmpty(raw.stableId, `outcome ${index}.stableId`);
    const kind = normalizeKind(raw.kind);
    if (typeof raw.status !== "string" || !TARGET_STATUSES.includes(raw.status as JanitorTargetStatus)) throw new Error(`JANITOR_STATE_MALFORMED: outcome ${index}.status`);
    assertNonEmpty(raw.reason, `outcome ${index}.reason`);
    return { stableId: raw.stableId, kind, status: raw.status as JanitorTargetStatus, reason: raw.reason } satisfies JanitorTargetOutcome;
  });
  return { schemaVersion: JANITOR_SCHEMA_VERSION, planDigest: value.planDigest.toLowerCase(), inventoryId: value.inventoryId, startedAt: value.startedAt, completedAt: value.completedAt, outcomes };
}

export function summarizeDryRun(plan: JanitorCleanupPlan): {
  digest: string;
  deleteTargets: JanitorPlanEntry[];
  counts: Record<JanitorDecision | "protected" | "stale" | "ambiguous", number>;
} {
  const digest = calculatePlanDigest(plan);
  const deleteTargets = plan.entries.filter((entry) => entry.action === "delete" && !entry.protected && entry.classification !== "ambiguous");
  const counts = { keep: 0, delete: deleteTargets.length, unknown: 0, protected: 0, stale: 0, ambiguous: 0 };
  for (const entry of plan.entries) {
    if (entry.protected) counts.protected++;
    if (entry.action === "keep") counts.keep++;
    if (entry.action === "unknown") counts.unknown++;
    if (entry.classification === "ambiguous") counts.ambiguous++;
  }
  return { digest, deleteTargets, counts };
}

export function isExactMetadataMatch(expected: JanitorSafeMetadata, observed: JanitorSafeMetadata): boolean {
  return canonicalJson(expected) === canonicalJson(observed);
}

/** Correlate a fresh exact-ID inventory with the frozen plan and latest outcomes. */
export function correlateRescan(
  snapshot: JanitorInventorySnapshot,
  plan: JanitorCleanupPlan,
  result: JanitorApplyResult | null
): JanitorRescanSummary {
  const outcomes = new Map((result?.outcomes ?? []).map((outcome) => [`${outcome.kind}\0${outcome.stableId}`, outcome]));
  const targets = plan.entries.map((entry) => {
    const key = `${entry.kind}\0${entry.stableId}`;
    const observed = snapshot.resources.some((resource) => resource.kind === entry.kind && resource.stableId === entry.stableId);
    const outcome = outcomes.get(key);
    // A fresh observation is authoritative: a stale "removed" record cannot
    // claim success while the exact target is still present.
    const status = entry.action === "delete" && observed
      ? "still_present"
      : outcome?.status ?? (observed ? "still_present" : "not_observed");
    return {
      stableId: entry.stableId,
      kind: entry.kind,
      plannedAction: entry.action,
      observed,
      status,
      reason: entry.action === "delete" && observed
        ? "fresh rescan still observes the exact target"
        : outcome?.reason ?? (observed ? "exact target remains in the rescan" : "exact target was not observed"),
    } satisfies JanitorRescanTarget;
  });
  const repeatSafe = targets.every((target) =>
    target.plannedAction !== "delete" || ["removed", "already_absent", "skipped_protected", "skipped_drift", "skipped_ambiguous", "unsupported", "account_mismatch", "failed"].includes(target.status)
  );
  return { repeatSafe, targets };
}
