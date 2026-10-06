import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, ensureDir } from "../config/paths.js";
import { bindingFile, type ConnectionBinding } from "../connection/identity.js";
import { projectIdFromUrl } from "../session/state.js";
import {
  buildProtectionIndex,
  calculatePlanDigest,
  isExactMetadataMatch,
  parseCleanupPlan,
  parseApplyResult,
  parseInventorySnapshot,
  type ExactProtectionReference,
  type JanitorApplyResult,
  type JanitorCleanupPlan,
  type JanitorInventorySnapshot,
  type JanitorResourceObservation,
  type JanitorResourceKind,
  type JanitorSafeMetadata,
  type ProtectionIndex,
} from "./domain.js";
import { acquireJanitorLease, leaseFile, type JanitorLease, withProtectionFinalizationLease } from "./lease.js";

const RETENTION_LIMIT = 5;
const INVENTORY_RETENTION_LIMIT = 10;
const PROTECTION_REGISTRY_SCHEMA_VERSION = 1 as const;
const KEEP_LIST_SCHEMA_VERSION = 1 as const;

interface ProtectionRegistry {
  schemaVersion: typeof PROTECTION_REGISTRY_SCHEMA_VERSION;
  updatedAt: string;
  exact: ExactProtectionReference[];
}
interface JanitorKeepList {
  schemaVersion: typeof KEEP_LIST_SCHEMA_VERSION;
  updatedAt: string;
  exact: ExactProtectionReference[];
}

export function janitorStateDirectory(): string {
  return ensureDir(path.join(getStateDir(), "janitor"));
}

function inventoryDirectory(): string {
  return ensureDir(path.join(janitorStateDirectory(), "inventories"));
}

function resultDirectory(): string {
  return ensureDir(path.join(janitorStateDirectory(), "results"));
}

export function inventoryFile(inventoryId: string): string {
  return path.join(inventoryDirectory(), `${inventoryId}.json`);
}

export function planFile(): string {
  return path.join(janitorStateDirectory(), "active-plan.json");
}

export { acquireJanitorLease, leaseFile } from "./lease.js";
export type { JanitorLease } from "./lease.js";

function writeAtomicJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
}

function loadJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`JANITOR_STATE_MISSING: ${path.basename(file)}`);
    throw new Error(`JANITOR_STATE_MALFORMED: ${path.basename(file)}`);
  }
}

export function writeInventory(snapshot: JanitorInventorySnapshot): string {
  const validated = parseInventorySnapshot(snapshot);
  writeAtomicJson(inventoryFile(validated.inventoryId), validated);
  const activeInventoryId = (() => {
    try { return parseCleanupPlan(loadJson(planFile())).inventoryId; } catch { return null; }
  })();
  const files = fs.readdirSync(inventoryDirectory()).filter((file) => file.endsWith(".json")).sort().reverse();
  for (const stale of files.slice(INVENTORY_RETENTION_LIMIT)) {
    if (activeInventoryId && path.basename(stale, ".json") === activeInventoryId) continue;
    try { fs.rmSync(path.join(inventoryDirectory(), stale), { force: true }); } catch { /* bounded retention is best effort */ }
  }
  return inventoryFile(snapshot.inventoryId);
}

export function loadInventory(inventoryId: string): JanitorInventorySnapshot {
  const value = loadJson(inventoryFile(inventoryId));
  return parseInventorySnapshot(value);
}

export function loadLatestInventory(): JanitorInventorySnapshot {
  const files = fs.readdirSync(inventoryDirectory()).filter((file) => file.endsWith(".json"));
  if (files.length === 0) throw new Error("JANITOR_STATE_MISSING: inventory");
  const snapshots = files.map((file) => loadInventory(path.basename(file, ".json"))).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return snapshots[0];
}

export function writePlan(plan: JanitorCleanupPlan): string {
  const validated = parseCleanupPlan({ ...plan, digest: plan.digest ?? calculatePlanDigest(plan) });
  writeAtomicJson(planFile(), { ...validated, digest: calculatePlanDigest(validated) });
  return planFile();
}

