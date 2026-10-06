import { randomUUID } from "node:crypto";
import {
  assertPlanDigest,
  buildCleanupPlan,
  calculatePlanDigest,
  isExactMetadataMatch,
  normalizeInventory,
  parseCleanupPlan,
  summarizeDryRun,
  type JanitorApplyResult,
  type JanitorCleanupPlan,
  type JanitorInventorySnapshot,
  type JanitorPlanEntry,
  type JanitorResourceObservation,
  type JanitorRescanSummary,
  type JanitorTargetOutcome,
  type ProtectionIndex,
  correlateRescan as correlateRescanDomain,
} from "./domain.js";
import { listProtectionReferences, writeApplyResult, writeInventory, writePlan, writeProtectionReferences } from "./store.js";
import { acquireJanitorLease, acquireProtectionFinalizationLease } from "./lease.js";
import type { JanitorDriver } from "./driver.js";

export async function scanWithDriver(
  driver: JanitorDriver,
  input: { accountFingerprint: string; protection: ProtectionIndex }
): Promise<JanitorInventorySnapshot> {
  let probe = await driver.probeCapability();
  if (probe.status === "auth_required" && driver.awaitHumanAuthentication) probe = await driver.awaitHumanAuthentication();
  if (probe.status !== "available") throw new Error(probe.reason);
  const account = await driver.observeAuthenticatedAccount();
  if (account.status !== "available" || account.accountFingerprint !== input.accountFingerprint) {
    throw new Error(account.status === "auth_required" ? "AUTH_REQUIRED: authenticated account is required" : "CAPABILITY_UNAVAILABLE: account authority mismatch");
  }
  const observations = await driver.listResources();
  const snapshot = normalizeInventory(observations, {
    inventoryId: randomUUID(),
    accountFingerprint: input.accountFingerprint,
    protection: input.protection,
  });
  const capabilityDiagnostics = (["project", "plugin", "custom_mcp", "connector"] as const)
    .map((kind) => [kind, probe.capabilities[kind] ?? "unsupported"] as const)
    .filter(([, status]) => status !== "available")
    .map(([kind, status]) => `capability:${kind}:${status}`);
  snapshot.diagnostics.push(...capabilityDiagnostics);
  writeInventory(snapshot);
  const observedProtected = snapshot.resources
    .filter((resource) => resource.protected === true)
    .map((resource) => ({ kind: resource.kind, stableId: resource.stableId, source: "inventory", reason: resource.protectionReason ?? "exact inventory protection" }));
  if (observedProtected.length > 0) writeProtectionReferences([...input.protection.exact, ...observedProtected]);
  return snapshot;
}
export function createPlanFromInventory(snapshot: JanitorInventorySnapshot): JanitorCleanupPlan {
  const plan = buildCleanupPlan(snapshot);
  writePlan(plan);
  return plan;
}

export function dryRunCleanupPlan(
  plan: JanitorCleanupPlan,
  currentInventory: JanitorInventorySnapshot,
  expectedAccountFingerprint: string
): ReturnType<typeof summarizeDryRun> {
  const validated = parseCleanupPlan(plan);
  if (validated.inventoryId !== currentInventory.inventoryId) throw new Error("JANITOR_INVENTORY_MISMATCH: plan is not based on the selected inventory");
  if (validated.accountFingerprint !== expectedAccountFingerprint || currentInventory.accountFingerprint !== expectedAccountFingerprint) {
    throw new Error("JANITOR_ACCOUNT_MISMATCH: plan and current account authority differ");
  }
  validatePlanAgainstInventory(validated, currentInventory);
  return summarizeDryRun(validated);
}

/** Pure apply gate used before any browser/companion process is constructed. */
export function preflightApplyPlan(
  plan: JanitorCleanupPlan,
  currentInventory: JanitorInventorySnapshot,
  expectedDigest: string,
  expectedAccountFingerprint: string
): JanitorCleanupPlan {
  const validated = parseCleanupPlan(plan);
  assertPlanDigest(validated, expectedDigest);
  if (validated.inventoryId !== currentInventory.inventoryId) throw new Error("JANITOR_INVENTORY_MISMATCH: plan is not based on the selected inventory");
  if (validated.accountFingerprint !== expectedAccountFingerprint || currentInventory.accountFingerprint !== expectedAccountFingerprint) {
    throw new Error("JANITOR_ACCOUNT_MISMATCH: plan and current account authority differ");
  }
  validatePlanAgainstInventory(validated, currentInventory);
  return validated;
}

export function correlateRescan(
  snapshot: JanitorInventorySnapshot,
  plan: JanitorCleanupPlan,
  result: JanitorApplyResult | null
): JanitorRescanSummary {
  return correlateRescanDomain(snapshot, parseCleanupPlan(plan), result);
}

function currentResourceFor(entry: JanitorPlanEntry, currentInventory: JanitorInventorySnapshot): JanitorResourceObservation | undefined {
  return currentInventory.resources.find((resource) => resource.kind === entry.kind && resource.stableId === entry.stableId);
}

