import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  readTunnelState,
  resolveTunnelSelection,
  TUNNEL_CHOICE_PROMPT,
  validateSetupTunnelFlag,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import {
  mergeUiPrefs,
  readUiPrefs,
  SETUP_MODES,
  TUNNEL_MODES,
  type SetupMode,
  type TunnelMode,
} from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import {
  deriveActiveCanonicalBinding,
  readDeliveryAuthorization,
  readDeliveryReceipt,
  revokeDeliveryAuthorization,
  type AuthRecoveryState,
  type DeliveryMessageType,
  type RemoteEvidenceOutcome,
  type ReconcileDeliveryInput,
  type TransportBindingIdentity,
} from "../conversation/authorization.js";
import { createDurableTransportTransaction } from "../conversation/transaction.js";
import { assertTeamAiCapabilityProvider, resolveTeamAiAuthResult, type TeamAiObservation } from "../conversation/teamai.js";
import type { GitHubOperationKind, GitHubOperationTarget } from "../conversation/operation.js";
import type { AuthorizedMessageAdapter } from "../conversation/delivery.js";
import {
  canonicalRepositoryFor,
  endpointFingerprint,
  getInstallationIdentity,
  makeConnectionBinding,
  readConnectionBinding,
  writeConnectionBinding,
  type EndpointMode,
} from "../connection/identity.js";
import {
  PROVISIONING_PHASES,
  readProvisioningState,
  writeProvisioningState,
  type ProvisioningPhase,
} from "../provisioning/state.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseProvisioningPhase(value: string): ProvisioningPhase {
  const phase = value.trim().toLowerCase() as ProvisioningPhase;
  if (!PROVISIONING_PHASES.includes(phase)) {
    throw new InvalidArgumentError(`phase must be one of ${PROVISIONING_PHASES.join(", ")}`);
  }
  return phase;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

const DELIVERY_MESSAGE_TYPES: readonly DeliveryMessageType[] = ["INIT", "HANDOFF", "PLAN", "EXECUTED", "REVIEW", "RE_REVIEW"];
const REMOTE_EVIDENCE_OUTCOMES: readonly RemoteEvidenceOutcome[] = ["accepted", "pending", "definite_not_accepted", "ambiguous", "failed"];
const AUTH_RECOVERY_STATES: readonly AuthRecoveryState[] = [
  "AUTHORIZED_OPERATION_PREPARED",
  "INTERRUPTED_AUTH_PENDING",
  "AUTH_CONTEXT_RECONCILING",
  "TEAMAI_RECOVERY_ACTIVE",
  "AUTH_HEALTHY",
  "REMOTE_RECONCILING",
  "RESUME_ONCE",
  "COMPLETED",
  "WAITING_HUMAN_SECURITY_BOUNDARY",
];
const GITHUB_OPERATION_KINDS: readonly GitHubOperationKind[] = ["issue_create", "issue_update", "push", "pr_create", "pr_update", "review", "publication"];

function readJsonRecord(fileName: string, maxBytes = 256 * 1024): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCappedUtf8(path.resolve(fileName), maxBytes)) as unknown;
  } catch {
    throw new Error(`invalid JSON input: ${path.basename(fileName)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`JSON input must be an object: ${path.basename(fileName)}`);
  return parsed as Record<string, unknown>;
}

function requiredJsonString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${source} requires string field ${key}`);
  return value.trim();
}

