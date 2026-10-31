import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { resolveWorkspaceRepository } from "../workspace/repository.js";
import type { ChatGPTSurfaceId } from "../provisioning/chatgpt-surface.js";
import { withWorkspaceOperation } from "../process/workspace-operation.js";
import { readEvidenceGit, runEvidenceGit } from "../workspace/git-evidence.js";

export type EndpointMode = "stable" | "ephemeral" | "local";

export interface InstallationIdentity {
  installationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionBinding {
  schemaVersion: 1 | 2;
  workspaceId: string;
  workspace: string;
  canonicalRepository: string;
  installationId: string;
  endpointMode: EndpointMode;
  endpointFingerprint: string;
  connectorName: string;
  projectId?: string;
  projectName?: string;
  reviewerBinding?: string;
  accountFingerprint?: string;
  selectedSurface?: ChatGPTSurfaceId;
  readOnlyRequired?: boolean;
  readOnlyProof?: "verified" | "unverified";
  workspaceVerification?: "verified" | "unverified";
  identitySource?: "connector_record" | "surface_observation";
  updatedAt: string;
}

/** Stable, non-secret identity projection used to bind durable transport state. */
export interface WorktreeIdentity {
  workspaceRoot: string;
  worktreeRoot: string;
  canonicalRepository: string;
  branch: string;
  observedCommit: string;
  dirtyState: "clean" | "dirty" | "unknown";
  installationId: string;
  endpointFingerprint?: string;
  connectorName?: string;
}

function installationFile(): string {
  return path.join(getStateDir(), "installation.json");
}

function validInstallationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{16,64}$/i.test(value);
}

/** Return the persistent per-installation identity without storing credentials. */
export function getInstallationIdentity(): InstallationIdentity {
  const existing = readInstallationIdentity();
  if (existing) return existing;
  const now = new Date().toISOString();
  const created: InstallationIdentity = { installationId: randomUUID(), createdAt: now, updatedAt: now };
  writeSecureJson(installationFile(), created);
  return created;
}

export function canonicalRepositoryFor(workspaceRoot: string): string {
  return resolveWorkspaceRepository(workspaceRoot).repository;
}

export function readInstallationIdentity(): InstallationIdentity | null {
  const existing = readJsonIfExists<InstallationIdentity>(installationFile());
  return existing && validInstallationId(existing.installationId) ? existing : null;
}

export function worktreeRootFor(workspaceRoot: string): string {
  return fs.realpathSync.native(readEvidenceGit(workspaceRoot, ["rev-parse", "--show-toplevel"], 16 * 1024).trim());
}

export function readWorktreeIdentity(input: {
  workspaceRoot: string;
  endpoint?: string | null;
  endpointMode?: EndpointMode;
  connectorName?: string | null;
}): WorktreeIdentity {
  const installation = readInstallationIdentity();
  if (!installation) throw new Error("INSTALLATION_IDENTITY_UNAVAILABLE");
  const worktreeRoot = worktreeRootFor(input.workspaceRoot);
  let branch: string;
  let commit: string;
  try {
    branch = readEvidenceGit(input.workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], 4096).trim();
    commit = readEvidenceGit(input.workspaceRoot, ["rev-parse", "--verify", "HEAD"], 1024).trim();
  } catch { throw new Error("WORKTREE_IDENTITY_UNAVAILABLE"); }
  if (!branch || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new Error("WORKTREE_IDENTITY_UNAVAILABLE");
  }
  let dirtyState: WorktreeIdentity["dirtyState"] = "unknown";
  try {
    const changed = runEvidenceGit(input.workspaceRoot, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."]);
    const untracked = readEvidenceGit(input.workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    if (changed.code === 0 || changed.code === 1) dirtyState = changed.code === 1 || untracked.length > 0 ? "dirty" : "clean";
  } catch { /* Failed Git observations cannot establish a clean worktree. */ }
  const mode = input.endpointMode ?? "ephemeral";
  return {
    workspaceRoot: fs.realpathSync.native(input.workspaceRoot),
    worktreeRoot,
    canonicalRepository: canonicalRepositoryFor(input.workspaceRoot),
    branch,
    observedCommit: commit,
    dirtyState,
    installationId: installation.installationId,
    endpointFingerprint: input.endpoint === undefined ? undefined : endpointFingerprint(input.endpoint, mode),
    connectorName: input.connectorName?.trim() || undefined,
  };
}

export const buildWorktreeIdentity = readWorktreeIdentity;

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
  if (!binding || (binding.schemaVersion !== 1 && binding.schemaVersion !== 2)) return null;
  if (!binding.workspaceId || !binding.workspace || !binding.canonicalRepository || !binding.installationId) return null;
  if (!binding.endpointFingerprint || !binding.connectorName) return null;
  return { ...binding, schemaVersion: 2 };
}

export function writeConnectionBinding(binding: ConnectionBinding): ConnectionBinding {
  return withWorkspaceOperation(binding.workspaceId, () => {
    writeSecureJson(bindingFile(binding.workspaceId), { ...binding, updatedAt: new Date().toISOString() });
    return readConnectionBinding(binding.workspaceId) ?? binding;
  });
}

export function makeConnectionBinding(input: {
  workspaceId: string;
  workspace: string;
  workspaceRoot: string;
  endpoint?: string | null;
  endpointMode?: EndpointMode;
  connectorName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  reviewerBinding?: string | null;
  accountFingerprint?: string | null;
  selectedSurface?: ChatGPTSurfaceId;
  readOnlyRequired?: boolean;
  readOnlyProof?: "verified" | "unverified";
  workspaceVerification?: "verified" | "unverified";
  identitySource?: "connector_record" | "surface_observation";
}): ConnectionBinding {
  const installation = getInstallationIdentity();
  const endpointMode = input.endpointMode ?? "ephemeral";
  const previous = readConnectionBinding(input.workspaceId);
  return {
    ...previous,
    schemaVersion: 2,
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
    ...((input.projectName ?? previous?.projectName) ? { projectName: input.projectName ?? previous?.projectName } : {}),
    ...((input.reviewerBinding ?? previous?.reviewerBinding) ? { reviewerBinding: input.reviewerBinding ?? previous?.reviewerBinding } : {}),
    ...((input.accountFingerprint ?? previous?.accountFingerprint) ? { accountFingerprint: input.accountFingerprint ?? previous?.accountFingerprint } : {}),
    ...((input.selectedSurface ?? previous?.selectedSurface) ? { selectedSurface: input.selectedSurface ?? previous?.selectedSurface } : {}),
    ...((input.readOnlyRequired ?? previous?.readOnlyRequired) !== undefined
      ? { readOnlyRequired: input.readOnlyRequired ?? previous?.readOnlyRequired }
      : {}),
    ...((input.readOnlyProof ?? previous?.readOnlyProof) ? { readOnlyProof: input.readOnlyProof ?? previous?.readOnlyProof } : {}),
    ...((input.workspaceVerification ?? previous?.workspaceVerification)
      ? { workspaceVerification: input.workspaceVerification ?? previous?.workspaceVerification }
      : {}),
    ...((input.identitySource ?? previous?.identitySource) ? { identitySource: input.identitySource ?? previous?.identitySource } : {}),
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
