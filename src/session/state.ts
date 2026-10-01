import path from "node:path";
import fs from "node:fs";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { GitHubOperationTarget } from "../conversation/operation.js";

export type ConversationMode = "long-chat" | "project";

export type ConversationReason = "existing-long-chat" | "project" | "new-workspace";

export type ProtocolState =
  | "INIT"
  | "PLAN_RECEIVED"
  | "EXECUTING"
  | "EXECUTED_LOCAL"
  | "EXECUTED_SENT"
  | "DONE"
  | "BLOCKED";

export type WaitingFor = "none" | "GPT_PLAN" | "GPT_REVIEW" | "USER";

/** Bounded, non-secret projection needed to reconstruct a C2C transport. */
export interface TransportSessionProjection {
  workspaceId?: string;
  workspaceRoot?: string;
  repository?: string;
  worktreeRoot?: string;
  branch?: string;
  observedCommit?: string;
  dirtyState?: "clean" | "dirty" | "unknown";
  projectId?: string;
  chatId?: string;
  codexSessionId?: string;
  mcpAppId?: string;
  mcpVersionId?: string;
  connectorName?: string;
  checkpoint?: string;
  stage?: string;
  eventKey?: string;
  payloadHash?: string;
  operationKey?: string;
  operationTarget?: GitHubOperationTarget;
}

export const PROTOCOL_STATES: readonly ProtocolState[] = [
  "INIT",
  "PLAN_RECEIVED",
  "EXECUTING",
  "EXECUTED_LOCAL",
  "EXECUTED_SENT",
  "DONE",
  "BLOCKED",
];

export const WAITING_FOR: readonly WaitingFor[] = ["none", "GPT_PLAN", "GPT_REVIEW", "USER"];

export interface TaskCheckpoint {
  taskId: string;
  iteration: number;
  protocolState: ProtocolState;
  waitingFor: WaitingFor;
  originalGoal?: string;
  completedSubtasks?: string;
  knownIssues?: string;
  nextExpectedStep?: string;
  chatUrl?: string;
  projectUrl?: string;
  transport?: TransportSessionProjection;
  updatedAt: string;
}

export interface SavedSession {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  transport?: TransportSessionProjection;
  checkpoint?: TaskCheckpoint;
}

export interface SessionPatch {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  transport?: TransportSessionProjection;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
}

export interface ConversationView {
  mode: ConversationMode;
  reason: ConversationReason;
  projectUrl: string | null;
  projectReady: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  /** long-chat: Skill may goto chatUrl. project: only if THIS Codex thread already bound it. */
  reuseSavedChat: boolean;
}

export function sessionFile(workspaceId: string): string {
  return path.join(getStateDir(), "sessions", `${workspaceId}.json`);
}

export function readSession(workspaceId: string): SavedSession | null {
  return readJsonIfExists<SavedSession>(sessionFile(workspaceId));
}

export function writeSession(workspaceId: string, session: SavedSession): SavedSession {
  writeSecureJson(sessionFile(workspaceId), session);
  return session;
}

export function normalizeProjectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+)\/project\/?$/);
    if (!match) return null;
    return `https://chatgpt.com/g/${match[1]}/project`;
  } catch {
    return null;
  }
}

export function projectIdFromUrl(url: string): string | null {
  const normalized = normalizeProjectUrl(url);
  if (!normalized) return null;
  return normalized.match(/\/g\/(g-p-[a-zA-Z0-9]+)\/project/)?.[1] ?? null;
}

export function resolveConversation(session: SavedSession | null): ConversationView {
  if (!session) {
    return {
      mode: "project",
      reason: "new-workspace",
      projectUrl: null,
      projectReady: false,
      chatUrl: null,
      connectorName: null,
      reuseSavedChat: false,
    };
  }

  const projectUrl = session.projectUrl ? normalizeProjectUrl(session.projectUrl) : null;
  const projectReady = Boolean(projectUrl);

  if (session.conversationMode === "long-chat") {
    return {
      mode: "long-chat",
      reason: "existing-long-chat",
      projectUrl: null,
      projectReady: false,
      chatUrl: session.url ?? null,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: Boolean(session.url),
    };
  }

  if (session.conversationMode === "project" || projectReady) {
    return {
      mode: "project",
      reason: "project",
      projectUrl,
      projectReady,
      chatUrl: session.url ?? null,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: false,
    };
  }

  return {
    mode: "long-chat",
    reason: "existing-long-chat",
    projectUrl: null,
    projectReady: false,
    chatUrl: session.url ?? null,
    connectorName: session.connectorName ?? null,
    reuseSavedChat: Boolean(session.url),
  };
}

