import { describe, expect, it } from "vitest";
import {
  confirmProjectSettingsSaved,
  isProjectIdentityMatch,
  projectDisplayName,
  reconcileProject,
  requireProjectSurface,
  type ProjectIdentityEvidence,
} from "../src/provisioning/project.js";
import { reconcileProjectRuntime, verifyProjectSettingsSave } from "../src/provisioning/project-runtime.js";

const intended = {
  workspaceId: "workspace-c",
  connectorName: "Codex with ChatGPT · workspace-c",
  ownerAccountId: "account-1",
  projectInstructionsFingerprint: "instructions-1",
};

function candidate(overrides: Partial<ProjectIdentityEvidence> = {}): ProjectIdentityEvidence {
  return {
    projectId: "project-1",
    projectUrl: "https://chatgpt.com/g/g-p-project-1/project",
    ownerAccountId: "account-1",
    workspaceId: "workspace-c",
    connectorName: "Codex with ChatGPT · workspace-c",
    memoryMode: "project-only",
    chatMode: "chat",
    librarySourceCount: 0,
    instructionsFingerprint: "instructions-1",
    ...overrides,
  };
}

describe("semantic Project reconciliation", () => {
  it("reuses one exact durable identity and repairs readiness drift", () => {
    expect(reconcileProjectRuntime({ workspaceName: "workspace-c", intended, candidates: [candidate({ chatMode: "work" })] }))
      .toMatchObject({ outcome: "REUSED", needsRepair: true });
  });

  it("creates only when no durable identity matches and normalizes the label", () => {
    const result = reconcileProject("workspace-c", intended, [candidate({ ownerAccountId: "other" })]);
    expect(result).toMatchObject({ outcome: "CREATE" });
    if (result.outcome === "CREATE") expect(Array.from(result.displayName).length).toBeLessThanOrEqual(50);
    expect(projectDisplayName("workspace-c".repeat(20).slice(0, 80), "workspace-c")).toHaveLength(50);
  });

  it("fails closed for ambiguous exact identities and never chooses by display name", () => {
    const result = reconcileProject("same-name", intended, [candidate(), candidate({ projectId: "project-2" })]);
    expect(result).toMatchObject({ outcome: "HUMAN_BOUNDARY", reason: "ambiguous_identity" });
  });

  it("fails closed when the previously bound Project identity disappears", () => {
    const result = reconcileProject("workspace-c", { ...intended, projectId: "bound-project" }, [candidate({ projectId: "different-project" })]);
    expect(result).toMatchObject({ outcome: "HUMAN_BOUNDARY", reason: "bound_identity_missing" });
  });

  it("does not accept display-name similarity as identity", () => {
    expect(isProjectIdentityMatch(candidate({ connectorName: "other" }), intended)).toBe(false);
    expect(reconcileProject("workspace-c", intended, [candidate({ connectorName: "other" })])).toMatchObject({ outcome: "CREATE" });
  });

  it("keeps Project Instructions out of the reviewer composer", () => {
    expect(() => requireProjectSurface({ surface: "reviewer-composer", visible: true }, "project-instructions", "save-instructions"))
      .toThrow("C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS");
    expect(() => requireProjectSurface({ surface: "project-instructions", visible: true, controlReady: true }, "project-instructions", "save-instructions"))
      .not.toThrow();
  });

  it("requires machine-verifiable settings confirmation", () => {
    const confirmation = {
      projectId: "project-1",
      instructionsFingerprint: "instructions-1",
      memoryMode: "project-only" as const,
      librarySourceCount: 0 as const,
      saved: true as const,
    };
    expect(confirmProjectSettingsSaved(confirmation, "project-1", "instructions-1")).toBe(true);
    expect(() => verifyProjectSettingsSave(
      { surface: "reviewer-composer", visible: true },
      confirmation,
      "project-1",
      "instructions-1"
    )).toThrow("C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS");
    expect(verifyProjectSettingsSave(
      { surface: "project-instructions", visible: true, projectId: "project-1", controlReady: true },
      confirmation,
      "project-1",
      "instructions-1"
    )).toBe(true);
    expect(() => verifyProjectSettingsSave(
      { surface: "project-instructions", visible: true, controlReady: true },
      confirmation,
      "project-1",
      "instructions-1"
    )).toThrow("C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS");
    expect(() => verifyProjectSettingsSave(
      { surface: "project-instructions", visible: true, projectId: "project-2", controlReady: true },
      confirmation,
      "project-1",
      "instructions-1"
    )).toThrow("C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS");
  });
});
