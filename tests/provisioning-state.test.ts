import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveProvisioningPhase,
  hasProvisioningReadinessProof,
  provisioningFile,
  readProvisioningState,
  writeProvisioningState,
} from "../src/provisioning/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("machine-local C2C provisioning state", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => cleanup(stateDir));

  it("derives ready state from live verification rather than acknowledgement text", () => {
    expect(
      deriveProvisioningPhase({
        workspaceReady: true,
        runtimeReady: true,
        authenticated: true,
        connectorReady: true,
        projectBound: true,
        workspaceVerified: true,
      })
    ).toBe("ready");
  });

  it("keeps genuine human authentication as a distinct boundary", () => {
    expect(
      deriveProvisioningPhase({
        workspaceReady: true,
        runtimeReady: true,
        authenticated: false,
        connectorReady: false,
        projectBound: false,
        workspaceVerified: false,
        humanAuthRequired: true,
      })
    ).toBe("human_auth_required");
  });

  it("represents recoverable repair without requiring a chat acknowledgement", () => {
    expect(
      deriveProvisioningPhase({
        workspaceReady: true,
        runtimeReady: true,
        authenticated: true,
        connectorReady: true,
        projectBound: true,
        workspaceVerified: false,
        repairing: true,
      })
    ).toBe("repairing");
  });

  it("persists only bounded, non-secret state for reuse in a new session", () => {
    const saved = writeProvisioningState("workspace-a", "ready", {
      reason: "workspace_info verified",
      retryCount: 2,
      selectedSurface: "plugin-hub-custom-mcp",
      outcome: "REUSED",
      accountVerified: true,
      readOnlyVerified: true,
      oauthContractVerified: true,
      projectVerified: true,
      messageSelectionVerified: true,
      messageSelectionKey: "message-key-proof",
    });
    expect(readProvisioningState("workspace-a")).toEqual(saved);
    const file = `${stateDir}/provisioning/workspace-a.json`;
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/token|cookie|pairing|messageBody|messageHash/i);
  });

  it("does not persist ready without complete live verification proof", () => {
    const saved = writeProvisioningState("workspace-a", "ready", { reason: "acknowledgement only" });
    expect(saved.phase).toBe("workspace_verification");
    expect(saved.reason).toBe("acknowledgement only");
  });

  it("does not accept a boolean message proof without the matching delivery key", () => {
    const saved = writeProvisioningState("workspace-a", "ready", {
      selectedSurface: "plugin-hub-custom-mcp",
      outcome: "REUSED",
      accountVerified: true,
      readOnlyVerified: true,
      oauthContractVerified: true,
      projectVerified: true,
      messageSelectionVerified: true,
    });
    expect(saved.phase).toBe("workspace_verification");
  });

  it("does not retain ready state from a legacy proof without complete diff pagination", () => {
    const legacyProof = {
      schemaVersion: 1,
      messageKey: "legacy-message",
      appIdentity: { workspaceId: "workspace-legacy-ready", connectorName: "connector", installationId: "install" },
      capability: "read-only",
      repository: "svl33333/codex-with-chatgpt",
      root: "C:/work/codex-with-chatgpt",
      branch: "main",
      head: "c".repeat(40),
      workspaceInfo: {
        workspaceId: "workspace-legacy-ready",
        root: "C:/work/codex-with-chatgpt",
        repository: "svl33333/codex-with-chatgpt",
        git: { isRepo: true, branch: "main", commit: "c".repeat(40) },
      },
      gitStatus: { isRepo: true, branch: "main" },
      gitDiff: { isRepo: true, mode: "unstaged", diff: "", hasMore: false },
      evidenceDigest: "0".repeat(64),
      observedAt: "2026-10-05T00:00:00.000Z",
    };
    const file = provisioningFile("workspace-legacy-ready");
    fs.mkdirSync(`${stateDir}/provisioning`, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      workspaceId: "workspace-legacy-ready",
      phase: "ready",
      outcome: "REUSED",
      selectedSurface: "plugin-hub-custom-mcp",
      accountVerified: true,
      readOnlyVerified: true,
      oauthContractVerified: true,
      projectVerified: true,
      messageSelectionVerified: true,
      messageSelectionKey: "legacy-message",
      reviewerProof: legacyProof,
      updatedAt: "2026-10-05T00:00:00.000Z",
    }));
    const loaded = readProvisioningState("workspace-legacy-ready");
    expect(loaded?.phase).toBe("ready");
    expect(hasProvisioningReadinessProof(loaded!)).toBe(false);
  });

  it("reads legacy schema state without losing its valid non-secret fields", () => {
    const file = provisioningFile("workspace-legacy");
    fs.mkdirSync(`${stateDir}/provisioning`, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      workspaceId: "workspace-legacy",
      phase: "connector_ready",
      outcome: "REUSED",
      selectedSurface: "plugin-hub-custom-mcp",
      updatedAt: "2026-10-04T00:00:00.000Z",
    }));
    expect(readProvisioningState("workspace-legacy")).toMatchObject({
      schemaVersion: 2,
      workspaceId: "workspace-legacy",
      phase: "connector_ready",
      outcome: "REUSED",
      selectedSurface: "plugin-hub-custom-mcp",
    });
  });
});
