import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { canonicalJson, isExactMetadataMatch } from "./domain.js";
import type {
  JanitorCapabilityStatus,
  JanitorCleanupPlan,
  JanitorPlanEntry,
  JanitorResourceObservation,
  JanitorSafeMetadata,
  JanitorTargetOutcome,
} from "./domain.js";

export interface JanitorAccountObservation {
  accountFingerprint: string | null;
  status: "available" | "auth_required" | "unsupported";
  reason: string;
}
export interface JanitorProbeResult {
  status: "available" | "auth_required" | "unsupported";
  reason: string;
  capabilities: Partial<Record<JanitorPlanEntry["kind"], JanitorCapabilityStatus>>;
}

export interface PreparedRemoval {
  token: string;
  sessionId: string;
  expiresAt: number;
  stableId: string;
  kind: JanitorPlanEntry["kind"];
  metadata: JanitorPlanEntry["metadata"];
  accountFingerprint: string;
}

export interface JanitorDriver {
  probeCapability(): Promise<JanitorProbeResult>;
  /** Keep the visible first-party page available for a human login/2FA step. */
  awaitHumanAuthentication?(timeoutMs?: number): Promise<JanitorProbeResult>;
  /** Abort an in-flight destructive companion request before its lease is released. */
  abortPendingOperation?(): Promise<void>;
  observeAuthenticatedAccount(): Promise<JanitorAccountObservation>;
  listResources(): Promise<JanitorResourceObservation[]>;
  prepareExactTarget(entry: JanitorPlanEntry): Promise<PreparedRemoval | JanitorTargetOutcome>;
  confirmPreparedRemoval(prepared: PreparedRemoval, plan: JanitorCleanupPlan): Promise<JanitorTargetOutcome>;
  close(): Promise<void>;
}

/** In-memory one-shot handle store owned by one companion process/session. */
export class PreparedTokenRegistry {
  private readonly records = new Map<string, PreparedRemoval>();

  constructor(readonly sessionId = randomBytes(24).toString("base64url"), private readonly ttlMs = 30_000) {}

  issue(input: Omit<PreparedRemoval, "token" | "sessionId" | "expiresAt">): PreparedRemoval {
    const token = randomBytes(32).toString("base64url");
    const prepared: PreparedRemoval = { ...input, token, sessionId: this.sessionId, expiresAt: Date.now() + this.ttlMs };
    this.records.set(token, prepared);
    return prepared;
  }

  consume(prepared: PreparedRemoval): PreparedRemoval {
    const current = this.records.get(prepared.token);
    this.records.delete(prepared.token);
    if (!current || current.sessionId !== this.sessionId || current.expiresAt <= Date.now()) throw new Error("CAPABILITY_UNAVAILABLE: prepared removal token is expired or replayed");
    if (current.stableId !== prepared.stableId || current.kind !== prepared.kind || current.accountFingerprint !== prepared.accountFingerprint || canonicalJson(current.metadata) !== canonicalJson(prepared.metadata)) {
      throw new Error("CAPABILITY_UNAVAILABLE: prepared removal token identity mismatch");
    }
    return current;
  }
}

function unsupportedOutcome(entry: JanitorPlanEntry, reason: string): JanitorTargetOutcome {
  return { stableId: entry.stableId, kind: entry.kind, status: "unsupported", reason };
}

function driftOutcome(entry: JanitorPlanEntry, reason: string): JanitorTargetOutcome {
  return { stableId: entry.stableId, kind: entry.kind, status: "skipped_drift", reason };
}