function optionalJsonString(record: Record<string, unknown>, key: string, source: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${source} field ${key} must be a non-empty string`);
  return value.trim();
}

function teamAiRepositoryCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.TEAMAI_REPO?.trim()) candidates.push(path.resolve(process.env.TEAMAI_REPO));
  const profile = process.env.USERPROFILE?.trim();
  if (profile) {
    const config = path.join(profile, ".teamai", "config.yaml");
    if (fs.existsSync(config)) {
      const configured = fs.readFileSync(config, "utf8").match(/^\s*localPath\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
      if (configured) candidates.push(path.resolve(configured.replace(/^~[\\/]/, `${profile}${path.sep}`)));
    }
    candidates.push(path.join(profile, ".teamai", "team-repo"));
  }
  return [...new Set(candidates)];
}

function assertTeamAiProviderModule(fileName: string): string {
  const resolved = path.resolve(fileName);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    throw new Error("TeamAI github-cli-auth provider module is unavailable");
  }
  const normalized = process.platform === "win32" ? real.toLowerCase() : real;
  const accepted = teamAiRepositoryCandidates().some((candidate) => {
    try {
      const root = fs.realpathSync.native(candidate);
      const rootNormalized = process.platform === "win32" ? root.toLowerCase() : root;
      const relative = path.relative(rootNormalized, normalized);
      return !relative.startsWith("..") && !path.isAbsolute(relative) && relative.replace(/\\/g, "/").toLowerCase().includes("skills/github-cli-auth/");
    } catch {
      return false;
    }
  });
  if (!accepted) throw new Error("TeamAI provider module must come from the resolved github-cli-auth Skill boundary");
  return real;
}

function parseTeamAiObservationInput(fileName: string): TeamAiObservation {
  const source = path.basename(fileName);
  const raw = readJsonRecord(fileName);
  if (Object.prototype.hasOwnProperty.call(raw, "classification")) {
    throw new Error(`${source} must not contain a classification; TeamAI must supply it`);
  }
  return {
    correlationId: requiredJsonString(raw, "correlationId", source),
    ...(optionalJsonString(raw, "restrictedContextError", source) ? { restrictedContextError: optionalJsonString(raw, "restrictedContextError", source) } : {}),
    ...(optionalJsonString(raw, "expectedAccount", source) ? { expectedAccount: optionalJsonString(raw, "expectedAccount", source) } : {}),
    ...(optionalJsonString(raw, "credentialVisibleAccount", source) ? { credentialVisibleAccount: optionalJsonString(raw, "credentialVisibleAccount", source) } : {}),
    ...(optionalJsonString(raw, "authAttemptId", source) ? { authAttemptId: optionalJsonString(raw, "authAttemptId", source) } : {}),
  };
}

function parseBindingInput(fileName: string): TransportBindingIdentity {
  const source = path.basename(fileName);
  const raw = readJsonRecord(fileName);
  const binding: TransportBindingIdentity = {
    workspaceId: requiredJsonString(raw, "workspaceId", source),
    taskId: requiredJsonString(raw, "taskId", source),
    checkpoint: requiredJsonString(raw, "checkpoint", source),
    stage: requiredJsonString(raw, "stage", source),
    eventKey: requiredJsonString(raw, "eventKey", source),
  };
  for (const key of [
    "workstreamId", "workspaceName", "workspaceRoot", "canonicalRepository", "worktreeRoot", "branch", "observedCommit",
    "installationId", "endpointFingerprint", "connectorName", "mcpAppId", "mcpVersionId", "projectId", "chatId",
    "codexSessionId", "expectedAccount", "authAttemptId",
  ] as const) {
    const value = optionalJsonString(raw, key, source);
    if (value !== undefined) binding[key] = value;
  }
  const dirtyState = raw.dirtyState;
  if (dirtyState !== undefined) {
    if (dirtyState !== "clean" && dirtyState !== "dirty" && dirtyState !== "unknown") throw new Error(`${source} field dirtyState is invalid`);
    binding.dirtyState = dirtyState;
  }
  return binding;
}

function parseDeliveryMessageType(value: string): DeliveryMessageType {
  if (!DELIVERY_MESSAGE_TYPES.includes(value as DeliveryMessageType)) throw new InvalidArgumentError(`message type must be one of ${DELIVERY_MESSAGE_TYPES.join(", ")}`);
  return value as DeliveryMessageType;
}

function parseRemoteEvidenceOutcome(value: string): RemoteEvidenceOutcome {
  if (!REMOTE_EVIDENCE_OUTCOMES.includes(value as RemoteEvidenceOutcome)) throw new InvalidArgumentError(`outcome must be one of ${REMOTE_EVIDENCE_OUTCOMES.join(", ")}`);
  return value as RemoteEvidenceOutcome;
}

function parseAuthRecoveryState(value: string): AuthRecoveryState {
  if (!AUTH_RECOVERY_STATES.includes(value as AuthRecoveryState)) throw new InvalidArgumentError(`auth state must be one of ${AUTH_RECOVERY_STATES.join(", ")}`);
  return value as AuthRecoveryState;
}

function parseOperationTargetInput(fileName: string): GitHubOperationTarget {
  const source = path.basename(fileName);
  const raw = readJsonRecord(fileName);
  const kind = requiredJsonString(raw, "kind", source) as GitHubOperationKind;
  if (!GITHUB_OPERATION_KINDS.includes(kind)) throw new Error(`${source} field kind is invalid`);
  const target: GitHubOperationTarget = {
    kind,
    repository: requiredJsonString(raw, "repository", source),
    logicalOperationId: requiredJsonString(raw, "logicalOperationId", source),
  };
  for (const key of ["ref", "expectedCommit", "expectedContentHash", "expectedRevision", "headRef", "baseRef", "marker"] as const) {
    const value = optionalJsonString(raw, key, source);
    if (value !== undefined) target[key] = value;
  }
  for (const key of ["issueNumber", "pullRequestNumber"] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${source} field ${key} must be a positive integer`);
    target[key] = value;
  }
  return target;
}