export function loadPlan(): JanitorCleanupPlan {
  return parseCleanupPlan(loadJson(planFile()));
}

export function writeApplyResult(result: JanitorApplyResult): string {
  const validated = parseApplyResult(result);
  const digestPart = validated.planDigest.slice(0, 16);
  const file = path.join(resultDirectory(), `${Date.now()}-${digestPart}.json`);
  writeAtomicJson(file, validated);
  const files = fs.readdirSync(resultDirectory()).filter((candidate) => candidate.endsWith(".json")).sort().reverse();
  for (const stale of files.slice(RETENTION_LIMIT)) {
    try { fs.rmSync(path.join(resultDirectory(), stale), { force: true }); } catch { /* bounded retention is best effort */ }
  }
  return file;
}

export function loadLatestApplyResult(): JanitorApplyResult | null {
  const files = fs.readdirSync(resultDirectory()).filter((file) => file.endsWith(".json")).sort().reverse();
  if (files.length === 0) return null;
  return parseApplyResult(loadJson(path.join(resultDirectory(), files[0])));
}

function protectionRegistryFile(): string {
  return path.join(janitorStateDirectory(), "protection-references.json");
}

function keepListFile(): string {
  return path.join(janitorStateDirectory(), "keep-list.json");
}

function parseProtectionRegistry(value: unknown): ProtectionRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JANITOR_STATE_MALFORMED: protection registry");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "updatedAt", "exact"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`JANITOR_STATE_MALFORMED: protection registry field '${key}'`);
  if (raw.schemaVersion !== PROTECTION_REGISTRY_SCHEMA_VERSION || typeof raw.updatedAt !== "string" || !Array.isArray(raw.exact)) throw new Error("JANITOR_STATE_MALFORMED: protection registry");
  const exact = raw.exact.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`JANITOR_STATE_MALFORMED: protection reference ${index}`);
    const ref = entry as Record<string, unknown>;
    for (const key of ["kind", "stableId", "source", "reason"]) if (typeof ref[key] !== "string" || !String(ref[key]).trim()) throw new Error(`JANITOR_STATE_MALFORMED: protection reference ${index}`);
    return { kind: ref.kind as JanitorResourceKind, stableId: ref.stableId as string, source: ref.source as string, reason: ref.reason as string };
  });
  return { schemaVersion: PROTECTION_REGISTRY_SCHEMA_VERSION, updatedAt: raw.updatedAt, exact };
}

function readProtectionRegistry(): ProtectionRegistry {
  try { return parseProtectionRegistry(loadJson(protectionRegistryFile())); } catch (error) {
    if (error instanceof Error && error.message.startsWith("JANITOR_STATE_MISSING")) return { schemaVersion: PROTECTION_REGISTRY_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), exact: [] };
    throw error;
  }
}

function parseKeepList(value: unknown): JanitorKeepList {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JANITOR_STATE_MALFORMED: keep list");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "updatedAt", "exact"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`JANITOR_STATE_MALFORMED: keep list field '${key}'`);
  if (raw.schemaVersion !== KEEP_LIST_SCHEMA_VERSION || typeof raw.updatedAt !== "string" || !Array.isArray(raw.exact)) throw new Error("JANITOR_STATE_MALFORMED: keep list");
  const exact = raw.exact.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`JANITOR_STATE_MALFORMED: keep-list reference ${index}`);
    const ref = entry as Record<string, unknown>;
    for (const key of ["kind", "stableId", "source", "reason"]) if (typeof ref[key] !== "string" || !String(ref[key]).trim()) throw new Error(`JANITOR_STATE_MALFORMED: keep-list reference ${index}`);
    return { kind: ref.kind as JanitorResourceKind, stableId: ref.stableId as string, source: ref.source as string, reason: ref.reason as string };
  });
  return { schemaVersion: KEEP_LIST_SCHEMA_VERSION, updatedAt: raw.updatedAt, exact };
}

