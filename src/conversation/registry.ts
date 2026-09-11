import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type ConversationStage = "planning" | "plan_review" | "pr_review" | "prototype_evaluation" | string;

export interface ConversationBinding {
  projectId: string;
  conversationId: string;
  workspace: string;
  repository: string;
  workId: string;
  stage: ConversationStage;
  role: string;
  updatedAt: string;
}

interface RegistryFile {
  schemaVersion: 1;
  conversations: Record<string, ConversationBinding>;
}

function registryFile(workspaceId: string): string {
  return path.join(getStateDir(), "conversations", `${workspaceId}.json`);
}

export function conversationKey(input: Pick<ConversationBinding, "repository" | "workId" | "stage" | "role">): string {
  return createHash("sha256")
    .update(`${input.repository}\0${input.workId}\0${input.stage}\0${input.role}`)
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
  identity: Pick<ConversationBinding, "workspace" | "repository" | "workId" | "stage" | "role">
): ConversationBinding | null {
  const binding = load(workspaceId).conversations[conversationKey(identity)];
  if (!binding) return null;
  if (
    binding.workspace !== identity.workspace ||
    binding.repository !== identity.repository ||
    binding.workId !== identity.workId ||
    binding.stage !== identity.stage ||
    binding.role !== identity.role
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
