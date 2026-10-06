import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_SCOPES } from "../auth/store.js";
import { getStateDir, readJsonIfExists } from "../config/paths.js";
import type { SetupMode } from "../config/ui-prefs.js";
import { writeConnectionBinding, type ConnectionBinding } from "./identity.js";

export type ConnectorConsentSurface = "chatgpt-unreviewed-mcp" | "unknown";
export type ConnectorConsentAction = "AUTO_CONFIRM" | "HUMAN_REQUIRED";
export type ConsentFreshness = "current" | "stale" | "unknown";

type ConsentBinding = Pick<
  ConnectionBinding,
  "workspace" | "canonicalRepository" | "installationId" | "endpointMode" | "endpointFingerprint" | "connectorName"
>;

export interface ConnectorConsentObservation {
  consentSurface: ConnectorConsentSurface;
  ownershipResolved: boolean;
  accountIdentityResolved: boolean;
  observed: ConsentBinding & {
    accountFingerprint?: string;
    scopes: readonly string[];
  };
  freshness: ConsentFreshness;
  challengeId: string;
  blockers?: {
    loginRequired?: boolean;
    captcha?: boolean;
    twoFactor?: boolean;
    destructive?: boolean;
    unexpectedAccount?: boolean;
  };
}

export interface ConnectorConsentContext extends ConnectorConsentObservation {
  setupMode: SetupMode | null;
  explicitC2CRequest: boolean;
  expected: ConsentBinding;
  expectedAccountFingerprint: string | null;
}

export interface ConnectorConsentDecision {
  action: ConnectorConsentAction;
  reason: string;
}

export interface ConsentChallengePrepareResult {
  action: "READY" | "HUMAN_REQUIRED";
  reason: string;
  challengeId?: string;
  expiresAt?: number;
}

export interface ConsentChallengeDecisionResult extends ConnectorConsentDecision {
  challengeId: string;
}

/**
 * Structured proof emitted by the authenticated ChatGPT/account surface before
 * the consent challenge is prepared. Raw account data never enters the
 * durable binding; only the verified fingerprint is persisted.
 */
export interface MachineVerifiedAccountObservation {
  source: "authenticated-account-surface" | "unknown";
  ownershipResolved: boolean;
  accountIdentityResolved: boolean;
  observed: ConsentBinding & { accountFingerprint?: string };
  freshness: ConsentFreshness;
}

export interface AccountBindingEstablishmentResult {
  action: "BOUND" | "HUMAN_REQUIRED";
  reason: string;
  accountFingerprint?: string;
}

interface PersistedConsentChallenge {
  challengeId: string;
  bindingDigest: string;
  accountFingerprint: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 64;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 15_000;
const CHALLENGE_ID_PATTERN = /^c2c_consent_[A-Za-z0-9_-]{32}$/;

const DEFAULT_EXPECTED_SCOPES = [...SUPPORTED_SCOPES];

function human(reason: string): ConnectorConsentDecision {
  return { action: "HUMAN_REQUIRED", reason };
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actual.length === actualSet.size &&
    actualSet.size === expectedSet.size &&
    expectedSet.size === expected.length &&
    expected.every((scope) => actualSet.has(scope))
  );
}

function matchesExpectedBinding(expected: ConsentBinding, observed: ConsentBinding): boolean {
  return (
    observed.workspace === expected.workspace &&
    observed.canonicalRepository === expected.canonicalRepository &&
    observed.installationId === expected.installationId &&
    observed.endpointMode === expected.endpointMode &&
    observed.endpointFingerprint === expected.endpointFingerprint &&
    observed.connectorName === expected.connectorName
  );
}

function hasAccountFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/** Stable non-secret digest of the six durable binding dimensions. */
export function connectorConsentBindingDigest(binding: ConsentBinding): string {
  const canonical = [
    binding.workspace,
    binding.canonicalRepository,
    binding.installationId,
    binding.endpointMode,
    binding.endpointFingerprint,
    binding.connectorName,
  ].join("\0");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Decide whether a visible ChatGPT warning belongs to this exact read-only C2C
 * operation. The browser layer supplies only observed structured evidence;
 * expected binding, account and scopes are runtime-owned.
 */
export function determineConnectorConsentAction(context: ConnectorConsentContext): ConnectorConsentDecision {
  if (context.setupMode !== "auto") return human("setup mode is not auto");
  if (!context.explicitC2CRequest) return human("explicit C2C request is not established");
  if (context.consentSurface !== "chatgpt-unreviewed-mcp") {
    return human("consent surface is not the verified ChatGPT C2C warning");
  }
  if (!context.challengeId || !CHALLENGE_ID_PATTERN.test(context.challengeId)) {
    return human("consent observation challenge is missing or invalid");
  }
  if (context.freshness !== "current") return human("consent observation is not current");
  if (!context.ownershipResolved) return human("connector ownership is unresolved");
  if (!context.accountIdentityResolved) return human("ChatGPT account identity is unresolved");
  if (!hasAccountFingerprint(context.expectedAccountFingerprint)) {
    return human("authoritative account identity is missing from the runtime binding");
  }
  if (!hasAccountFingerprint(context.observed.accountFingerprint)) {
    return human("observed ChatGPT account identity is missing");
  }
  if (context.observed.accountFingerprint !== context.expectedAccountFingerprint) {
    return human("observed ChatGPT account identity does not match the runtime binding");
  }

  const blockers = context.blockers ?? {};
  if (blockers.loginRequired) return human("ChatGPT login is required");
  if (blockers.captcha) return human("CAPTCHA is present");
  if (blockers.twoFactor) return human("unsupported 2FA is present");
  if (blockers.destructive) return human("operation is destructive or security-sensitive");
  if (blockers.unexpectedAccount) return human("account selection is ambiguous");

  if (!matchesExpectedBinding(context.expected, context.observed)) {
    return human("connector identity, endpoint, or workspace binding mismatches");
  }
  if (!sameStringSet(context.observed.scopes, DEFAULT_EXPECTED_SCOPES)) {
    return human("OAuth scopes are unexpected");
  }

  return {
    action: "AUTO_CONFIRM",
    reason: "verified expected read-only C2C connector consent",
  };
}

export function connectorConsentBinding(binding: ConnectionBinding): ConsentBinding {
  return {
    workspace: binding.workspace,
    canonicalRepository: binding.canonicalRepository,
    installationId: binding.installationId,
    endpointMode: binding.endpointMode,
    endpointFingerprint: binding.endpointFingerprint,
    connectorName: binding.connectorName,
  };
}

function registryDirectory(workspaceId: string): string {
  const workspaceDigest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  return path.join(getStateDir(), "consent", workspaceDigest);
}

function challengeFile(workspaceId: string, challengeId: string): string {
  return path.join(registryDirectory(workspaceId), `${challengeId}.json`);
}

function lockFile(workspaceId: string, name: string): string {
  return path.join(registryDirectory(workspaceId), `${name}.lock`);
}

function sleepBriefly(): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, 5);
}

function withExclusiveLock<T>(file: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) fs.rmSync(file, { force: true });
      } catch {
        // A concurrent owner may have released the lock between stat and rm.
      }
      if (Date.now() >= deadline) throw new Error("CONSENT_CHALLENGE_BUSY");
      sleepBriefly();
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best effort cleanup; a stale lock is recoverable on the next call.
      }
    }
  }
}

function writeAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

function listChallengeFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("c2c_consent_") && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function cleanupChallenges(directory: string, now: number): void {
  const records = listChallengeFiles(directory)
    .map((file) => ({ file, record: readJsonIfExists<PersistedConsentChallenge>(file) }))
    .filter((entry): entry is { file: string; record: PersistedConsentChallenge } => Boolean(entry.record));
  for (const entry of records) {
    if (!Number.isFinite(entry.record.expiresAt) || entry.record.expiresAt <= now) {
      try {
        fs.rmSync(entry.file, { force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
  const remaining = records
    .filter((entry) => entry.record.expiresAt > now)
    .sort((left, right) => left.record.createdAt - right.record.createdAt);
  while (remaining.length > MAX_CHALLENGES) {
    const oldest = remaining.shift();
    if (!oldest) break;
    try {
      fs.rmSync(oldest.file, { force: true });
    } catch {
      // best effort cleanup
    }
  }
}

function validChallengeId(value: string): boolean {
  return CHALLENGE_ID_PATTERN.test(value);
}

function challengeId(): string {
  return `c2c_consent_${randomBytes(24).toString("base64url")}`;
}

/** Register a short-lived non-secret challenge for the exact runtime binding. */
export function prepareConnectorConsent(input: {
  workspaceId: string;
  binding: ConnectionBinding | null;
  setupMode: SetupMode | null;
  now?: number;
  ttlMs?: number;
}): ConsentChallengePrepareResult {
  if (input.setupMode !== "auto") return { action: "HUMAN_REQUIRED", reason: "setup mode is not auto" };
  const binding = input.binding;
  if (!binding) return { action: "HUMAN_REQUIRED", reason: "exact connection binding is unavailable" };
  const accountFingerprint = binding.accountFingerprint;
  if (!hasAccountFingerprint(accountFingerprint)) {
    return { action: "HUMAN_REQUIRED", reason: "authoritative account identity is missing from the runtime binding" };
  }
  const now = input.now ?? Date.now();
  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS, 1_000), 120_000);
  const expiresAt = now + ttl;
  const id = challengeId();
  const directory = registryDirectory(input.workspaceId);
  const registryLock = lockFile(input.workspaceId, "registry");
  withExclusiveLock(registryLock, () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    cleanupChallenges(directory, now);
    writeAtomic(challengeFile(input.workspaceId, id), {
      challengeId: id,
      bindingDigest: connectorConsentBindingDigest(connectorConsentBinding(binding)),
      accountFingerprint,
      createdAt: now,
      expiresAt,
      consumed: false,
    } satisfies PersistedConsentChallenge);
    cleanupChallenges(directory, now);
  });
  return { action: "READY", reason: "consent challenge registered", challengeId: id, expiresAt };
}

/**
 * Establish the runtime-owned account authority from a machine-verified
 * authenticated surface observation. The caller supplies observed evidence
 * only; the durable binding remains the source of expected identity and
 * binding dimensions. No raw account material is persisted.
 */
export function establishMachineVerifiedAccountBinding(input: {
  workspaceId: string;
  binding: ConnectionBinding | null;
  evidence: MachineVerifiedAccountObservation;
}): AccountBindingEstablishmentResult {
  const binding = input.binding;
  if (!binding || binding.workspaceId !== input.workspaceId) {
    return { action: "HUMAN_REQUIRED", reason: "exact connection binding is unavailable" };
  }
  if (input.evidence.source !== "authenticated-account-surface") {
    return { action: "HUMAN_REQUIRED", reason: "authenticated account surface proof is unavailable" };
  }
  if (input.evidence.freshness !== "current") {
    return { action: "HUMAN_REQUIRED", reason: "authenticated account surface proof is not current" };
  }
  if (!input.evidence.ownershipResolved) {
    return { action: "HUMAN_REQUIRED", reason: "connector ownership is unresolved" };
  }
  if (!input.evidence.accountIdentityResolved) {
    return { action: "HUMAN_REQUIRED", reason: "ChatGPT account identity is unresolved" };
  }
  const observedAccountFingerprint = input.evidence.observed.accountFingerprint;
  if (!hasAccountFingerprint(observedAccountFingerprint)) {
    return { action: "HUMAN_REQUIRED", reason: "authenticated account fingerprint is missing" };
  }
  if (!matchesExpectedBinding(connectorConsentBinding(binding), input.evidence.observed)) {
    return { action: "HUMAN_REQUIRED", reason: "authenticated account surface binding mismatches the runtime binding" };
  }
  if (hasAccountFingerprint(binding.accountFingerprint) && binding.accountFingerprint !== observedAccountFingerprint) {
    return { action: "HUMAN_REQUIRED", reason: "authenticated account fingerprint conflicts with the runtime binding" };
  }
  if (!hasAccountFingerprint(binding.accountFingerprint)) {
    writeConnectionBinding({
      ...binding,
      accountFingerprint: observedAccountFingerprint,
      identitySource: "surface_observation",
    });
  }
  return { action: "BOUND", reason: "machine-verified account authority recorded", accountFingerprint: observedAccountFingerprint };
}

function observationFromEvidence(evidence: ConnectorConsentObservation): ConnectorConsentObservation {
  return {
    consentSurface: evidence.consentSurface,
    ownershipResolved: evidence.ownershipResolved === true,
    accountIdentityResolved: evidence.accountIdentityResolved === true,
    observed: {
      ...evidence.observed,
      scopes: [...evidence.observed.scopes],
    },
    freshness: evidence.freshness,
    challengeId: evidence.challengeId,
    blockers: evidence.blockers,
  };
}

/**
 * Decide and atomically consume a registered challenge. The caller can supply
 * only observed evidence; expected binding/account/scopes are derived here.
 */
export function decideConnectorConsent(input: {
  workspaceId: string;
  binding: ConnectionBinding | null;
  setupMode: SetupMode | null;
  explicitC2CRequest: boolean;
  challengeId: string;
  evidence: ConnectorConsentObservation;
  now?: number;
}): ConsentChallengeDecisionResult {
  const id = input.challengeId;
  if (!validChallengeId(id)) return { ...human("consent observation challenge is missing or invalid"), challengeId: id };

  const now = input.now ?? Date.now();
  const file = challengeFile(input.workspaceId, id);
  const result = withExclusiveLock(lockFile(input.workspaceId, id), () => {
    const record = readJsonIfExists<PersistedConsentChallenge>(file);
    if (!record || record.challengeId !== id) return human("consent observation challenge is unknown");
    if (record.expiresAt <= now) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort cleanup
      }
      return human("consent observation challenge has expired");
    }
    if (record.consumed) return human("consent observation challenge was already consumed");

    // A valid, live challenge is terminalized on the first decision attempt,
    // including fail-closed decisions. This prevents invalid evidence from
    // being corrected and replayed against the same one-shot authorization.
    writeAtomic(file, { ...record, consumed: true } satisfies PersistedConsentChallenge);

    const binding = input.binding;
    if (!binding) return human("exact connection binding is unavailable");
    const accountFingerprint = binding.accountFingerprint;
    if (!hasAccountFingerprint(accountFingerprint)) {
      return human("authoritative account identity is missing from the runtime binding");
    }

    const bindingProjection = connectorConsentBinding(binding);
    if (record.bindingDigest !== connectorConsentBindingDigest(bindingProjection)) {
      return human("consent challenge binding no longer matches the runtime binding");
    }
    if (record.accountFingerprint !== accountFingerprint) {
      return human("consent challenge account authority no longer matches the runtime binding");
    }

    const observation = observationFromEvidence(input.evidence);
    const decision = determineConnectorConsentAction({
      ...observation,
      setupMode: input.setupMode,
      explicitC2CRequest: input.explicitC2CRequest,
      expected: bindingProjection,
      expectedAccountFingerprint: accountFingerprint,
    });
    return decision;
  });
  return { ...result, challengeId: id };
}

/** Test/support hook: remove only this workspace's bounded challenge registry. */
export function clearConsentChallengeRegistry(workspaceId: string): void {
  try {
    fs.rmSync(registryDirectory(workspaceId), { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}