/** Canonical Project identity parser; the full `g-p-` namespace is retained. */
export function canonicalProjectIdFromHref(href: string): string | null {
  return href.match(/(?:^|\/)g\/(g-p-[^/?#]+)/)?.[1] ?? null;
}

export function projectMetadataFromDom(stableId: string, visibleName: string): JanitorSafeMetadata {
  const name = visibleName.trim();
  return name ? { projectId: stableId, name } : { projectId: stableId };
}

export function matchMachineVerifiedAccountFingerprint(expected: string | undefined, observed: string | null): string | null {
  return expected && observed === expected ? observed : null;
}

/**
 * An empty Project collection is a valid supported state.  Item links prove
 * the surface when resources exist; otherwise an independently verified
 * collection/navigation surface must prove that enumeration is available.
 */
export function projectCapabilityStatus(projectCount: number, collectionSurfaceCount: number): JanitorCapabilityStatus {
  return projectCount > 0 || collectionSurfaceCount > 0 ? "available" : "unsupported";
}

/** Safe fallback used when the supported semantic browser capability is absent. */
export class UnsupportedJanitorDriver implements JanitorDriver {
  constructor(private readonly reason: string) {}

  async probeCapability(): Promise<JanitorProbeResult> {
    return {
      status: "unsupported",
      reason: this.reason,
      capabilities: { project: "unsupported", plugin: "unsupported", custom_mcp: "unsupported", connector: "unsupported" },
    };
  }

  async awaitHumanAuthentication(): Promise<JanitorProbeResult> {
    return this.probeCapability();
  }

  async abortPendingOperation(): Promise<void> {
    // There is no child process to abort for this already-local fail-closed driver.
  }

  async observeAuthenticatedAccount(): Promise<JanitorAccountObservation> {
    return { accountFingerprint: null, status: "unsupported", reason: this.reason };
  }

  async listResources(): Promise<JanitorResourceObservation[]> {
    return [];
  }

  async prepareExactTarget(entry: JanitorPlanEntry): Promise<JanitorTargetOutcome> {
    return unsupportedOutcome(entry, this.reason);
  }

  async confirmPreparedRemoval(prepared: PreparedRemoval, _plan: JanitorCleanupPlan): Promise<JanitorTargetOutcome> {
    return { stableId: prepared.stableId, kind: prepared.kind, status: "unsupported", reason: this.reason };
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}

interface CompanionEnvelope {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type CompanionOperation = "probe" | "await-authentication" | "account" | "list" | "prepare" | "confirm" | "close";

/** Parent-side client for the repository-owned line-delimited companion process. */
export class CompanionJanitorDriver implements JanitorDriver {
  private readonly lines: readline.Interface;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly abortGraceMs = 1_000) {
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", () => {
      // Keep stderr drained without mixing diagnostics into the JSON protocol.
    });
    child.on("error", (error) => this.failPending(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code) => {
      if (!this.closed && code !== 0) this.failPending(new Error(`CAPABILITY_UNAVAILABLE: janitor companion exited with code ${code ?? "unknown"}`));
    });
  }

  private handleLine(line: string): void {
    let response: CompanionEnvelope;
    try {
      response = JSON.parse(line) as CompanionEnvelope;
    } catch {
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error ?? "CAPABILITY_UNAVAILABLE: janitor companion request failed"));
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(operation: CompanionOperation, payload: Record<string, unknown> = {}, requestTimeoutMs = 30_000, abortOnTimeout = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CAPABILITY_UNAVAILABLE: janitor companion is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (abortOnTimeout) {
          void this.abortPendingOperation();
          return;
        }
        this.pending.delete(id);
        reject(new Error(`CAPABILITY_UNAVAILABLE: janitor companion timed out during ${operation}`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  probeCapability(): Promise<JanitorProbeResult> {
    return this.request<JanitorProbeResult>("probe");
  }

  awaitHumanAuthentication(timeoutMs?: number): Promise<JanitorProbeResult> {
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs ?? 120_000, 300_000));
    return this.request<JanitorProbeResult>("await-authentication", { timeoutMs: boundedTimeout }, boundedTimeout + 10_000);
  }

  observeAuthenticatedAccount(): Promise<JanitorAccountObservation> {
    return this.request<JanitorAccountObservation>("account");
  }

  listResources(): Promise<JanitorResourceObservation[]> {
    return this.request<JanitorResourceObservation[]>("list");
  }

  prepareExactTarget(entry: JanitorPlanEntry): Promise<PreparedRemoval | JanitorTargetOutcome> {
    return this.request<PreparedRemoval | JanitorTargetOutcome>("prepare", { entry });
  }

  confirmPreparedRemoval(prepared: PreparedRemoval, plan: JanitorCleanupPlan): Promise<JanitorTargetOutcome> {
    return this.request<JanitorTargetOutcome>("confirm", { prepared, plan }, 30_000, true);
  }

  async abortPendingOperation(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    const termination = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // A child is only considered aborted after the OS reports exit/close.
      // `child.killed` means that a signal was requested, not that the process
      // stopped; releasing the finalization lease before this point is unsafe.
      this.child.once("exit", finish);
      this.child.once("close", finish);
    });
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill(); } catch { /* escalation below still waits for actual termination */ }
    }
    const escalationTimer = setTimeout(() => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      try { this.child.kill("SIGKILL"); } catch { /* remain fail-closed until exit/close is observed */ }
    }, this.abortGraceMs);
    try {
      await termination;
    } finally {
      clearTimeout(escalationTimer);
    }
    this.failPending(new Error("CAPABILITY_UNAVAILABLE: janitor companion aborted after a destructive operation timeout"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("close");
    } catch {
      // The companion may already have exited; cleanup below is still required.
    }
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    if (!this.child.killed && this.child.exitCode === null) this.child.kill();
    this.failPending(new Error("CAPABILITY_UNAVAILABLE: janitor companion closed"));
  }
}

