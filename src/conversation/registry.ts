import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { operationTargetsMatch, type GitHubOperationTarget } from "./operation.js";

export type ConversationStage = "planning" | "plan_review" | "pr_review" | "prototype_evaluation" | string;

export interface ConversationBinding {
  projectId: string;
  conversationId: string;
  workspace: string;
  repository: string;
  workId: string;
  stage: ConversationStage;
  role: string;
  /** Exact runtime identity; display names remain non-authoritative. */
  sessionId?: string;
  codexSessionId?: string;
  worktreeRoot?: string;
  branch?: string;
  observedCommit?: string;
  mcpAppId?: string;
  mcpVersionId?: string;
  checkpoint?: string;
  eventKey?: string;
  operationKey?: string;
  operationTarget?: GitHubOperationTarget;
  /** Non-authoritative resume metadata; the grant is always reloaded. */
  delegationGrantId?: string;
  delegationGrantGeneration?: number;
  delegationScopeDigest?: string;
  updatedAt: string;
}

type ConversationIdentity = Pick<ConversationBinding, "repository" | "workId" | "stage" | "role"> &
  Partial<Pick<ConversationBinding, "workspace" | "sessionId" | "codexSessionId" | "worktreeRoot" | "branch" | "observedCommit" | "mcpAppId" | "mcpVersionId" | "checkpoint" | "eventKey" | "operationKey" | "operationTarget">>;

interface RegistryFile {
  schemaVersion: 1;
  conversations: Record<string, ConversationBinding>;
}

function registryFile(workspaceId: string): string {
  return path.join(getStateDir(), "conversations", `${workspaceId}.json`);
}

export function conversationKey(input: ConversationIdentity): string {
  const hasExactIdentity = Boolean(
    input.sessionId ||
      input.codexSessionId ||
      input.worktreeRoot ||
      input.branch ||
      input.observedCommit ||
      input.mcpAppId ||
      input.mcpVersionId ||
      input.checkpoint ||
      input.eventKey ||
      input.operationKey
  );
  if (!hasExactIdentity) {
    return createHash("sha256")
      .update(`${input.repository}\0${input.workId}\0${input.stage}\0${input.role}`)
      .digest("hex")
      .slice(0, 32);
  }
  return createHash("sha256")
    .update(
      [
        input.repository,
        input.workId,
        input.stage,
        input.role,
        input.sessionId ?? "",
        input.codexSessionId ?? "",
        input.worktreeRoot ?? "",
        input.branch ?? "",
        input.observedCommit ?? "",
        input.mcpAppId ?? "",
        input.mcpVersionId ?? "",
        input.checkpoint ?? "",
        input.eventKey ?? "",
        input.operationKey ?? "",
      ].join("\0")
    )
    .digest("hex")
    .slice(0, 32);
}

function load(workspaceId: string): RegistryFile {
  const value = readJsonIfExists<RegistryFile>(registryFile(workspaceId));
  if (value?.schemaVersion === 1 && value.conversations && typeof value.conversations === "object") return value;
  return { schemaVersion: 1, conversations: {} };
}

function save(workspaceId: string, registry: RegistryFile): void {
  writeSecureJson(registryFile(workspaceId), registry);
}

export function readConversationBinding(
  workspaceId: string,
  identity: ConversationIdentity
): ConversationBinding | null {
  const binding = load(workspaceId).conversations[conversationKey(identity)];
  if (!binding) return null;
  if (
    (identity.workspace !== undefined && binding.workspace !== identity.workspace) ||
    binding.repository !== identity.repository ||
    binding.workId !== identity.workId ||
    binding.stage !== identity.stage ||
    binding.role !== identity.role
    || (identity.sessionId !== undefined && binding.sessionId !== identity.sessionId)
    || (identity.codexSessionId !== undefined && binding.codexSessionId !== identity.codexSessionId)
    || (identity.worktreeRoot !== undefined && binding.worktreeRoot !== identity.worktreeRoot)
    || (identity.branch !== undefined && binding.branch !== identity.branch)
    || (identity.observedCommit !== undefined && binding.observedCommit !== identity.observedCommit)
    || (identity.mcpAppId !== undefined && binding.mcpAppId !== identity.mcpAppId)
    || (identity.mcpVersionId !== undefined && binding.mcpVersionId !== identity.mcpVersionId)
    || (identity.checkpoint !== undefined && binding.checkpoint !== identity.checkpoint)
    || (identity.eventKey !== undefined && binding.eventKey !== identity.eventKey)
    || (identity.operationKey !== undefined && binding.operationKey !== identity.operationKey)
    || (identity.operationTarget !== undefined && (!binding.operationTarget || !operationTargetsMatch(binding.operationTarget, identity.operationTarget)))
  ) {
    throw new Error("conversation identity mismatch; refusing to resume");
  }
  return binding;
}

export function bindConversation(workspaceId: string, binding: ConversationBinding): ConversationBinding {
  if (!binding.projectId || !binding.conversationId) throw new Error("project and conversation IDs are required");
  const registry = load(workspaceId);
  const key = conversationKey(binding);
  const existing = registry.conversations[key];
  if (existing) {
    if (
      existing.projectId !== binding.projectId ||
      existing.workspace !== binding.workspace ||
      existing.repository !== binding.repository ||
      existing.workId !== binding.workId ||
      existing.stage !== binding.stage ||
      existing.role !== binding.role
      || existing.sessionId !== binding.sessionId
      || existing.codexSessionId !== binding.codexSessionId
      || existing.worktreeRoot !== binding.worktreeRoot
      || existing.branch !== binding.branch
      || existing.observedCommit !== binding.observedCommit
      || existing.mcpAppId !== binding.mcpAppId
      || existing.mcpVersionId !== binding.mcpVersionId
      || existing.checkpoint !== binding.checkpoint
      || existing.eventKey !== binding.eventKey
      || existing.operationKey !== binding.operationKey
      || (existing.operationTarget !== undefined && binding.operationTarget !== undefined && !operationTargetsMatch(existing.operationTarget, binding.operationTarget))
      || (existing.operationTarget === undefined) !== (binding.operationTarget === undefined)
    ) {
      throw new Error("conversation candidate conflicts with the saved identity");
    }
    return existing;
  }
  const saved = { ...binding, updatedAt: new Date().toISOString() };
  registry.conversations[key] = saved;
  save(workspaceId, registry);
  return saved;
}

export function listConversationBindings(workspaceId: string): ConversationBinding[] {
  return Object.values(load(workspaceId).conversations);
}