function validatePlanAgainstInventory(plan: JanitorCleanupPlan, snapshot: JanitorInventorySnapshot): void {
  const baseline = buildCleanupPlan(snapshot);
  const expected = new Map(baseline.entries.map((entry) => [`${entry.kind}\0${entry.stableId}`, entry]));
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    const key = `${entry.kind}\0${entry.stableId}`;
    const original = expected.get(key);
    if (!original) throw new Error(`JANITOR_PLAN_STALE: target ${entry.kind}:${entry.stableId} is not in the frozen inventory`);
    seen.add(key);
    if (
      !isExactMetadataMatch(entry.metadata, original.metadata) ||
      entry.protected !== original.protected ||
      entry.classification !== original.classification ||
      entry.reason !== original.reason ||
      entry.protectionReason !== original.protectionReason
    ) {
      throw new Error(`JANITOR_PLAN_IMMUTABLE_FIELD: ${entry.kind}:${entry.stableId}`);
    }
    if (original.protected && entry.action !== "keep") throw new Error(`JANITOR_PROTECTED_TARGET: ${entry.kind}:${entry.stableId}`);
  }
  if (seen.size !== expected.size) throw new Error("JANITOR_PLAN_STALE: plan entries do not match the frozen inventory");
}

function exactProtectionContains(index: ProtectionIndex, entry: JanitorPlanEntry): boolean {
  return index.exact.some((reference) => reference.kind === entry.kind && reference.stableId === entry.stableId);
}

export async function applyCleanupPlan(
  plan: JanitorCleanupPlan,
  currentInventory: JanitorInventorySnapshot,
  expectedDigest: string,
  expectedAccountFingerprint: string,
  driver: JanitorDriver,
  protectionProvider: () => ProtectionIndex = listProtectionReferences
): Promise<JanitorApplyResult> {
  const validated = preflightApplyPlan(plan, currentInventory, expectedDigest, expectedAccountFingerprint);
  const applyLease = acquireJanitorLease("apply");
  const startedAt = new Date().toISOString();
  const outcomes: JanitorTargetOutcome[] = [];
  const persistOutcomes = (): void => {
    writeApplyResult({
      schemaVersion: 1,
      planDigest: calculatePlanDigest(validated),
      inventoryId: validated.inventoryId,
      startedAt,
      completedAt: new Date().toISOString(),
      outcomes,
    });
  };
  const recordOutcome = (outcome: JanitorTargetOutcome): void => {
    outcomes.push(outcome);
    persistOutcomes();
  };
  try {
    for (const entry of validated.entries.filter((candidate) => candidate.action === "delete")) {
      if (entry.protected) {
        recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "skipped_protected", reason: "exact protection overrides delete" });
        continue;
      }
      if (entry.classification === "ambiguous") {
        recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "skipped_ambiguous", reason: "ambiguous inventory observation" });
        continue;
      }
      const current = currentResourceFor(entry, currentInventory);
      if (!current || current.capability !== "available" || !isExactMetadataMatch(entry.metadata, current.metadata)) {
        recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "skipped_drift", reason: "stable identity, capability, or metadata drifted" });
        continue;
      }
      let prepared: Awaited<ReturnType<JanitorDriver["prepareExactTarget"]>>;
      try {
        prepared = await driver.prepareExactTarget(entry);
      } catch (error) {
        recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "failed", reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if ("status" in prepared) {
        recordOutcome(prepared);
        continue;
      }
      if (
        prepared.stableId !== entry.stableId ||
        prepared.kind !== entry.kind ||
        !prepared.sessionId ||
        !Number.isSafeInteger(prepared.expiresAt) ||
        prepared.expiresAt <= Date.now() ||
        prepared.accountFingerprint !== expectedAccountFingerprint ||
        !isExactMetadataMatch(prepared.metadata, entry.metadata)
      ) {
        recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "skipped_drift", reason: "prepared target identity did not match the frozen plan" });
        continue;
      }
      const finalizationLease = acquireProtectionFinalizationLease();
      try {
        if (exactProtectionContains(protectionProvider(), entry)) {
          recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "skipped_protected", reason: "exact protection appeared before final confirmation" });
          continue;
        }
        const account = await driver.observeAuthenticatedAccount();
        if (account.status !== "available" || account.accountFingerprint !== expectedAccountFingerprint || prepared.accountFingerprint !== expectedAccountFingerprint) {
          recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "account_mismatch", reason: "authenticated account changed before final confirmation" });
          continue;
        }
        try {
          recordOutcome(await driver.confirmPreparedRemoval(prepared, validated));
        } catch (error) {
          // A timed-out companion request must be terminated while this lease
          // is still held. Otherwise the child could finish a destructive
          // click after the parent has recorded failure and unblocked writers.
          try {
            await driver.abortPendingOperation?.();
          } catch {
            // The concrete companion abort is fail-closed and bounded; a
            // fixture without the optional hook has no child to terminate.
          }
          recordOutcome({ stableId: entry.stableId, kind: entry.kind, status: "failed", reason: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        finalizationLease.release();
      }
    }
  } finally {
    applyLease.release();
  }
  const result: JanitorApplyResult = {
    schemaVersion: 1,
    planDigest: calculatePlanDigest(validated),
    inventoryId: validated.inventoryId,
    startedAt,
    completedAt: new Date().toISOString(),
    outcomes,
  };
  writeApplyResult(result);
  return result;
}
