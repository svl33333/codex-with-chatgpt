import {
  confirmProjectSettingsSaved,
  reconcileProject,
  requireProjectSurface,
  type IntendedProjectBinding,
  type ProjectIdentityEvidence,
  type ProjectReconciliationResult,
  type ProjectSettingsConfirmation,
  type ProjectSurfaceObservation,
} from "./project.js";

/** Pure reconciliation is separated from the Skill/built-in-browser adapter. */
export function reconcileProjectRuntime(input: {
  workspaceName: string;
  intended: IntendedProjectBinding;
  candidates: readonly ProjectIdentityEvidence[];
}): ProjectReconciliationResult {
  return reconcileProject(input.workspaceName, input.intended, input.candidates);
}

/** Save instructions only after the semantic Project Instructions control is verified. */
export function verifyProjectSettingsSave(
  surface: ProjectSurfaceObservation,
  confirmation: ProjectSettingsConfirmation,
  expectedProjectId: string,
  expectedInstructionsFingerprint: string
): true {
  // The semantic control observation must identify the exact durable Project;
  // a separate save confirmation cannot substitute for that live identity.
  requireProjectSurface(surface, "project-instructions", "save-instructions", expectedProjectId);
  if (!confirmProjectSettingsSaved(confirmation, expectedProjectId, expectedInstructionsFingerprint)) {
    throw new Error("C2C_CAPABILITY_UNAVAILABLE:save-instructions:settings-confirmation");
  }
  return true;
}