interface SemanticLocator {
  count(): Promise<number>;
  all(): Promise<SemanticLocator[]>;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
  click(): Promise<void>;
}

interface SemanticPage {
  goto(url: string): Promise<void>;
  url(): string;
  locator(selector: string): SemanticLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): SemanticLocator;
}

interface SemanticBrowserContext {
  pages(): SemanticPage[];
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  chromium: {
    launchPersistentContext(profileDirectory: string, options: { headless: boolean; viewport: null }): Promise<SemanticBrowserContext>;
  };
}

const requireModule = createRequire(import.meta.url);

function companionEntry(): { executable: string; args: string[] } | null {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(currentDirectory, "companion.js");
  if (fs.existsSync(compiled)) return { executable: process.execPath, args: [compiled, "--janitor-companion"] };
  const source = path.join(currentDirectory, "companion.ts");
  if (fs.existsSync(source)) return { executable: process.execPath, args: ["--import", "tsx", source, "--janitor-companion"] };
  return null;
}

/** In-process implementation used only by the child companion. */
export async function createInProcessJanitorDriver(): Promise<JanitorDriver> {
  let runtime: PlaywrightRuntime;
  try {
    runtime = requireModule("playwright") as PlaywrightRuntime;
  } catch {
    return new UnsupportedJanitorDriver("CAPABILITY_UNAVAILABLE: playwright dependency is not installed");
  }
  const profileDirectory = ensureDir(path.join(getStateDir(), "janitor-browser-profile"));
  try {
    const context = await runtime.chromium.launchPersistentContext(profileDirectory, { headless: false, viewport: null });
    return new PlaywrightJanitorDriver(context, process.env.C2C_JANITOR_EXPECTED_ACCOUNT_FINGERPRINT);
  } catch (error) {
    return new UnsupportedJanitorDriver(`CAPABILITY_UNAVAILABLE: browser launch failed: ${(error as Error).message}`);
  }
}

/**
 * Launch the explicitly selected local companion path. Surface-specific
 * selectors are intentionally capability-probed; unsupported routes never
 * fall back to private APIs or name-based selection.
 */