function readJanitorKeepList(): JanitorKeepList {
  try { return parseKeepList(loadJson(keepListFile())); } catch (error) {
    if (error instanceof Error && error.message.startsWith("JANITOR_STATE_MISSING")) return { schemaVersion: KEEP_LIST_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), exact: [] };
    throw error;
  }
}

export function writeProtectionReferences(references: readonly ExactProtectionReference[]): string {
  const normalized = buildProtectionIndex(references).exact;
  const registry: ProtectionRegistry = { schemaVersion: PROTECTION_REGISTRY_SCHEMA_VERSION, updatedAt: new Date().toISOString(), exact: [...normalized] };
  return withProtectionFinalizationLease(() => {
    writeAtomicJson(protectionRegistryFile(), registry);
    return protectionRegistryFile();
  });
}

/** Owner-only exact keep-list writer; all writes share the finalization lease. */
export function writeJanitorKeepList(references: readonly ExactProtectionReference[]): string {
  const normalized = buildProtectionIndex(references).exact;
  const keepList: JanitorKeepList = { schemaVersion: KEEP_LIST_SCHEMA_VERSION, updatedAt: new Date().toISOString(), exact: [...normalized] };
  return withProtectionFinalizationLease(() => {
    writeAtomicJson(keepListFile(), keepList);
    return keepListFile();
  });
}

/**
 * Migrate a legacy label/composite reference only when exactly one current
 * semantic observation matches the supplied safe metadata.
 */
export function migrateLegacyProtectionReference(input: {
  kind: JanitorResourceKind;
  metadata: JanitorSafeMetadata;
  candidates: readonly JanitorResourceObservation[];
  source: string;
  reason?: string;
}): ExactProtectionReference {
  const matches = input.candidates.filter((candidate) => candidate.kind === input.kind && isExactMetadataMatch(input.metadata, candidate.metadata));
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? "JANITOR_PROTECTION_MIGRATION_UNRESOLVED: no unique exact legacy match"
    : "JANITOR_PROTECTION_MIGRATION_AMBIGUOUS: multiple exact legacy matches");
  const migrated: ExactProtectionReference = {
    kind: input.kind,
    stableId: matches[0].stableId,
    source: input.source,
    reason: input.reason ?? "uniquely verified legacy protection migration",
  };
  const current = readJanitorKeepList().exact;
  writeJanitorKeepList([...current, migrated]);
  return migrated;
}

