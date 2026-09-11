import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { runGit } from "../workspace/git.js";

export type EndpointMode = "stable" | "ephemeral" | "local";

export interface InstallationIdentity {
  installationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionBinding {
  schemaVersion: 1;
  workspaceId: string;
  workspace: string;
  canonicalRepository: string;
  installationId: string;
  endpointMode: EndpointMode;
  endpointFingerprint: string;
  connectorName: string;
  projectId?: string;
  updatedAt: string;
}

function installationFile(): string {
  return path.join(getStateDir(), "installation.json");
}

function validInstallationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{16,64}$/i.test(value);
}

/** Return the persistent per-installation identity without storing credentials. */
export function getInstallationIdentity(): InstallationIdentity {
  const existing = readJsonIfExists<InstallationIdentity>(installationFile());
  if (existing && validInstallationId(existing.installationId)) return existing;
  const now = new Date().toISOString();
  const created: InstallationIdentity = { installationId: randomUUID(), createdAt: now, updatedAt: now };
  writeSecureJson(installationFile(), created);
  return created;
}

function normalizeRemote(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const ssh = value.match(/^git@([^:]+):(.+)$/i);
  if (ssh) return `https://${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/i, "")}`;
  try {
    const url = new URL(value);
    // Never persist embedded credentials or fragments from a remote URL.
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Resolve a repository identity from git, omitting tokens embedded in remotes. */
export function canonicalRepositoryFor(workspaceRoot: string): string {
  const top = runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  const repoRoot = top.ok && top.stdout.trim() ? top.stdout.trim() : workspaceRoot;
  const remote = runGit(repoRoot, ["remote", "get-url", "origin"]);
  const normalized = remote.ok ? normalizeRemote(remote.stdout) : null;
  if (normalized) return normalized;
  return `file:${path.resolve(repoRoot)}`;
}

export function endpointFingerprint(endpoint: string | null | undefined, mode: EndpointMode): string {
  const normalized = endpoint ? endpoint.trim().replace(/\/+$/, "").toLowerCase() : "";
  return createHash("sha256").update(`${mode}\0${normalized}`).digest("hex").slice(0, 24);
}

export function connectorNameForInstallation(
  workspaceName: string,
  installationId: string,
  previousName?: string | null
): string {
  if (previousName?.trim()) return previousName.trim();
  const cleaned = workspaceName.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  const label = (cleaned || "workspace").slice(0, 36);
  return `Codex with ChatGPT · ${label} · ${installationId.slice(0, 8)}`;
}

export function bindingFile(workspaceId: string): string {
  return path.join(getStateDir(), "bindings", `${workspaceId}.json`);
}

export function readConnectionBinding(workspaceId: string): ConnectionBinding | null {
  const binding = readJsonIfExists<ConnectionBinding>(bindingFile(workspaceId));
  if (!binding || binding.schemaVersion !== 1) return null;
  if (!binding.workspaceId || !binding.workspace || !binding.canonicalRepository || !binding.installationId) return null;
  if (!binding.endpointFingerprint || !binding.connectorName) return null;
  return binding;
}

export function writeConnectionBinding(binding: ConnectionBinding): ConnectionBinding {
  writeSecureJson(bindingFile(binding.workspaceId), { ...binding, updatedAt: new Date().toISOString() });
  return readConnectionBinding(binding.workspaceId) ?? binding;
}

export function makeConnectionBinding(input: {
  workspaceId: string;
  workspace: string;
  workspaceRoot: string;
  endpoint?: string | null;
  endpointMode?: EndpointMode;
  connectorName?: string | null;
  projectId?: string | null;
}): ConnectionBinding {
  const installation = getInstallationIdentity();
  const endpointMode = input.endpointMode ?? "ephemeral";
  const previous = readConnectionBinding(input.workspaceId);
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    workspace: input.workspace,
    canonicalRepository: canonicalRepositoryFor(input.workspaceRoot),
    installationId: installation.installationId,
    endpointMode,
    endpointFingerprint: endpointFingerprint(input.endpoint, endpointMode),
    connectorName: connectorNameForInstallation(
      input.workspace,
      installation.installationId,
      input.connectorName ?? previous?.connectorName
    ),
    ...(input.projectId ?? previous?.projectId ? { projectId: input.projectId ?? previous?.projectId } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function bindingMatches(
  binding: ConnectionBinding,
  expected: Pick<ConnectionBinding, "workspace" | "canonicalRepository" | "installationId" | "endpointMode" | "endpointFingerprint">
): boolean {
  return (
    binding.workspace === expected.workspace &&
    binding.canonicalRepository === expected.canonicalRepository &&
    binding.installationId === expected.installationId &&
    binding.endpointMode === expected.endpointMode &&
    binding.endpointFingerprint === expected.endpointFingerprint
  );
}
