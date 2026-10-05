import { projectDisplayNameForWorkspace } from "../config/endpoint.js";

export const PROJECT_NAME_LIMIT = 50;

export interface ProjectIdentityEvidence {
  projectId: string;
  projectUrl: string;
  ownerAccountId: string;
  workspaceId: string;
  connectorName: string;
  memoryMode: "project-only" | "default" | "unknown";
  chatMode: "chat" | "work" | "unknown";
  librarySourceCount: number;
  instructionsFingerprint?: string;
}

export interface IntendedProjectBinding {
  workspaceId: string;
  connectorName: string;
  ownerAccountId: string;
  projectId?: string;
  projectInstructionsFingerprint?: string;
}

export type ProjectReconciliationResult =
  | { outcome: "REUSED"; project: ProjectIdentityEvidence; needsRepair: boolean }
  | { outcome: "CREATE"; displayName: string }
  | { outcome: "HUMAN_BOUNDARY"; reason: "ambiguous_identity" | "bound_identity_missing"; candidates: ProjectIdentityEvidence[] };

/** Semantic destinations are control contracts; coordinates and labels are not. */
export type ProjectSurface =
  | "project-creation-form"
  | "project-collection"
  | "project-settings"
  | "project-instructions"
  | "reviewer-composer"
  | "connector-configuration"
  | "oauth-pairing-form";

export type ProjectAction =
  | "create-project"
  | "open-settings"
  | "save-instructions"
  | "send-review"
  | "authorize";

export interface ProjectSurfaceObservation {
  surface: ProjectSurface;
  visible: boolean;
  projectId?: string;
  controlId?: string;
  controlRole?: string;
  controlReady?: boolean;
}

export interface ProjectSettingsConfirmation {
  projectId: string;
  instructionsFingerprint: string;
  memoryMode: "project-only";
  librarySourceCount: 0;
  saved: true;
}

export function projectDisplayName(workspaceName: string, workspaceId = ""): string {
  const identity = workspaceName.trim().replace(/\s+/g, " ") || "workspace";
  const name = projectDisplayNameForWorkspace(identity, { workspaceId });
  return Array.from(name).slice(0, PROJECT_NAME_LIMIT).join("");
}

export function isProjectIdentityMatch(candidate: ProjectIdentityEvidence, intended: IntendedProjectBinding): boolean {
  return (
    Boolean(candidate.projectId && candidate.projectUrl && candidate.ownerAccountId) &&
    candidate.ownerAccountId === intended.ownerAccountId &&
    candidate.workspaceId === intended.workspaceId &&
    candidate.connectorName === intended.connectorName &&
    (intended.projectId === undefined || candidate.projectId === intended.projectId)
  );
}

export function isValidProjectCandidate(candidate: ProjectIdentityEvidence, intended: IntendedProjectBinding): boolean {
  return (
    isProjectIdentityMatch(candidate, intended) &&
    candidate.memoryMode === "project-only" &&
    candidate.chatMode === "chat" &&
    candidate.librarySourceCount === 0 &&
    (intended.projectInstructionsFingerprint === undefined ||
      candidate.instructionsFingerprint === intended.projectInstructionsFingerprint)
  );
}

/** Reconcile by durable identity; display-name matches are never sufficient. */
export function reconcileProject(
  workspaceName: string,
  intended: IntendedProjectBinding,
  candidates: readonly ProjectIdentityEvidence[]
): ProjectReconciliationResult {
  const identityMatches = candidates.filter((candidate) => isProjectIdentityMatch(candidate, intended));
  if (identityMatches.length === 1) {
    const project = identityMatches[0];
    return { outcome: "REUSED", project, needsRepair: !isValidProjectCandidate(project, intended) };
  }
  if (identityMatches.length > 1) {
    return { outcome: "HUMAN_BOUNDARY", reason: "ambiguous_identity", candidates: [...identityMatches] };
  }
  if (intended.projectId !== undefined) {
    return { outcome: "HUMAN_BOUNDARY", reason: "bound_identity_missing", candidates: [...candidates] };
  }
  return { outcome: "CREATE", displayName: projectDisplayName(workspaceName, intended.workspaceId) };
}

/** Fail closed when a semantic UI destination is not the intended control. */
export function requireProjectSurface(
  observation: ProjectSurfaceObservation,
  expected: ProjectSurface,
  action: ProjectAction,
  expectedProjectId?: string
): void {
  if (
    !observation.visible ||
    observation.surface !== expected ||
    observation.controlReady === false ||
    (observation.projectId !== undefined && observation.projectId.length === 0) ||
    (expectedProjectId !== undefined && observation.projectId !== expectedProjectId)
  ) {
    if (expected === "project-instructions") throw new Error("C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS");
    throw new Error(`C2C_CAPABILITY_UNAVAILABLE:${action}:${expected}`);
  }
}

export function confirmProjectSettingsSaved(
  confirmation: ProjectSettingsConfirmation,
  expectedProjectId: string,
  expectedInstructionsFingerprint: string
): boolean {
  return (
    confirmation.saved === true &&
    confirmation.projectId === expectedProjectId &&
    confirmation.instructionsFingerprint === expectedInstructionsFingerprint &&
    confirmation.memoryMode === "project-only" &&
    confirmation.librarySourceCount === 0
  );
}