function parseOperationObservationInput(fileName: string): NonNullable<ReconcileDeliveryInput["operationObservation"]> {
  const source = path.basename(fileName);
  const raw = readJsonRecord(fileName);
  const observation: Record<string, unknown> = {};
  for (const key of ["remoteId", "remoteUrl", "observedRepository", "observedCommit", "observedRef", "observedHeadRef", "observedBaseRef", "observedPayloadHash", "observedRevision", "observedMarker"] as const) {
    const value = optionalJsonString(raw, key, source);
    if (value !== undefined) observation[key] = value;
  }
  for (const key of ["observedIssueNumber", "observedPullRequestNumber", "candidateCount"] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${source} field ${key} must be a non-negative integer`);
    observation[key] = value;
  }
  if (raw.absenceProven !== undefined) {
    if (typeof raw.absenceProven !== "boolean") throw new Error(`${source} field absenceProven must be boolean`);
    observation.absenceProven = raw.absenceProven;
  }
  if (raw.payloadHash !== undefined) observation.payloadHash = requiredJsonString(raw, "payloadHash", source);
  return observation as NonNullable<ReconcileDeliveryInput["operationObservation"]>;
}

function requireAuthorizedMessageAdapter(value: unknown): AuthorizedMessageAdapter {
  if (!value || typeof value !== "object" || typeof (value as { sendMessage?: unknown }).sendMessage !== "function") {
    throw new Error("adapter module must export an AuthorizedMessageAdapter");
  }
  return value as AuthorizedMessageAdapter;
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  endpointMode?: EndpointMode;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const installation = getInstallationIdentity();
  const endpointMode = opts.endpointMode ?? "ephemeral";
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
    installationId: installation.installationId,
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    workspace: opts.workspaceName,
    canonicalRepository: canonicalRepositoryFor(opts.workspaceRoot),
    installationId: installation.installationId,
    endpointMode,
    endpointFingerprint: endpointFingerprint(opts.mcpUrl, endpointMode),
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  writeConnectionBinding(
    makeConnectionBinding({
      workspaceId: opts.workspaceId,
      workspace: opts.workspaceName,
      workspaceRoot: opts.workspaceRoot,
      endpoint: opts.mcpUrl,
      endpointMode,
      connectorName,
    })
  );
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const selection = resolveTunnelSelection(state, readUiPrefs());
  const zone = parseZoneInput(zoneHint ?? "") ?? selection.zone ?? state.zone ?? null;
  const needsChoice = selection.mode === null || (selection.mode === "named" && !zone);
  return {
    ok: true,
    needsChoice,
    preference: state.preference,
    resolvedMode: selection.mode,
    resolvedSource: selection.source,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsChoice ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

/** Apply the resolved machine/TeamAI default before a bridge is started. */
async function applyResolvedTunnelSelection(workspaceRoot: string): Promise<{ changed: boolean }> {
  const workspace = new Workspace(workspaceRoot);
  const previous = readTunnelState(workspace.id);
  const selection = resolveTunnelSelection(previous, readUiPrefs());
  if (!selection.mode) return { changed: false };

  if (selection.mode === "quick") {
    const alreadySelected =
      previous.preference === "quick" &&
      previous.selectionSource === selection.source &&
      !previous.fallbackReason;
    if (alreadySelected) return { changed: false };
    chooseQuickTunnel(workspace.id, undefined, selection.source);
    return { changed: previous.preference !== "quick" || previous.selectionSource !== selection.source };
  }

  if (!selection.zone) return { changed: false };
  if (
    isNamedTunnelReady(previous) &&
    previous.zone === selection.zone &&
    (previous.selectionSource === selection.source || previous.selectionSource === undefined || previous.selectionSource === "workspace")
  ) {
    return { changed: false };
  }
  if (!hasCloudflaredCert()) {
    if (!detectTunnelBinaries().cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    throw new Error(`NEED_CLOUDFLARE_LOGIN: ${NAMED_LOGIN_PROMPT}`);
  }
  const result = await provisionNamedTunnel({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    zone: selection.zone,
    selectionSource: selection.source,
    // The TeamAI/machine named defaults explicitly permit a temporary local
    // fallback after a real provisioning failure.  A workspace's explicit
    // named choice remains fail-closed unless its caller opts in.
    allowQuickFallback: selection.source === "teamai" || selection.source === "machine",
  });
  if (!result.ok && !result.fallback) {
    throw new Error(
      result.error?.startsWith("NEED_CLOUDFLARE_LOGIN")
        ? result.error
        : `NAMED_PROVISION_FAILED: ${result.error ?? "named tunnel provisioning failed"}`
    );
  }
  return { changed: !result.fallback };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  if (opts.tunnel) {
    const selection = await applyResolvedTunnelSelection(workspaceRoot);
    if (selection.changed) {
      const workspace = new Workspace(workspaceRoot);
      if (await findLiveBridge(workspace.id)) await stopBridge(workspaceRoot);
    }
  }
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

/** Machine-wide commands ignore `-w` so old Skills/sessions cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceRoot: root,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`現在のプロジェクトを確認しました（${info.workspaceName}）`);
      check("Workspace Bridge を起動しました");
      if (mcpUrl) check("安全な接続を確立しました");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("ChatGPT に接続しています…");
        say("");
      }
      const workspace = new Workspace(root);
      const previousProvisioning = readProvisioningState(workspace.id);
      writeProvisioningState(workspace.id, previousProvisioning ? "repairing" : "uninitialized", {
        reason: "setup or recovery started",
        retryCount: previousProvisioning?.retryCount ?? 0,
      });
      const state = readTunnelState(workspace.id);
      const policy = resolveTunnelSelection(state, readUiPrefs());
      const needsChoice = policy.mode === null || (policy.mode === "named" && !policy.zone);
      if (needsChoice && opts.tunnel) {
        throw new Error(`NEED_TUNNEL_CHOICE: ${TUNNEL_CHOICE_PROMPT}`);
      }
      validateSetupTunnelFlag(policy, opts.tunnel);
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      writeProvisioningState(workspace.id, info.tokenCount > 0 ? "authenticated" : "runtime_ready", {
        reason: info.tokenCount > 0 ? "local bridge and authorization are available" : "local bridge is ready",
      });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceRoot: root,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
            installationId: getInstallationIdentity().installationId,
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`現在のプロジェクトを確認しました（${info.workspaceName}）`);
      check("Workspace Bridge を起動しました");
      if (mcpUrl) check("安全な接続を確立しました");
      say("");
      say(`接続先URL：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`ペアリングコード：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分間有効）`);
      say("");
      say("次の手順：ChatGPT のコネクタ設定で上記URLをOAuthとして追加し、認証ページでペアリングコードを入力してください。");
      say("Codex Skill を使用している場合、この手順は自動で完了します。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge を停止しました");
    else say("実行中の Bridge はありません。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge を再起動しました（${info.workspaceName}）`);
      if (mcpUrl) check(`安全な接続を確立しました`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge の状態を確認できません（${observation.reason}）。停止中とは扱わず、自動修復は行いません。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge は実行されていません。`c2c start` で起動してください。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    const provisioning = readProvisioningState(workspace.id);
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info, provisioning }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：実行中（ポート ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全な接続：${info.tunnel.url}/mcp`);
    else say("· 安全な接続：未有効（ローカルモード）");
    say(`· 認証済み接続：${info.tokenCount > 0 ? "はい" : "いいえ"}`);
    if (provisioning) say(`· セットアップ状態：${provisioning.phase}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "許可リスト登録済み" : "許可リストに登録済み" };
        if (sandbox.added) results.push("ローカル設定ディレクトリを Codex サンドボックスの許可リストに追加しました");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "許可リスト登録済み" } : { ok: false, detail: "許可リスト未登録" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let authorizedTokenCount: number | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状態を確認できません（${observation.reason}）。自動修復は行いません` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("Bridge を自動起動しました");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `ポート ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "実行されていません" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未認証リクエストの応答：${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
          installationId: getInstallationIdentity().installationId,
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      authorizedTokenCount = info.tokenCount;
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("固定ドメイン接続に切り替えました");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "安全な接続を再確立しました" : "安全な接続を再確立しました（アドレスが変更されました）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceRoot: root,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              endpointMode: namedReady ? "stable" : "ephemeral",
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          results.push(`安全な接続先が変更されました。「${boundName}」を更新してください`);
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全な接続を復旧できません" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未有効（ローカルモード）" };
      } else {
        report.tunnel = { ok: false, detail: "公開アドレスにアクセスできません" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge の状態を確認できないため、コネクタ修復は実行しません" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全な接続が実行されていません" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    // Persist only observable setup state. A previously verified ready state is
    // reusable in a new Codex session while any local health failure is degraded.
    if (workspace) {
      const previousProvisioning = readProvisioningState(workspace.id);
      const localHealthy =
        report.workspace?.ok === true && report.bridge?.ok === true && report.mcp?.ok === true && report.tunnel?.ok === true;
      const retainedVerifiedPhase =
        previousProvisioning &&
        ["connector_ready", "project_binding", "workspace_verification", "ready"].includes(previousProvisioning.phase)
          ? previousProvisioning.phase
          : null;
      const phase: ProvisioningPhase = !localHealthy
        ? "degraded"
        : chatgptRepair.needed
          ? "repairing"
          : retainedVerifiedPhase ?? (authorizedTokenCount && authorizedTokenCount > 0 ? "authenticated" : "runtime_ready");
      writeProvisioningState(workspace.id, phase, {
        reason: chatgptRepair.needed ? chatgptRepair.reason : localHealthy ? "doctor verification" : "local health check failed",
        retryCount: previousProvisioning?.retryCount ?? 0,
      });
    }

    if (opts.json) {
      say(JSON.stringify({
        report,
        repairs: results,
        chatgptRepair,
        namedRepair,
        provisioning: workspace ? readProvisioningState(workspace.id) : null,
      }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新しい接続先URL：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`ペアリングコード：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "ローカル環境は準備済みです。ChatGPT でこの接続を削除して再追加してください。"
          : namedRepair.needed
            ? "固定ドメインに接続できません。まず Cloudflare にログインしてください。"
            : "問題が残っています。`c2c restart --tunnel` を試してください。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`ペアリングコード：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分間有効。一度だけ使用できます）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("ChatGPT から現在のプロジェクトへのアクセスを切断しました（すべてのトークンを無効化済み）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("ログはありません。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`種類：${data.projectType}  言語：${data.languages.join(", ") || "-"}`);
      say(`パス：${data.root}`);
    }
  });

// ---------------------------------------------------------------- identity

program
  .command("identity")
  .description("Show the user-local connection identity for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const installation = getInstallationIdentity();
      const endpoint = readLastEndpoint(workspace.id);
      const binding = readConnectionBinding(workspace.id);
      const data = {
        ok: true,
        workspaceId: workspace.id,
        workspace: workspace.name,
        canonicalRepository: canonicalRepositoryFor(workspace.root),
        installationId: installation.installationId,
        endpointMode: endpoint?.endpointMode ?? binding?.endpointMode ?? "local",
        endpointFingerprint: endpoint?.endpointFingerprint ?? binding?.endpointFingerprint ?? null,
        connectorName: endpoint?.connectorName ?? binding?.connectorName ?? null,
        binding: binding
          ? {
              workspace: binding.workspace,
              canonicalRepository: binding.canonicalRepository,
              installationId: binding.installationId,
              endpointMode: binding.endpointMode,
              endpointFingerprint: binding.endpointFingerprint,
              connectorName: binding.connectorName,
              projectId: binding.projectId ?? null,
            }
          : null,
      };
      if (opts.json) say(JSON.stringify(data));
      else {
        say(`Workspace：${data.workspace}（${data.workspaceId}）`);
        say(`Repository：${data.canonicalRepository}`);
        say(`Installation：${data.installationId.slice(0, 8)}`);
        say(`Connector：${data.connectorName ?? "未登録"}`);
        say(`Endpoint：${data.endpointMode}（${data.endpointFingerprint ?? "未登録"}）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`Codex サンドボックスの許可リストに書き込めません：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("サンドボックスの許可リストは準備済みです。以後の会話で追加権限は不要です");
    else check("ローカル設定ディレクトリを Codex サンドボックスの許可リストに追加しました（以後の会話で追加権限は不要です）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`新しいバージョンがあります（ローカル ${data.localCommit?.slice(0, 7)} → リモート ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "最新バージョンです。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "本日はすでに更新を確認しています。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "更新を確認できないため（オフラインまたはGit以外のインストール）、スキップしました。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("ChatGPT セッションはまだ記録されていません。新しいリポジトリではProjectを既定で使用します。");
    } else {
      say(`モード：${conversation.mode === "project" ? "Project" : "長いチャット"}`);
      if (conversation.projectUrl) say(`Project：${conversation.projectUrl}`);
      if (saved.title) say(`セッション：${saved.title}`);
      if (saved.url) say(`チャット：${saved.url}`);
      if (saved.connectorName) say(`コネクタ：${saved.connectorName}`);
      if (saved.taskId) say(`タスク：${saved.taskId}（${saved.iteration ?? 0}回目、${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `チェックポイント：${saved.checkpoint.protocolState} / 待機対象 ${saved.checkpoint.waitingFor}（${saved.checkpoint.iteration}回目）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("ChatGPT Projectを記録しました。以後はProjectページから新規または既存のチャットを使用します");
      } else {
        check("ChatGPT セッションを記録しました。以後のタスクで再利用します");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("ChatGPT セッションはまだ記録されていません。");
    else if (result.keptProject) check("現在のチャットを消去しました。Projectの紐付けは維持されています");
    else check("セッション記録を消去しました。次のタスクで新しいChatGPTチャットを作成します");
  });

// ---------------------------------------------------------------- provisioning (machine-local setup state)

const provisioning = program
  .command("provisioning")
  .description("Show or update machine-local C2C setup state");

provisioning
  .command("get", { isDefault: true })
  .description("Show the saved setup phase")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const state = readProvisioningState(workspace.id);
    if (opts.json) {
      say(JSON.stringify({ ok: true, workspaceId: workspace.id, state }));
      return;
    }
    if (!state) say("セットアップ状態は未初期化です。");
    else {
      say(`状態：${state.phase}`);
      if (state.reason) say(`理由：${state.reason}`);
    }
  });

provisioning
  .command("set")
  .description("Record an observed setup phase after live verification")
  .option("-w, --workspace <path>")
  .requiredOption("--phase <phase>", `one of ${PROVISIONING_PHASES.join(", ")}`)
  .option("--reason <text>")
  .option("--retry-count <n>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; phase: string; reason?: string; retryCount?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const state = writeProvisioningState(workspace.id, parseProvisioningPhase(opts.phase), {
      reason: opts.reason,
      retryCount: opts.retryCount === undefined ? undefined : parseNonNegativeInteger(opts.retryCount),
    });
    if (opts.json) say(JSON.stringify({ ok: true, workspaceId: workspace.id, state }));
    else check(`セットアップ状態を記録しました（${state.phase}）`);
  });