const CHECKPOINT_LIMITS = {
  originalGoal: 500,
  completedSubtasks: 800,
  knownIssues: 800,
  nextExpectedStep: 400,
} as const;

const TRANSPORT_LIMITS = {
  workspaceId: 128,
  workspaceRoot: 512,
  repository: 256,
  worktreeRoot: 512,
  branch: 256,
  observedCommit: 128,
  projectId: 160,
  chatId: 160,
  codexSessionId: 256,
  mcpAppId: 256,
  mcpVersionId: 256,
  connectorName: 256,
  checkpoint: 128,
  stage: 128,
  eventKey: 256,
  payloadHash: 128,
  operationKey: 128,
} as const;

const OPERATION_KINDS = ["issue_create", "issue_update", "push", "pr_create", "pr_update", "review", "publication"] as const;

function capOperationTarget(value: GitHubOperationTarget | undefined): GitHubOperationTarget | undefined {
  if (!value || !OPERATION_KINDS.includes(value.kind)) return undefined;
  const target: GitHubOperationTarget = {
    kind: value.kind,
    repository: capCheckpointText(value.repository, 256) ?? "",
    logicalOperationId: capCheckpointText(value.logicalOperationId, 256) ?? "",
    ...(typeof value.issueNumber === "number" && Number.isSafeInteger(value.issueNumber) ? { issueNumber: value.issueNumber } : {}),
    ...(typeof value.pullRequestNumber === "number" && Number.isSafeInteger(value.pullRequestNumber) ? { pullRequestNumber: value.pullRequestNumber } : {}),
    ...(capCheckpointText(value.ref, 256) ? { ref: capCheckpointText(value.ref, 256) } : {}),
    ...(capCheckpointText(value.expectedCommit, 128) ? { expectedCommit: capCheckpointText(value.expectedCommit, 128) } : {}),
    ...(capCheckpointText(value.expectedContentHash, 128) ? { expectedContentHash: capCheckpointText(value.expectedContentHash, 128) } : {}),
    ...(capCheckpointText(value.expectedRevision, 128) ? { expectedRevision: capCheckpointText(value.expectedRevision, 128) } : {}),
    ...(capCheckpointText(value.headRef, 256) ? { headRef: capCheckpointText(value.headRef, 256) } : {}),
    ...(capCheckpointText(value.baseRef, 256) ? { baseRef: capCheckpointText(value.baseRef, 256) } : {}),
    ...(capCheckpointText(value.marker, 256) ? { marker: capCheckpointText(value.marker, 256) } : {}),
  };
  return target.repository && target.logicalOperationId ? target : undefined;
}

function capCheckpointText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function capTransportProjection(value: TransportSessionProjection | undefined): TransportSessionProjection | undefined {
  if (!value) return undefined;
  const result: TransportSessionProjection = {};
  if (value.dirtyState === "clean" || value.dirtyState === "dirty" || value.dirtyState === "unknown") {
    result.dirtyState = value.dirtyState;
  }
  for (const key of Object.keys(TRANSPORT_LIMITS) as (keyof typeof TRANSPORT_LIMITS)[]) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw === "string") {
      const capped = capCheckpointText(raw, TRANSPORT_LIMITS[key]);
      if (capped) result[key] = capped;
    }
  }
  const operationTarget = capOperationTarget(value.operationTarget);
  if (operationTarget) result.operationTarget = operationTarget;
  return Object.keys(result).length ? result : undefined;
}

