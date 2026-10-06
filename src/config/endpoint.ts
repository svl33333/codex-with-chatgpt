import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { connectorNameForInstallation, endpointFingerprint, type EndpointMode } from "../connection/identity.js";
import { createHash } from "node:crypto";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
/** Normal semantic creation entry point; the app shell owns the route. */
export const CHATGPT_CUSTOM_MCP_CREATION_URL = CHATGPT_PLUGINS_URL;
/** Compatibility/navigation hint only; never creation authority or proof. */
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";
export const CHATGPT_CREATE_CONNECTOR_COMPATIBILITY_URL = CHATGPT_CREATE_CONNECTOR_URL;
export const CHATGPT_PROJECT_DISPLAY_NAME_LIMIT = 50;
export const APPROVED_A0_PROJECT_DISPLAY_NAME = "codex-with-chatgpt-a0-surface-compatibility";

export const DEFAULT_CONNECTOR_NAME = "Codex with ChatGPT";

export interface ProjectDisplayNameContext {
  durableWorkstreamIdentity?: string;
  workspaceId?: string;
  connectorName?: string;
}

export interface ProjectDisplayNameValidation {
  isValid: boolean;
  length: number;
  maxLength: number;
  reason?: "empty" | "too_long";
}

/** Recover the durable workstream identity from the conventional workspace label. */
export function workstreamIdentityFromWorkspaceName(workspaceName: string): string {
  const trimmed = workspaceName.trim();
  const prefix = "codex-with-chatgpt-";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function displayNameLength(value: string): number {
  return Array.from(value).length;
}

/** Validate the bounded display-name field without treating it as identity proof. */
export function validateProjectDisplayName(name: string): ProjectDisplayNameValidation {
  const trimmed = name.trim();
  const length = displayNameLength(trimmed);
  if (length === 0) return { isValid: false, length, maxLength: CHATGPT_PROJECT_DISPLAY_NAME_LIMIT, reason: "empty" };
  if (length > CHATGPT_PROJECT_DISPLAY_NAME_LIMIT) {
    return { isValid: false, length, maxLength: CHATGPT_PROJECT_DISPLAY_NAME_LIMIT, reason: "too_long" };
  }
  return { isValid: true, length, maxLength: CHATGPT_PROJECT_DISPLAY_NAME_LIMIT };
}

function normalizationSuffix(context: ProjectDisplayNameContext): string {
  const identity = context.durableWorkstreamIdentity ?? "display-name";
  const workspace = context.workspaceId ?? "";
  // The durable workstream identity plus workspace id is the canonical input
  // for every production payload. Connector labels are mutable presentation
  // data, so including them would make doctor/workspace disagree for the same
  // workspace after an identity-preserving connector repair.
  return `-${createHash("sha256").update(`${identity}\0${workspace}`).digest("hex").slice(0, 8)}`;
}

/**
 * Normalize a generated Project label before submission while retaining the
 * durable workstream identity separately. The known A0 label keeps its
 * approved compact form; other overlong labels receive a deterministic
 * identity-derived suffix so different workstreams do not collapse silently.
 */
export function normalizeProjectDisplayName(
  requestedName: string,
  context: ProjectDisplayNameContext = {}
): string {
  const trimmed = requestedName.trim();
  if (validateProjectDisplayName(trimmed).isValid) return trimmed;
  if (!trimmed) throw new Error("Project display name must not be empty");

  if (
    trimmed === "codex-with-chatgpt-a0-chatgpt-surface-compatibility" &&
    context.durableWorkstreamIdentity === "a0-chatgpt-surface-compatibility"
  ) {
    return APPROVED_A0_PROJECT_DISPLAY_NAME;
  }

  const suffix = normalizationSuffix(context);
  const available = CHATGPT_PROJECT_DISPLAY_NAME_LIMIT - displayNameLength(suffix);
  const prefix = Array.from(trimmed).slice(0, Math.max(1, available)).join("").replace(/[\s-]+$/u, "");
  return `${prefix}${suffix}`;
}

/** Build the stable generated label used by the ChatGPT Project provisioning layer. */
export function projectDisplayNameForWorkstream(
  workstreamIdentity: string,
  context: Omit<ProjectDisplayNameContext, "durableWorkstreamIdentity"> = {}
): string {
  return normalizeProjectDisplayName(`codex-with-chatgpt-${workstreamIdentity}`, {
    ...context,
    durableWorkstreamIdentity: workstreamIdentity,
  });
}

/** Build the bounded Project label exposed by the workspace/setup payload. */
export function projectDisplayNameForWorkspace(
  workspaceName: string,
  context: Omit<ProjectDisplayNameContext, "durableWorkstreamIdentity"> = {}
): string {
  return projectDisplayNameForWorkstream(workstreamIdentityFromWorkspaceName(workspaceName), context);
}

export interface LastEndpoint {
  workspaceId: string;
  workspace?: string;
  canonicalRepository?: string;
  installationId?: string;
  endpointMode?: EndpointMode;
  endpointFingerprint?: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile(workspaceId));
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to THIS workspace's ChatGPT connector.
 *  `update` means the public address changed: Delete the old connector
 *  in ChatGPT, then create it again. Never click Reconnect (the old
 *  URL is dead and hangs on "This site cannot be reached"). */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Same workspace keeps one connector title forever.
 * A workspace already recorded without a title stays on the original
 * "Codex with ChatGPT" name. A new workspace gets a distinct title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
  installationId?: string | null;
}): string {
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.installationId?.trim()) {
    return connectorNameForInstallation(opts.workspaceName, opts.installationId);
  }
  if (opts.hadEndpointBefore) return DEFAULT_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

export function reclaimUserMessage(connectorName: string): string {
  return `現在のプロジェクトの安全な接続先が無効になりました。「${connectorName}」だけを削除して新しいアドレスで再追加します。他のプロジェクトの接続は変更しません。しばらくお待ちください。`;
}