// ---------------------------------------------------------------- transport (internal durable recovery inspection)

const transport = program
  .command("transport", { hidden: true })
  .description("Inspect or revoke one durable authorized C2C delivery");

transport
  .command("begin")
  .description("Issue canonical workflow authority and prepare one durable delivery")
  .option("-w, --workspace <path>", "active workspace root; authority is derived from its harness state")
  .requiredOption("--binding-file <path>", "JSON file containing the exact transport binding")
  .requiredOption("--message-type <type>", "EXECUTED, REVIEW, or RE_REVIEW")
  .requiredOption("--stage <stage>")
  .option("--workflow-step <n>", "canonical workflow step", "5")
  .option("--issuer-id <id>", "bounded issuer identifier", "c2c-cli")
  .option("--source-checkpoint <checkpoint>")
  .option("--source-stage <stage>")
  .option("--event-key <key>")
  .requiredOption("--payload-hash <hash>")
  .option("--operation-target-file <path>", "JSON GitHub operation target")
  .option("--expires-at <timestamp>")
  .option("--process-id <id>")
  .option("--session-id <id>")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    bindingFile: string;
    messageType: string;
    stage: string;
    workflowStep: string;
    issuerId: string;
    sourceCheckpoint?: string;
    sourceStage?: string;
    eventKey?: string;
    payloadHash: string;
    operationTargetFile?: string;
    expiresAt?: string;
    processId?: string;
    sessionId?: string;
    json: boolean;
  }) => {
    try {
      const activeWorkspace = new Workspace(resolveWorkspace(opts.workspace));
      const binding = deriveActiveCanonicalBinding({
        workspaceRoot: activeWorkspace.root,
        workspaceId: activeWorkspace.id,
        candidate: parseBindingInput(opts.bindingFile),
      });
      const messageType = parseDeliveryMessageType(opts.messageType);
      const workflowStep = parseInteger(opts.workflowStep);
      if (opts.eventKey?.trim() && opts.eventKey.trim() !== binding.eventKey) throw new Error("event key must match the canonical workflow action");
      if (opts.sourceCheckpoint?.trim() && opts.sourceCheckpoint.trim() !== binding.checkpoint) throw new Error("source checkpoint must match the canonical workflow checkpoint");
      if (opts.stage !== binding.stage || (opts.sourceStage?.trim() && opts.sourceStage.trim() !== binding.stage)) throw new Error("stage must match the canonical workflow state");
      const eventKey = binding.eventKey;
      const sourceCheckpoint = binding.checkpoint;
      const sourceStage = binding.stage;
      const operationTarget = opts.operationTargetFile ? parseOperationTargetInput(opts.operationTargetFile) : undefined;
      const result = createDurableTransportTransaction().beginAndPrepare({
        workflowStep,
        stage: opts.stage,
        issuerId: opts.issuerId,
        messageType,
        binding,
        sourceCheckpoint,
        sourceStage,
        eventKey,
        payloadHash: opts.payloadHash,
        ...(operationTarget ? { operationTarget } : {}),
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
        ...(opts.processId ? { processId: opts.processId } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      });
      const payload = {
        ok: true,
        eventKey,
        messageType,
        authorityId: result.authorization.authorityId,
        authorizationGeneration: result.authorization.generation,
        receiptGeneration: result.receipt.generation,
        receiptState: result.receipt.state,
        operationKey: result.authorization.operationKey ?? null,
      };
      if (opts.json) say(JSON.stringify(payload));
      else check(`永続配送を準備しました（${eventKey} / ${result.receipt.state}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("deliver")
  .description("Run one authorized delivery through an injected IAB adapter")
  .requiredOption("--binding-file <path>")
  .requiredOption("--event-key <key>")
  .requiredOption("--task-id <id>")
  .requiredOption("--iteration <n>", "non-negative delivery iteration", parseNonNegativeInteger)
  .requiredOption("--message-id <id>")
  .requiredOption("--text-file <path>", "control envelope text file")
  .requiredOption("--adapter-module <path>", "local module exporting an IAB AuthorizedMessageAdapter")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    bindingFile: string;
    eventKey: string;
    taskId: string;
    iteration: number;
    messageId: string;
    textFile: string;
    adapterModule: string;
    json: boolean;
  }) => {
    try {
      const authorization = readDeliveryAuthorization(opts.eventKey);
      if (!authorization) throw new Error("delivery authorization record not found");
      const binding = parseBindingInput(opts.bindingFile);
      if (binding.eventKey !== opts.eventKey || authorization.eventKey !== opts.eventKey) throw new Error("delivery event key does not match the exact binding");
      const loaded = await import(pathToFileURL(path.resolve(opts.adapterModule)).href);
      const adapter = requireAuthorizedMessageAdapter(loaded.default ?? loaded.adapter);
      const text = readCappedUtf8(path.resolve(opts.textFile), 64 * 1024);
      const transaction = createDurableTransportTransaction();
      const outcome = await transaction.deliver({
        taskId: opts.taskId,
        iteration: opts.iteration,
        messageId: opts.messageId,
        text,
        workspaceId: binding.workspaceId,
        workstreamId: binding.workstreamId,
        binding,
        authorization,
        messageType: authorization.messageType,
        payloadHash: authorization.payloadHash,
        ...(authorization.operationTarget ? { operationTarget: authorization.operationTarget } : {}),
      }, adapter);
      const payload = { ok: true, result: outcome.result, state: outcome.state, eventKey: opts.eventKey, sendAttempts: outcome.receipt?.sendAttempts ?? outcome.checkpoint.sendAttempts, receiptState: outcome.receipt?.state ?? null, reason: outcome.reason ?? null };
      if (opts.json) say(JSON.stringify(payload));
      else check(`配送処理を実行しました（${opts.eventKey} / ${outcome.result}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("observe")
  .description("Record bounded browser evidence for one prepared delivery")
  .requiredOption("--binding-file <path>")
  .requiredOption("--event-key <key>")
  .requiredOption("--outcome <outcome>", "visible | ambiguous | definite_failure")
  .option("--remote-id <id>")
  .option("--evidence-hash <hash>")
  .option("--observed-event-key <key>")
  .option("--observed-payload-hash <hash>")
  .option("--reason <text>")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    bindingFile: string;
    eventKey: string;
    outcome: string;
    remoteId?: string;
    evidenceHash?: string;
    observedEventKey?: string;
    observedPayloadHash?: string;
    reason?: string;
    json: boolean;
  }) => {
    try {
      const authorization = readDeliveryAuthorization(opts.eventKey);
      if (!authorization) throw new Error("delivery authorization record not found");
      const outcome = opts.outcome as "visible" | "ambiguous" | "definite_failure";
      if (outcome !== "visible" && outcome !== "ambiguous" && outcome !== "definite_failure") throw new InvalidArgumentError("outcome must be visible, ambiguous, or definite_failure");
      const receipt = createDurableTransportTransaction().observeVisible({
        authorization,
        binding: parseBindingInput(opts.bindingFile),
        outcome,
        ...(opts.remoteId ? { remoteId: opts.remoteId } : {}),
        ...(opts.evidenceHash ? { evidenceHash: opts.evidenceHash } : {}),
        ...(opts.observedEventKey ? { observedEventKey: opts.observedEventKey } : {}),
        ...(opts.observedPayloadHash ? { observedPayloadHash: opts.observedPayloadHash } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      const payload = { ok: true, eventKey: receipt.eventKey, state: receipt.state, generation: receipt.generation, sendAttempts: receipt.sendAttempts };
      if (opts.json) say(JSON.stringify(payload));
      else check(`配送観測を記録しました（${receipt.eventKey} / ${receipt.state}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("reconcile")
  .description("Reconcile one remote operation before any continuation")
  .requiredOption("--binding-file <path>")
  .requiredOption("--event-key <key>")
  .requiredOption("--outcome <outcome>", "accepted | pending | definite_not_accepted | ambiguous | failed")
  .option("--operation-observation-file <path>", "JSON operation-specific remote proof")
  .option("--remote-id <id>")
  .option("--status <status>")
  .option("--target <target>")
  .option("--evidence-hash <hash>")
  .option("--reason <text>")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    bindingFile: string;
    eventKey: string;
    outcome: string;
    operationObservationFile?: string;
    remoteId?: string;
    status?: string;
    target?: string;
    evidenceHash?: string;
    reason?: string;
    json: boolean;
  }) => {
    try {
      const authorization = readDeliveryAuthorization(opts.eventKey);
      if (!authorization) throw new Error("delivery authorization record not found");
      const outcome = parseRemoteEvidenceOutcome(opts.outcome);
      const receipt = createDurableTransportTransaction().reconcile({
        authorization,
        binding: parseBindingInput(opts.bindingFile),
        outcome,
        ...(opts.operationObservationFile ? { operationObservation: parseOperationObservationInput(opts.operationObservationFile) } : {}),
        ...(opts.remoteId ? { remoteId: opts.remoteId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.evidenceHash ? { evidenceHash: opts.evidenceHash } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      const payload = { ok: true, eventKey: receipt.eventKey, state: receipt.state, generation: receipt.generation, reconciliationAttempts: receipt.reconciliationAttempts, operationOutcome: receipt.operationEvidence?.outcome ?? null };
      if (opts.json) say(JSON.stringify(payload));
      else check(`リモート照合を記録しました（${receipt.eventKey} / ${receipt.state}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("auth-observe")
  .description("Pass TeamAI github-cli-auth observations to its resolved capability boundary")
  .requiredOption("--binding-file <path>")
  .requiredOption("--event-key <key>")
  .requiredOption("--state <state>")
  .requiredOption("--provider-module <path>", "TeamAI-owned provider module under the resolved github-cli-auth Skill")
  .requiredOption("--observation-file <path>", "bounded observations; classification is prohibited")
  .option("--reason <text>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { bindingFile: string; eventKey: string; state: string; providerModule: string; observationFile: string; reason?: string; json: boolean }) => {
    try {
      const authorization = readDeliveryAuthorization(opts.eventKey);
      if (!authorization) throw new Error("delivery authorization record not found");
      const providerPath = assertTeamAiProviderModule(opts.providerModule);
      const loaded = await import(pathToFileURL(providerPath).href);
      const provider = loaded.default ?? loaded.provider;
      assertTeamAiCapabilityProvider(provider);
      const observation = parseTeamAiObservationInput(opts.observationFile);
      const receipt = createDurableTransportTransaction().observeTeamAi({
        authorization,
        binding: parseBindingInput(opts.bindingFile),
        state: parseAuthRecoveryState(opts.state),
        capabilityResult: resolveTeamAiAuthResult(provider, observation),
        ...(observation.expectedAccount ? { expectedAccount: observation.expectedAccount } : {}),
        ...(observation.authAttemptId ? { authAttemptId: observation.authAttemptId } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      const payload = { ok: true, eventKey: receipt.eventKey, state: receipt.state, generation: receipt.generation, authRecovery: receipt.authRecovery ? { state: receipt.authRecovery.state, classifier: receipt.authRecovery.classifier, classification: receipt.authRecovery.classification ?? null } : null };
      if (opts.json) say(JSON.stringify(payload));
      else check(`TeamAI 認証観測を記録しました（${receipt.eventKey}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("response")
  .description("Consume one exact visible reviewer response")
  .requiredOption("--binding-file <path>")
  .requiredOption("--event-key <key>")
  .requiredOption("--response-key <key>")
  .requiredOption("--response-hash <hash>")
  .option("--json", "machine-readable output", false)
  .action((opts: { bindingFile: string; eventKey: string; responseKey: string; responseHash: string; json: boolean }) => {
    try {
      const authorization = readDeliveryAuthorization(opts.eventKey);
      if (!authorization) throw new Error("delivery authorization record not found");
      const receipt = createDurableTransportTransaction().consumeResponse({
        authorization,
        binding: parseBindingInput(opts.bindingFile),
        responseKey: opts.responseKey,
        responseHash: opts.responseHash,
      });
      const payload = { ok: true, eventKey: receipt.eventKey, state: receipt.state, generation: receipt.generation, responseConsumedAt: receipt.responseConsumedAt ?? null };
      if (opts.json) say(JSON.stringify(payload));
      else check(`レビュー応答を一度だけ消費しました（${receipt.eventKey}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

transport
  .command("status", { isDefault: true })
  .description("Show sanitized authorization and receipt state for one event")
  .requiredOption("--event-key <key>")
  .option("--json", "machine-readable output", false)
  .action((opts: { eventKey: string; json: boolean }) => {
    const authorization = readDeliveryAuthorization(opts.eventKey);
    const receipt = readDeliveryReceipt(opts.eventKey);
    const payload = {
      ok: Boolean(authorization || receipt),
      eventKey: opts.eventKey,
      authorization: authorization
        ? {
            generation: authorization.generation,
            authorityId: authorization.authorityId,
            messageType: authorization.messageType,
            operationKey: authorization.operationKey ?? null,
            revokedAt: authorization.revokedAt ?? null,
            expiresAt: authorization.expiresAt ?? null,
          }
        : null,
      receipt: receipt
        ? {
            generation: receipt.generation,
            state: receipt.state,
            sendAttempts: receipt.sendAttempts,
            reconciliationAttempts: receipt.reconciliationAttempts,
            operationKey: receipt.operationKey ?? null,
            responseConsumedAt: receipt.responseConsumedAt ?? null,
            nextAction: receipt.nextAction ?? null,
            authRecovery: receipt.authRecovery
              ? {
                  state: receipt.authRecovery.state,
                  classifier: receipt.authRecovery.classifier,
                  classification: receipt.authRecovery.classification ?? null,
                  authAttemptId: receipt.authRecovery.authAttemptId ?? null,
                }
              : null,
          }
        : null,
    };
    if (opts.json) {
      say(JSON.stringify(payload));
      return;
    }
    if (!payload.ok) {
      say("永続化された配送記録はありません。");
      return;
    }
    say(`イベント：${opts.eventKey}`);
    if (payload.authorization) say(`権限：${payload.authorization.messageType} / generation ${payload.authorization.generation}`);
    if (payload.receipt) say(`Receipt：${payload.receipt.state} / generation ${payload.receipt.generation}`);
  });

transport
  .command("revoke")
  .description("Revoke one persisted delivery authority without deleting its evidence")
  .requiredOption("--event-key <key>")
  .option("--json", "machine-readable output", false)
  .action((opts: { eventKey: string; json: boolean }) => {
    const authorization = readDeliveryAuthorization(opts.eventKey);
    if (!authorization) throw new Error("delivery authorization record not found");
    const revoked = revokeDeliveryAuthorization(authorization);
    const payload = { ok: true, eventKey: revoked.eventKey, generation: revoked.generation, revokedAt: revoked.revokedAt ?? null };
    if (opts.json) say(JSON.stringify(payload));
    else check(`配送権限を失効させました（${revoked.eventKey}）`);
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT and C2C setup choices for this machine");

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT and C2C setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "開発者モード：有効として記録済み" : "開発者モード：未記録");
    if (prefs.setupMode === "auto") say("設定方式：AI自動設定（プレビュー版）");
    else if (prefs.setupMode === "manual") say("設定方式：手動ガイド設定");
    else say("設定方式：未選択");
    if (prefs.defaultTunnelMode) say(`安全な接続の既定：${prefs.defaultTunnelMode}`);
    if (prefs.defaultTunnelZone) say(`安全な接続の既定ドメイン：${prefs.defaultTunnelZone}`);
    if (prefs.tunnelModeOverride) say(`この端末の上書き：${prefs.tunnelModeOverride}`);
    if (prefs.tunnelZoneOverride) say(`この端末の上書きドメイン：${prefs.tunnelZoneOverride}`);
  });

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("set")
    .description("Save ChatGPT and C2C setup choices for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--default-tunnel <mode>", "default secure connection: quick or named")
    .option("--default-tunnel-zone <domain>", "default Cloudflare domain for named connections")
    .option("--tunnel-override <mode>", "machine-only override: quick or named")
    .option("--tunnel-override-zone <domain>", "machine-only domain override for named connections")
    .option("--json", "machine-readable output", false)
)
  .action(
    (opts: {
      developerMode: boolean;
      setupMode?: string;
      defaultTunnel?: string;
      defaultTunnelZone?: string;
      tunnelOverride?: string;
      tunnelOverrideZone?: string;
      json: boolean;
    }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      const defaultTunnelRaw = opts.defaultTunnel?.trim().toLowerCase();
      if (defaultTunnelRaw && !TUNNEL_MODES.includes(defaultTunnelRaw as TunnelMode)) {
        throw new Error(`default-tunnel must be one of ${TUNNEL_MODES.join(", ")}`);
      }
      const tunnelOverrideRaw = opts.tunnelOverride?.trim().toLowerCase();
      if (tunnelOverrideRaw && !TUNNEL_MODES.includes(tunnelOverrideRaw as TunnelMode)) {
        throw new Error(`tunnel-override must be one of ${TUNNEL_MODES.join(", ")}`);
      }
      if (
        !opts.developerMode &&
        !modeRaw &&
        !defaultTunnelRaw &&
        opts.defaultTunnelZone === undefined &&
        !tunnelOverrideRaw &&
        opts.tunnelOverrideZone === undefined
      ) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
        defaultTunnelMode: defaultTunnelRaw as TunnelMode | undefined,
        defaultTunnelZone: opts.defaultTunnelZone,
        tunnelModeOverride: tunnelOverrideRaw as TunnelMode | undefined,
        tunnelZoneOverride: opts.tunnelOverrideZone,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("開発者モードを有効として記録しました");
      if (modeRaw === "auto") check("設定方式を記録しました：AI自動設定（プレビュー版）");
      if (modeRaw === "manual") check("設定方式を記録しました：手動ガイド設定");
      if (defaultTunnelRaw) check(`安全な接続の既定を記録しました：${defaultTunnelRaw}`);
      if (opts.defaultTunnelZone !== undefined) check(`安全な接続の既定ドメインを記録しました：${prefs.defaultTunnelZone}`);
      if (tunnelOverrideRaw) check(`この端末の安全な接続上書きを記録しました：${tunnelOverrideRaw}`);
      if (opts.tunnelOverrideZone !== undefined) check(`この端末の安全な接続上書きドメインを記録しました：${prefs.tunnelZoneOverride}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
    }
  );

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: opts.task,
          iteration: opts.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("実行サマリーを記録しました（出力はChatGPTに公開していません）");
      else if (outputId !== undefined) check("実行サマリーと出力を記録しました");
      else check("実行サマリーを記録しました");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定ドメイン：${payload.hostname}`);
      else say("現在は一時アドレスを使用しています。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("一時アドレスを選択しました");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "Cloudflare に追加済みのドメインを入力してください（例：example.com）",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
        // An explicit workspace choice is fail-closed. Quick fallback is
        // permitted only for a resolved TeamAI/machine policy, never merely
        // because named provisioning failed during `tunnel choose`.
        allowQuickFallback: false,
      });
      if (!result.ok && !result.fallback) {
        throw new Error(
          result.error?.startsWith("NEED_CLOUDFLARE_LOGIN")
            ? result.error
            : `NAMED_PROVISION_FAILED: ${result.error ?? "named tunnel provisioning failed"}`
        );
      }
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定ドメインの準備が完了しました：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  tunnelCmd
    .command("login")
    .description("Open the Cloudflare login window used by a named hostname")
    .option("--json", "machine-readable output", false)
)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare にログインしました");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    if (message.startsWith("NEED_CLOUDFLARE_LOGIN")) {
      say(JSON.stringify({ ok: false, waiting: "HUMAN_WAITING", need: "cloudflare_login", error: message }));
    } else if (message.startsWith("NEED_TUNNEL_CHOICE")) {
      say(JSON.stringify({ ok: false, waiting: "HUMAN_WAITING", need: "tunnel_choice", error: message }));
    } else {
      say(JSON.stringify({ ok: false, error: message }));
    }
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("次の操作が必要です：");
    say("");
    say("安全な接続コンポーネント cloudflared がインストールされていません。");
    say("macOSでは `brew install cloudflared` を実行してください。");
    say("インストール後、もう一度実行すると続行します。");
  } else if (message.startsWith("NEED_CLOUDFLARE_LOGIN")) {
    say("HUMAN_WAITING: 表示されるブラウザでCloudflareにログインしてください。完了は状態から自動検知して続行します。チャットでの報告は不要です。");
  } else if (message.startsWith("NEED_TUNNEL_CHOICE")) {
    say(message.slice("NEED_TUNNEL_CHOICE: ".length));
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