export function mergeSession(previous: SavedSession | null, patch: SessionPatch): SavedSession {
  const conversationMode = patch.conversationMode ?? previous?.conversationMode;
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  let projectUrl = rawProjectUrl;
  if (rawProjectUrl) {
    const normalized = normalizeProjectUrl(rawProjectUrl);
    if (!normalized) {
      throw new Error("project URL must look like https://chatgpt.com/g/g-p-…/project");
    }
    projectUrl = normalized;
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const url = patch.url ?? previous?.url;
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(patch.taskId ?? previous?.taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && conversationMode !== "long-chat" && !hasTask && !hasCheckpoint) {
    throw new Error("nothing to save: pass --url, --project-url, or --mode");
  }

  let checkpoint = previous?.checkpoint;
  if (patch.clearCheckpoint) {
    checkpoint = undefined;
  } else if (patch.checkpoint) {
    const taskId = patch.checkpoint.taskId ?? patch.taskId ?? previous?.checkpoint?.taskId ?? previous?.taskId;
    const iteration =
      patch.checkpoint.iteration ??
      patch.iteration ??
      previous?.checkpoint?.iteration ??
      previous?.iteration ??
      0;
    const protocolState = patch.checkpoint.protocolState ?? previous?.checkpoint?.protocolState;
    if (!taskId || !protocolState) {
      throw new Error("checkpoint requires task id and protocol state");
    }
    if (!PROTOCOL_STATES.includes(protocolState)) {
      throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
    }
    const waitingFor = patch.checkpoint.waitingFor ?? previous?.checkpoint?.waitingFor ?? "none";
    if (!WAITING_FOR.includes(waitingFor)) {
      throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
    }
    checkpoint = {
      taskId,
      iteration,
      protocolState,
      waitingFor,
      originalGoal: capCheckpointText(
        patch.checkpoint.originalGoal ?? previous?.checkpoint?.originalGoal,
        CHECKPOINT_LIMITS.originalGoal
      ),
      completedSubtasks: capCheckpointText(
        patch.checkpoint.completedSubtasks ?? previous?.checkpoint?.completedSubtasks,
        CHECKPOINT_LIMITS.completedSubtasks
      ),
      knownIssues: capCheckpointText(
        patch.checkpoint.knownIssues ?? previous?.checkpoint?.knownIssues,
        CHECKPOINT_LIMITS.knownIssues
      ),
      nextExpectedStep: capCheckpointText(
        patch.checkpoint.nextExpectedStep ?? previous?.checkpoint?.nextExpectedStep,
        CHECKPOINT_LIMITS.nextExpectedStep
      ),
      chatUrl: patch.checkpoint.chatUrl ?? previous?.checkpoint?.chatUrl ?? url,
      projectUrl: patch.checkpoint.projectUrl ?? previous?.checkpoint?.projectUrl ?? projectUrl,
      transport: capTransportProjection(patch.checkpoint.transport ?? previous?.checkpoint?.transport),
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    url,
    title: patch.title ?? previous?.title,
    taskId: patch.taskId ?? previous?.taskId,
    iteration: patch.iteration ?? previous?.iteration,
    lastState: patch.lastState ?? previous?.lastState,
    conversationMode: conversationMode === "project" && projectUrl ? "project" : conversationMode,
    projectUrl,
    connectorName: patch.connectorName ?? previous?.connectorName,
    transport: capTransportProjection(patch.transport ?? previous?.transport),
    checkpoint,
    savedAt: new Date().toISOString(),
  };
}

/** Drop the current chat pointer. Keep Project binding so the collection stays. */
export function clearChatPointer(workspaceId: string): { cleared: boolean; keptProject: boolean } {
  const previous = readSession(workspaceId);
  if (!previous) return { cleared: false, keptProject: false };
  const view = resolveConversation(previous);
  if (view.mode === "project" && view.projectUrl) {
    writeSession(workspaceId, {
      conversationMode: "project",
      projectUrl: view.projectUrl,
      connectorName: previous.connectorName,
      transport: previous.transport,
      checkpoint: previous.checkpoint,
      savedAt: new Date().toISOString(),
    });
    return { cleared: true, keptProject: true };
  }
  fs.rmSync(sessionFile(workspaceId), { force: true });
  return { cleared: true, keptProject: false };
}