export async function createProductionJanitorDriver(expectedAccountFingerprint?: string): Promise<JanitorDriver> {
  const entry = companionEntry();
  if (!entry) return new UnsupportedJanitorDriver("CAPABILITY_UNAVAILABLE: janitor companion entry is unavailable");
  try {
    const env = { ...process.env };
    if (expectedAccountFingerprint) env.C2C_JANITOR_EXPECTED_ACCOUNT_FINGERPRINT = expectedAccountFingerprint;
    else delete env.C2C_JANITOR_EXPECTED_ACCOUNT_FINGERPRINT;
    const child = spawn(entry.executable, entry.args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new CompanionJanitorDriver(child);
  } catch (error) {
    return new UnsupportedJanitorDriver(`CAPABILITY_UNAVAILABLE: janitor companion launch failed: ${(error as Error).message}`);
  }
}

class PlaywrightJanitorDriver implements JanitorDriver {
  private readonly page: SemanticPage;
  private readonly tokens = new PreparedTokenRegistry();

  constructor(private readonly context: SemanticBrowserContext, private readonly expectedAccountFingerprint?: string) {
    this.page = context.pages()[0];
  }

  private profileButton(): SemanticLocator {
    return this.page.getByRole("button", { name: /profile|プロフィール|account|アカウント/i });
  }

  private async projectCollectionSurfaceCount(): Promise<number> {
    const selectors = [
      'a[href="/projects"]',
      'a[href^="/projects/"]',
      '[data-testid="projects"]',
      '[data-testid="project-list"]',
      '[aria-label="Projects"]',
      '[aria-label="プロジェクト"]',
    ];
    let count = 0;
    for (const selector of selectors) count += await this.page.locator(selector).count();
    if (count > 0) return count;
    return this.page.getByRole("navigation", { name: /projects|プロジェクト/i }).count();
  }

  private async exactProjectLink(stableId: string): Promise<SemanticLocator | null> {
    const links = await this.page.locator("a[href]").all();
    const matches: SemanticLocator[] = [];
    const expected = `/g/${stableId}`;
    for (const link of links) {
      const href = await link.getAttribute("href");
      if (typeof href === "string" && (href === expected || href.startsWith(`${expected}/`))) matches.push(link);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  private async observeProjectIdentity(stableId: string): Promise<{ stableId: string; metadata: JanitorSafeMetadata } | null> {
    const link = await this.exactProjectLink(stableId);
    if (!link) return null;
    const href = await link.getAttribute("href");
    if (typeof href !== "string" || canonicalProjectIdFromHref(href) !== stableId) return null;
    return { stableId, metadata: projectMetadataFromDom(stableId, await link.innerText()) };
  }

  async probeCapability(): Promise<JanitorProbeResult> {
    if (!this.page) return { status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: browser page is unavailable", capabilities: {} };
    try {
      await this.page.goto("https://chatgpt.com/");
      // A visible sign-in control is a human boundary. No credentials are read
      // or submitted by this companion.
      const loginControls = await this.page.locator('[data-testid="login-button"], a[href*="/auth/login"]').count();
      if (loginControls > 0) {
        return { status: "auth_required", reason: "AUTH_REQUIRED: sign in through the visible first-party page", capabilities: {} };
      }
      if (!this.page.url().startsWith("https://chatgpt.com/")) return { status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: first-party ChatGPT origin was not established", capabilities: {} };
      const projectCount = await this.page.locator('a[href*="/g/g-p-"]').count();
      const collectionSurfaceCount = await this.projectCollectionSurfaceCount();
      const projectCapability = projectCapabilityStatus(projectCount, collectionSurfaceCount);
      const profileCount = await this.profileButton().count();
      if (projectCapability !== "available" || profileCount !== 1) return {
        status: "unsupported",
        reason: "CAPABILITY_UNAVAILABLE: semantic Project/account routes are not exposed by the current surface",
        capabilities: { project: projectCapability, plugin: "unsupported", custom_mcp: "unsupported", connector: "unsupported" },
      };
      return {
        status: "available",
        reason: "semantic Project enumeration and account controls are available",
        capabilities: { project: "available", plugin: "unsupported", custom_mcp: "unsupported", connector: "unsupported" },
      };
    } catch (error) {
      return { status: "unsupported", reason: `CAPABILITY_UNAVAILABLE: semantic browser probe failed: ${(error as Error).message}`, capabilities: {} };
    }
  }

  async awaitHumanAuthentication(timeoutMs = 120_000): Promise<JanitorProbeResult> {
    const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, 300_000));
    while (Date.now() < deadline) {
      try {
        const loginControls = await this.page.locator('[data-testid="login-button"], a[href*="/auth/login"]').count();
        const profileCount = await this.profileButton().count();
        if (loginControls === 0 && profileCount === 1 && this.page.url().startsWith("https://chatgpt.com/")) return this.probeCapability();
      } catch {
        // Keep the visible page alive until the bounded timeout expires.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { status: "auth_required", reason: "AUTH_REQUIRED: complete sign-in or supported 2FA in the visible first-party browser", capabilities: {} };
  }

  async observeAuthenticatedAccount(): Promise<JanitorAccountObservation> {
    if (!this.page) return { accountFingerprint: null, status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: browser page is unavailable" };
    if (!this.expectedAccountFingerprint) return { accountFingerprint: null, status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: machine-verified account binding is unavailable" };
    try {
      const profile = this.profileButton();
      if (await profile.count() !== 1) return { accountFingerprint: null, status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: semantic account control is not exposed" };
      await profile.click();
      const evidence = this.page.locator('[role="menu"] [data-account-fingerprint]');
      const count = await evidence.count();
      const observed = count === 1 ? await evidence.getAttribute("data-account-fingerprint") : null;
      await profile.click();
      if (count !== 1 || !observed) return { accountFingerprint: null, status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: exact machine account evidence is not exposed by the semantic surface" };
      const matched = matchMachineVerifiedAccountFingerprint(this.expectedAccountFingerprint, observed);
      if (!matched) return { accountFingerprint: null, status: "unsupported", reason: "CAPABILITY_UNAVAILABLE: semantic account evidence does not match the machine binding" };
      return { accountFingerprint: matched, status: "available", reason: "machine-verified account evidence observed through an exact semantic attribute" };
    } catch (error) {
      return { accountFingerprint: null, status: "unsupported", reason: `CAPABILITY_UNAVAILABLE: account observation failed: ${(error as Error).message}` };
    }
  }

  async listResources(): Promise<JanitorResourceObservation[]> {
    const links = await this.page.locator('a[href*="/g/g-p-"]').all();
    const resources: JanitorResourceObservation[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      const href = await link.getAttribute("href");
      const stableId = typeof href === "string" ? canonicalProjectIdFromHref(href) : null;
      if (!stableId || seen.has(stableId)) continue;
      seen.add(stableId);
      const name = (await link.innerText()).trim();
      resources.push({ stableId, kind: "project", metadata: projectMetadataFromDom(stableId, name), capability: "available", classification: "active", reason: "semantic Project link observed" });
    }
    return resources;
  }

  async prepareExactTarget(entry: JanitorPlanEntry): Promise<PreparedRemoval | JanitorTargetOutcome> {
    if (entry.kind !== "project") return unsupportedOutcome(entry, "CAPABILITY_UNAVAILABLE: semantic route for this resource kind is not exposed");
    const link = await this.exactProjectLink(entry.stableId);
    if (!link) return unsupportedOutcome(entry, "ROUTE_DRIFT: exact Project link is not uniquely exposed");
    const href = await link.getAttribute("href");
    const observedId = typeof href === "string" ? canonicalProjectIdFromHref(href) : null;
    const observedMetadata = observedId ? projectMetadataFromDom(observedId, await link.innerText()) : null;
    if (observedId !== entry.stableId || !observedMetadata || !isExactMetadataMatch(observedMetadata, entry.metadata)) {
      return driftOutcome(entry, "ROUTE_DRIFT: exact Project identity or safe metadata changed during preparation");
    }
    const account = await this.observeAuthenticatedAccount();
    if (account.status !== "available" || !account.accountFingerprint) return unsupportedOutcome(entry, account.reason);
    return this.tokens.issue({ stableId: observedId, kind: entry.kind, metadata: observedMetadata, accountFingerprint: account.accountFingerprint });
  }

  async confirmPreparedRemoval(prepared: PreparedRemoval, plan: JanitorCleanupPlan): Promise<JanitorTargetOutcome> {
    const entry = plan.entries.find((candidate) => candidate.kind === prepared.kind && candidate.stableId === prepared.stableId);
    if (!entry || entry.action !== "delete" || canonicalJson(entry.metadata) !== canonicalJson(prepared.metadata)) return driftOutcome(entry ?? { stableId: prepared.stableId, kind: prepared.kind, action: "delete", metadata: prepared.metadata, protected: false, classification: "active", reason: "prepared target is not present in the reviewed plan" }, "ROUTE_DRIFT: prepared target is not present in the reviewed plan");
    let consumed: PreparedRemoval;
    try { consumed = this.tokens.consume(prepared); } catch (error) { return { stableId: prepared.stableId, kind: prepared.kind, status: "failed", reason: error instanceof Error ? error.message : String(error) }; }
    const account = await this.observeAuthenticatedAccount();
    if (account.status !== "available" || account.accountFingerprint !== consumed.accountFingerprint) return { stableId: prepared.stableId, kind: prepared.kind, status: "account_mismatch", reason: "authenticated account changed before the final semantic control" };
    if (consumed.kind !== "project") return unsupportedOutcome(entry, "CAPABILITY_UNAVAILABLE: exact removal route is not exposed");
    try {
      await this.page.goto(`https://chatgpt.com/g/${consumed.stableId}/project`);
      const observed = await this.observeProjectIdentity(consumed.stableId);
      if (!observed || !isExactMetadataMatch(observed.metadata, consumed.metadata) || !isExactMetadataMatch(observed.metadata, entry.metadata)) {
        return driftOutcome(entry, "ROUTE_DRIFT: exact Project identity or safe metadata changed before confirmation");
      }
      const action = this.page.getByRole("button", { name: /project action|プロジェクトアクション/i });
      if (await action.count() !== 1) return { stableId: prepared.stableId, kind: prepared.kind, status: "unsupported", reason: "ROUTE_DRIFT: Project action control is not uniquely exposed" };
      await action.click();
      const deleteControl = this.page.getByRole("menuitem", { name: /delete project|プロジェクトを削除/i });
      if (await deleteControl.count() !== 1) return { stableId: prepared.stableId, kind: prepared.kind, status: "unsupported", reason: "ROUTE_DRIFT: Project delete control is not uniquely exposed" };
      const finalAccount = await this.observeAuthenticatedAccount();
      if (finalAccount.status !== "available" || finalAccount.accountFingerprint !== consumed.accountFingerprint) return { stableId: prepared.stableId, kind: prepared.kind, status: "account_mismatch", reason: "authenticated account changed at the final semantic control" };
      const finalObserved = await this.observeProjectIdentity(consumed.stableId);
      if (!finalObserved || !isExactMetadataMatch(finalObserved.metadata, consumed.metadata) || !isExactMetadataMatch(finalObserved.metadata, entry.metadata)) {
        return driftOutcome(entry, "ROUTE_DRIFT: exact Project identity or safe metadata changed immediately before deletion");
      }
      await deleteControl.click();
      return { stableId: prepared.stableId, kind: prepared.kind, status: "removed", reason: "exact Project delete control activated" };
    } catch (error) {
      return { stableId: prepared.stableId, kind: prepared.kind, status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
