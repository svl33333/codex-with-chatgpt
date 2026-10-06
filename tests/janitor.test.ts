import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCleanupPlan,
  correlateRescan,
  dryRunCleanupPlan,
  preflightApplyPlan,
  scanWithDriver,
} from "../src/janitor/service.js";
import {
  assertPlanDigest,
  buildCleanupPlan,
  buildProtectionIndex,
  calculatePlanDigest,
  normalizeInventory,
  parseApplyResult,
  parseCleanupPlan,
  parseInventorySnapshot,
  summarizeDryRun,
  type JanitorPlanEntry,
  type JanitorResourceObservation,
} from "../src/janitor/domain.js";
import { canonicalProjectIdFromHref, CompanionJanitorDriver, matchMachineVerifiedAccountFingerprint, PreparedTokenRegistry, projectCapabilityStatus, projectMetadataFromDom, type JanitorDriver, type PreparedRemoval } from "../src/janitor/driver.js";
import { acquireProtectionFinalizationLease } from "../src/janitor/lease.js";
import { acquireJanitorLease, janitorStateDirectory, listProtectionReferences, migrateLegacyProtectionReference, writeJanitorKeepList } from "../src/janitor/store.js";
import { writeSession } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("janitor domain and safety boundaries", () => {
  const dirs: string[] = [];
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function observation(stableId: string, kind: JanitorResourceObservation["kind"], name: string): JanitorResourceObservation {
    return { stableId, kind, metadata: { name }, capability: "available", classification: "active", reason: "fixture" };
  }

  class DelayedTerminationChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly killCalls: Array<NodeJS.Signals | "default"> = [];
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;

    kill(signal?: NodeJS.Signals): boolean {
      this.killCalls.push(signal ?? "default");
      this.killed = true;
      if (signal === "SIGKILL") {
        setTimeout(() => {
          this.signalCode = "SIGKILL";
          this.stdout.end();
          this.stderr.end();
          this.emit("exit", null, "SIGKILL");
          this.emit("close", null, "SIGKILL");
        }, 10);
      }
      return true;
    }
  }

  it("keeps exact protected resources and defaults other resources to unknown", () => {
    const snapshot = normalizeInventory(
      [observation("project-1", "project", "keep me"), observation("connector-1", "connector", "old")],
      {
        inventoryId: "inventory-1",
        accountFingerprint: "account-a",
        protection: buildProtectionIndex([{ kind: "project", stableId: "project-1", source: "fixture", reason: "current project" }]),
      }
    );
    const plan = buildCleanupPlan(snapshot);
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ stableId: "project-1", action: "keep", protected: true }),
      expect.objectContaining({ stableId: "connector-1", action: "unknown", protected: false }),
    ]));
  });

  it("marks conflicting duplicate observations ambiguous and non-destructive", () => {
    const snapshot = normalizeInventory(
      [observation("p-1", "project", "one"), observation("p-1", "project", "two")],
      { inventoryId: "inventory-2", accountFingerprint: "account-a", protection: buildProtectionIndex([]) }
    );
    expect(snapshot.resources[0]).toMatchObject({ stableId: "p-1", classification: "ambiguous", capability: "ambiguous" });
    expect(buildCleanupPlan(snapshot).entries[0]).toMatchObject({ action: "unknown", classification: "ambiguous" });
  });

  it("binds digest to the human-edited action and rejects unknown fields", () => {
    const snapshot = normalizeInventory([observation("p-2", "project", "review")], {
      inventoryId: "inventory-3",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const generated = buildCleanupPlan(snapshot);
    const edited = parseCleanupPlan({ ...generated, entries: [{ ...generated.entries[0], action: "delete" }] });
    const digest = calculatePlanDigest(edited);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    assertPlanDigest(edited, digest);
    expect(() => parseCleanupPlan({ ...edited, unexpected: true })).toThrow(/unknown plan field/);
    expect(() => assertPlanDigest(edited, "0".repeat(64))).toThrow(/DIGEST_MISMATCH/);
  });

  it("rejects edits to immutable protection and identity evidence", () => {
    const snapshot = normalizeInventory([observation("p-protected", "project", "keep")], {
      inventoryId: "inventory-protected",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([{ kind: "project", stableId: "p-protected", source: "fixture", reason: "current" }]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].protected = false;
    plan.entries[0].action = "delete";
    expect(() => dryRunCleanupPlan(plan, snapshot, "account-a")).toThrow(/JANITOR_PLAN_IMMUTABLE|JANITOR_PROTECTED/);
  });

  it("rejects malformed or unknown inventory/result fields", () => {
    const snapshot = normalizeInventory([observation("p-strict", "project", "strict")], {
      inventoryId: "inventory-strict",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    expect(() => parseInventorySnapshot({ ...snapshot, unexpected: true })).toThrow(/unknown inventory field/);
    expect(() => parseApplyResult({ schemaVersion: 1, planDigest: "0".repeat(64), inventoryId: "inventory-strict", startedAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), outcomes: [], unexpected: true })).toThrow(/unknown apply result field/);
  });

  it("reports exact dry-run targets and counts without driver access", () => {
    const snapshot = normalizeInventory([observation("p-3", "project", "review")], {
      inventoryId: "inventory-4",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    const report = dryRunCleanupPlan(plan, snapshot, "account-a");
    expect(report.deleteTargets).toHaveLength(1);
    expect(report.counts).toMatchObject({ delete: 1, unknown: 0, protected: 0 });
  });

  it("correlates every frozen target by exact kind and stable ID", () => {
    const snapshot = normalizeInventory([observation("p-3", "project", "review")], {
      inventoryId: "inventory-4b",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    const correlation = correlateRescan(snapshot, plan, {
      schemaVersion: 1,
      planDigest: calculatePlanDigest(plan),
      inventoryId: plan.inventoryId,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      outcomes: [{ stableId: "p-3", kind: "project", status: "removed", reason: "fixture" }],
    });
    expect(correlation).toEqual({
      repeatSafe: false,
      targets: [expect.objectContaining({ stableId: "p-3", kind: "project", status: "still_present", observed: true })],
    });
  });

  it("retains the full Project stable-id namespace and derives safe metadata", () => {
    expect(canonicalProjectIdFromHref("/g/g-p-project-1/project")).toBe("g-p-project-1");
    expect(canonicalProjectIdFromHref("https://chatgpt.com/g/g-p-project-1/c/abc")).toBe("g-p-project-1");
    expect(projectMetadataFromDom("g-p-project-1", "  Keep this  ")).toEqual({ projectId: "g-p-project-1", name: "Keep this" });
    expect(canonicalProjectIdFromHref("/g/project-1/project")).toBeNull();
  });

  it("protects exact Project IDs saved in local sessions", () => {
    dirs.push(isolateStateDir());
    const sessions = path.join(process.env.C2C_STATE_DIR!, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "workspace.json"), JSON.stringify({ projectUrl: "https://chatgpt.com/g/g-p-session-1/project" }));
    expect(listProtectionReferences().exact).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "project", stableId: "g-p-session-1", source: "session:workspace.json" })]));
  });

  it("blocks a session writer while final protection is being finalized", () => {
    dirs.push(isolateStateDir());
    const lease = acquireProtectionFinalizationLease();
    try {
      expect(() => writeSession("workspace", { projectUrl: "https://chatgpt.com/g/g-p-race/project", savedAt: new Date().toISOString() })).toThrow(/JANITOR_BUSY/);
    } finally {
      lease.release();
    }
  });

  it("requires exact machine account evidence instead of a visible menu label", () => {
    expect(matchMachineVerifiedAccountFingerprint("account-a", "account-a")).toBe("account-a");
    expect(matchMachineVerifiedAccountFingerprint("account-a", "Alice Example")).toBeNull();
    expect(matchMachineVerifiedAccountFingerprint(undefined, "account-a")).toBeNull();
  });

  it("treats an authenticated empty Project collection as supported", () => {
    expect(projectCapabilityStatus(0, 1)).toBe("available");
    expect(projectCapabilityStatus(0, 0)).toBe("unsupported");
    expect(projectCapabilityStatus(2, 0)).toBe("available");
  });

  it("keeps the visible authentication boundary open for a bounded human step", async () => {
    dirs.push(isolateStateDir());
    let waited = false;
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "auth_required", reason: "fixture login", capabilities: {} }; },
      async awaitHumanAuthentication() {
        waited = true;
        return { status: "available", reason: "fixture human completed login", capabilities: { project: "available", plugin: "unsupported", custom_mcp: "unsupported", connector: "unsupported" } };
      },
      async observeAuthenticatedAccount() { return { accountFingerprint: "account-a", status: "available", reason: "fixture" }; },
      async listResources() { return [observation("p-auth", "project", "auth")]; },
      async prepareExactTarget(entry) { return { stableId: entry.stableId, kind: entry.kind, status: "unsupported", reason: "fixture" }; },
      async confirmPreparedRemoval(prepared) { return { stableId: prepared.stableId, kind: prepared.kind, status: "unsupported", reason: "fixture" }; },
      async close() {},
    };
    const snapshot = await scanWithDriver(driver, { accountFingerprint: "account-a", protection: buildProtectionIndex([]) });
    expect(waited).toBe(true);
    expect(snapshot.resources).toHaveLength(1);
  });

  it("records unsupported per-kind capabilities in a partial scan diagnostic", async () => {
    dirs.push(isolateStateDir());
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "available", reason: "fixture", capabilities: { project: "available", plugin: "unsupported", custom_mcp: "route_drift", connector: "unsupported" } }; },
      async observeAuthenticatedAccount() { return { accountFingerprint: "account-a", status: "available", reason: "fixture" }; },
      async listResources() { return [observation("p-cap", "project", "cap")]; },
      async prepareExactTarget(entry) { return { stableId: entry.stableId, kind: entry.kind, status: "unsupported", reason: "fixture" }; },
      async confirmPreparedRemoval(prepared) { return { stableId: prepared.stableId, kind: prepared.kind, status: "unsupported", reason: "fixture" }; },
      async close() {},
    };
    const snapshot = await scanWithDriver(driver, { accountFingerprint: "account-a", protection: buildProtectionIndex([]) });
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining(["capability:plugin:unsupported", "capability:custom_mcp:route_drift", "capability:connector:unsupported"]));
  });

  it("fails closed when the account changes between preparation and confirmation", async () => {
    const snapshot = normalizeInventory([observation("p-4", "project", "review")], {
      inventoryId: "inventory-5",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    let accountReads = 0;
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "available", reason: "fixture", capabilities: { project: "available" } }; },
      async observeAuthenticatedAccount() {
        accountReads++;
        return { accountFingerprint: accountReads === 1 ? "account-b" : "account-a", status: "available", reason: "fixture" };
      },
      async listResources() { return snapshot.resources; },
      async prepareExactTarget(entry: JanitorPlanEntry): Promise<PreparedRemoval> {
        return { token: "one-shot", sessionId: "fixture-session", expiresAt: Date.now() + 30_000, stableId: entry.stableId, kind: entry.kind, metadata: entry.metadata, accountFingerprint: "account-a" };
      },
      async confirmPreparedRemoval(prepared) {
        return { stableId: prepared.stableId, kind: prepared.kind, status: "removed", reason: "fixture" };
      },
      async close() {},
    };
    const result = await applyCleanupPlan(plan, snapshot, calculatePlanDigest(plan), "account-a", driver);
    expect(result.outcomes).toEqual([expect.objectContaining({ status: "account_mismatch" })]);
  });

  it("records one target failure and continues with later exact targets", async () => {
    const snapshot = normalizeInventory([observation("p-5", "project", "first"), observation("p-6", "project", "second")], {
      inventoryId: "inventory-6",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    for (const entry of plan.entries) entry.action = "delete";
    let prepares = 0;
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "available", reason: "fixture", capabilities: { project: "available" } }; },
      async observeAuthenticatedAccount() { return { accountFingerprint: "account-a", status: "available", reason: "fixture" }; },
      async listResources() { return snapshot.resources; },
      async prepareExactTarget(entry: JanitorPlanEntry): Promise<PreparedRemoval> {
        prepares++;
        if (entry.stableId === "p-5") throw new Error("fixture prepare failure");
        return { token: "one-shot", sessionId: "fixture-session", expiresAt: Date.now() + 30_000, stableId: entry.stableId, kind: entry.kind, metadata: entry.metadata, accountFingerprint: "account-a" };
      },
      async confirmPreparedRemoval(prepared) { return { stableId: prepared.stableId, kind: prepared.kind, status: "removed", reason: "fixture" }; },
      async close() {},
    };
    const result = await applyCleanupPlan(plan, snapshot, calculatePlanDigest(plan), "account-a", driver, () => buildProtectionIndex([]));
    expect(prepares).toBe(2);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ stableId: "p-5", status: "failed" }),
      expect.objectContaining({ stableId: "p-6", status: "removed" }),
    ]);
  });

  it("aborts a timed-out confirmation before releasing the finalization lease", async () => {
    const snapshot = normalizeInventory([observation("p-timeout", "project", "timeout")], {
      inventoryId: "inventory-timeout",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    let aborted = false;
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "available", reason: "fixture", capabilities: { project: "available" } }; },
      async observeAuthenticatedAccount() { return { accountFingerprint: "account-a", status: "available", reason: "fixture" }; },
      async listResources() { return snapshot.resources; },
      async prepareExactTarget(entry) { return { token: "one-shot", sessionId: "fixture-session", expiresAt: Date.now() + 30_000, stableId: entry.stableId, kind: entry.kind, metadata: entry.metadata, accountFingerprint: "account-a" }; },
      async confirmPreparedRemoval() { throw new Error("fixture transport timeout"); },
      async abortPendingOperation() {
        expect(() => acquireProtectionFinalizationLease()).toThrow(/JANITOR_BUSY/);
        aborted = true;
      },
      async close() {},
    };
    const result = await applyCleanupPlan(plan, snapshot, calculatePlanDigest(plan), "account-a", driver);
    expect(aborted).toBe(true);
    expect(result.outcomes).toEqual([expect.objectContaining({ stableId: "p-timeout", status: "failed" })]);
    const after = acquireProtectionFinalizationLease();
    after.release();
  });

  it("waits for confirmed companion exit before rejecting a timed-out confirmation", async () => {
    dirs.push(isolateStateDir());
    const child = new DelayedTerminationChild();
    const driver = new CompanionJanitorDriver(child as never, 25);
    const snapshot = normalizeInventory([observation("p-child", "project", "child")], {
      inventoryId: "inventory-child-timeout",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    const prepared: PreparedRemoval = {
      token: "one-shot",
      sessionId: "fixture-session",
      expiresAt: Date.now() + 30_000,
      stableId: "p-child",
      kind: "project",
      metadata: plan.entries[0].metadata,
      accountFingerprint: "account-a",
    };
    const lease = acquireProtectionFinalizationLease();
    const pending = driver.confirmPreparedRemoval(prepared, plan);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const abort = driver.abortPendingOperation();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    expect(child.killCalls).toEqual(["default"]);
    expect(() => acquireProtectionFinalizationLease()).toThrow(/JANITOR_BUSY/);
    await abort;
    await expect(pending).rejects.toThrow(/aborted after a destructive operation timeout/);
    expect(child.killCalls).toEqual(["default", "SIGKILL"]);
    lease.release();
    const after = acquireProtectionFinalizationLease();
    after.release();
  });

  it("skips a target newly protected at the finalization boundary", async () => {
    const snapshot = normalizeInventory([observation("p-7", "project", "late keep")], {
      inventoryId: "inventory-7",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    plan.entries[0].action = "delete";
    const driver: JanitorDriver = {
      async probeCapability() { return { status: "available", reason: "fixture", capabilities: { project: "available" } }; },
      async observeAuthenticatedAccount() { return { accountFingerprint: "account-a", status: "available", reason: "fixture" }; },
      async listResources() { return snapshot.resources; },
      async prepareExactTarget(entry) { return { token: "one-shot", sessionId: "fixture-session", expiresAt: Date.now() + 30_000, stableId: entry.stableId, kind: entry.kind, metadata: entry.metadata, accountFingerprint: "account-a" }; },
      async confirmPreparedRemoval(prepared) { return { stableId: prepared.stableId, kind: prepared.kind, status: "removed", reason: "fixture" }; },
      async close() {},
    };
    const result = await applyCleanupPlan(plan, snapshot, calculatePlanDigest(plan), "account-a", driver, () => buildProtectionIndex([{ kind: "project", stableId: "p-7", source: "fixture", reason: "new keep" }]));
    expect(result.outcomes).toEqual([expect.objectContaining({ status: "skipped_protected" })]);
  });

  it("rejects a second apply lease and releases only its own lease", () => {
    dirs.push(isolateStateDir());
    const first = acquireJanitorLease();
    expect(() => acquireJanitorLease()).toThrow(/JANITOR_BUSY/);
    first.release();
    const second = acquireJanitorLease();
    second.release();
    expect(fs.existsSync(path.join(janitorStateDirectory(), "apply.lease"))).toBe(false);
  });

  it("consumes prepared tokens once and rejects wrong-session or expired handles", () => {
    const registry = new PreparedTokenRegistry("session-a", 20);
    const prepared = registry.issue({ stableId: "p-token", kind: "project", metadata: { name: "token" }, accountFingerprint: "account-a" });
    expect(registry.consume(prepared)).toMatchObject({ stableId: "p-token", sessionId: "session-a" });
    expect(() => registry.consume(prepared)).toThrow(/expired or replayed/);
    const expiredRegistry = new PreparedTokenRegistry("session-b", -1);
    const expired = expiredRegistry.issue({ stableId: "p-expired", kind: "project", metadata: {}, accountFingerprint: "account-a" });
    expect(() => expiredRegistry.consume(expired)).toThrow(/expired|replayed/);
  });

  it("uses an owner keep-list and migrates only a unique exact legacy match", () => {
    dirs.push(isolateStateDir());
    writeJanitorKeepList([{ kind: "project", stableId: "g-p-keep", source: "owner", reason: "explicit keep" }]);
    const keepIndex = listProtectionReferences();
    expect(keepIndex.exact).toEqual(expect.arrayContaining([expect.objectContaining({ stableId: "g-p-keep" })]));
    const keptSnapshot = normalizeInventory([observation("g-p-keep", "project", "kept")], { inventoryId: "inventory-keep", accountFingerprint: "account-a", protection: keepIndex });
    expect(buildCleanupPlan(keptSnapshot).entries[0]).toMatchObject({ protected: true, action: "keep" });
    const migrated = migrateLegacyProtectionReference({
      kind: "project",
      metadata: { name: "legacy" },
      candidates: [observation("g-p-migrated", "project", "legacy")],
      source: "legacy-test",
    });
    expect(migrated.stableId).toBe("g-p-migrated");
    expect(listProtectionReferences().exact).toEqual(expect.arrayContaining([expect.objectContaining({ stableId: "g-p-migrated" })]));
    expect(() => migrateLegacyProtectionReference({
      kind: "project",
      metadata: { name: "ambiguous" },
      candidates: [observation("g-p-a", "project", "ambiguous"), observation("g-p-b", "project", "ambiguous")],
      source: "legacy-test",
    })).toThrow(/MIGRATION_AMBIGUOUS/);
  });

  it("rejects an invalid apply digest during pure preflight", () => {
    const snapshot = normalizeInventory([observation("p-preflight", "project", "preflight")], {
      inventoryId: "inventory-preflight",
      accountFingerprint: "account-a",
      protection: buildProtectionIndex([]),
    });
    const plan = buildCleanupPlan(snapshot);
    expect(() => preflightApplyPlan(plan, snapshot, "0".repeat(64), "account-a")).toThrow(/DIGEST_MISMATCH/);
  });

  it("keeps janitor machine-wide -w compatibility at the CLI boundary", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(projectRoot, "src/cli/index.ts"), "janitor", "-w", "C:\\ignored", "--help"], { cwd: projectRoot, encoding: "utf8", env: process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ignored; this command is machine-wide");
  });
});