export function listProtectionReferences(): ProtectionIndex {
  const exact: ExactProtectionReference[] = [...readProtectionRegistry().exact, ...readJanitorKeepList().exact];
  const legacy: string[] = [];
  const directory = path.dirname(bindingFile("placeholder"));
  type BindingRecord = ConnectionBinding & { janitorResourceIds?: Partial<Record<JanitorResourceKind, string>> };
  let files: string[] = [];
  try { files = fs.readdirSync(directory).filter((file) => file.endsWith(".json")); } catch { files = []; }
  for (const file of files) {
    const sourceFile = path.join(directory, file);
    let raw: BindingRecord;
    try { raw = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as BindingRecord; } catch { legacy.push(`malformed-binding:${file}`); continue; }
    if (!raw || typeof raw !== "object" || typeof raw.workspaceId !== "string") { legacy.push(`invalid-binding:${file}`); continue; }
    if (typeof raw.projectId === "string" && raw.projectId.trim()) {
      exact.push({ kind: "project", stableId: raw.projectId, source: `binding:${raw.workspaceId}`, reason: "current C2C Project binding" });
    }
    const resourceIds = raw.janitorResourceIds;
    if (resourceIds && typeof resourceIds === "object") {
      for (const kind of ["project", "plugin", "custom_mcp", "connector"] as const) {
        const stableId = resourceIds[kind];
        if (typeof stableId === "string" && stableId.trim()) {
          exact.push({ kind, stableId, source: `binding:${raw.workspaceId}`, reason: "machine-local exact janitor reference" });
        }
      }
    }
    if (typeof raw.connectorName === "string" && raw.connectorName.trim()) legacy.push(`connector-label:${raw.connectorName}`);
    if (typeof raw.reviewerBinding === "string" && raw.reviewerBinding.trim()) legacy.push(`reviewer-label:${raw.reviewerBinding}`);
  }
  const stateRoot = getStateDir();
  const addDirectoryRecords = (directoryName: string, reader: (raw: Record<string, unknown>, file: string) => void): void => {
    const directoryPath = path.join(stateRoot, directoryName);
    let candidates: string[];
    try { candidates = fs.readdirSync(directoryPath).filter((file) => file.endsWith(".json")); } catch { return; }
    for (const file of candidates) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(directoryPath, file), "utf8")) as Record<string, unknown>;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) reader(raw, file);
        else legacy.push(`invalid-${directoryName}:${file}`);
      } catch { legacy.push(`malformed-${directoryName}:${file}`); }
    }
  };
  addDirectoryRecords("conversations", (raw, file) => {
    const conversations = raw.conversations;
    if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) return;
    for (const candidate of Object.values(conversations as Record<string, unknown>)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const projectId = (candidate as { projectId?: unknown }).projectId;
      if (typeof projectId === "string" && projectId.trim()) exact.push({ kind: "project", stableId: projectId, source: `conversation:${file}`, reason: "current conversation Project reference" });
    }
  });
  addDirectoryRecords("app-selections", (raw, file) => {
    const projectBinding = raw.projectBinding;
    if (typeof projectBinding === "string" && projectBinding.trim()) exact.push({ kind: "project", stableId: projectBinding, source: `app-selection:${file}`, reason: "current app-selection Project reference" });
    if (typeof raw.connectorName === "string" && raw.connectorName.trim()) legacy.push(`app-connector-label:${raw.connectorName}`);
    if (typeof raw.reviewerBinding === "string" && raw.reviewerBinding.trim()) legacy.push(`app-reviewer-label:${raw.reviewerBinding}`);
  });
  addDirectoryRecords("provisioning", (raw, file) => {
    const proof = raw.reviewerProof;
    if (proof && typeof proof === "object" && !Array.isArray(proof)) {
      const identity = (proof as { appIdentity?: unknown }).appIdentity;
      if (identity && typeof identity === "object" && !Array.isArray(identity)) {
        const connectorName = (identity as { connectorName?: unknown }).connectorName;
        if (typeof connectorName === "string" && connectorName.trim()) legacy.push(`provisioning-connector-label:${connectorName}`);
      }
    }
  });
  addDirectoryRecords("sessions", (raw, file) => {
    const projectUrls: unknown[] = [raw.projectUrl];
    const checkpoint = raw.checkpoint;
    if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) projectUrls.push((checkpoint as { projectUrl?: unknown }).projectUrl);
    for (const projectUrl of projectUrls) {
      if (typeof projectUrl !== "string" || !projectUrl.trim()) continue;
      const projectId = projectIdFromUrl(projectUrl);
      if (projectId) exact.push({ kind: "project", stableId: projectId, source: `session:${file}`, reason: "saved session Project reference" });
      else legacy.push(`session-project-url:${file}`);
    }
  });
  return buildProtectionIndex(exact, legacy);
}

export function resolveMachineAccountFingerprint(): string {
  const directory = path.dirname(bindingFile("placeholder"));
  const fingerprints = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(directory).filter((file) => file.endsWith(".json")); } catch { throw new Error("JANITOR_ACCOUNT_MISSING: no local connection bindings exist"); }
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as { accountFingerprint?: unknown };
      if (typeof raw.accountFingerprint === "string" && raw.accountFingerprint.trim()) fingerprints.add(raw.accountFingerprint);
    } catch {
      // Malformed bindings cannot establish account authority.
    }
  }
  if (fingerprints.size !== 1) throw new Error(fingerprints.size === 0 ? "JANITOR_ACCOUNT_MISSING: machine account proof is unavailable" : "JANITOR_ACCOUNT_AMBIGUOUS: multiple account authorities are present");
  return [...fingerprints][0];
}

export function stateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
