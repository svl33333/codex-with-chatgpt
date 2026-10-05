import { describe, it, expect } from "vitest";
import {
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  normalizeProjectDisplayName,
  projectDisplayNameForWorkspace,
  projectDisplayNameForWorkstream,
  validateProjectDisplayName,
  CHATGPT_PROJECT_DISPLAY_NAME_LIMIT,
  APPROVED_A0_PROJECT_DISPLAY_NAME,
  reclaimUserMessage,
} from "../src/config/endpoint.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Codex with ChatGPT")).toContain("削除");
    expect(reclaimUserMessage("Codex with ChatGPT")).not.toContain("Reconnect");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Codex with ChatGPT",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("keeps the legacy title when this workspace was used before the name field existed", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Codex with ChatGPT · Landing");
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});

describe("Project display-name compatibility", () => {
  it("accepts bounded names without changing them", () => {
    const name = "codex-with-chatgpt-a0-surface-compatibility";
    expect(validateProjectDisplayName(name).isValid).toBe(true);
    expect(normalizeProjectDisplayName(name)).toBe(name);
  });

  it("normalizes the observed A0 overlong label to the approved replacement", () => {
    expect(
      projectDisplayNameForWorkstream("a0-chatgpt-surface-compatibility")
    ).toBe(APPROVED_A0_PROJECT_DISPLAY_NAME);
    expect(Array.from(APPROVED_A0_PROJECT_DISPLAY_NAME).length).toBeLessThanOrEqual(
      CHATGPT_PROJECT_DISPLAY_NAME_LIMIT
    );
  });

  it("exposes the normalized A0 label through the workspace/setup payload helper", () => {
    expect(
      projectDisplayNameForWorkspace("codex-with-chatgpt-a0-chatgpt-surface-compatibility", {
        workspaceId: "workspace-a0",
      })
    ).toBe(APPROVED_A0_PROJECT_DISPLAY_NAME);
  });

  it("uses a deterministic identity-derived suffix for other overlong labels", () => {
    const input = "codex-with-chatgpt-a-workstream-with-a-deliberately-long-generated-name";
    const context = { durableWorkstreamIdentity: "a-workstream", workspaceId: "workspace-a", connectorName: "a0" };
    const first = normalizeProjectDisplayName(input, context);
    expect(first).toBe(normalizeProjectDisplayName(input, context));
    expect(Array.from(first).length).toBeLessThanOrEqual(CHATGPT_PROJECT_DISPLAY_NAME_LIMIT);
    expect(first).not.toBe(normalizeProjectDisplayName(input, { ...context, workspaceId: "workspace-b" }));
  });

  it("preserves the identity suffix and code-point boundary for non-BMP names", () => {
    const input = "😀".repeat(80);
    const first = normalizeProjectDisplayName(input, {
      durableWorkstreamIdentity: "emoji-workstream",
      workspaceId: "workspace-a",
    });
    const second = normalizeProjectDisplayName(input, {
      durableWorkstreamIdentity: "emoji-workstream",
      workspaceId: "workspace-b",
    });

    expect(Array.from(first).length).toBeLessThanOrEqual(CHATGPT_PROJECT_DISPLAY_NAME_LIMIT);
    expect(first).toMatch(/-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("\uFFFD");
  });

  it("uses one canonical identity input across production payload contexts", () => {
    const workspace = "codex-with-chatgpt-generic-workstream-with-a-deliberately-long-generated-name";
    const fromDoctor = projectDisplayNameForWorkspace(workspace, {
      workspaceId: "workspace-generic",
      connectorName: "Codex with ChatGPT · old label",
    });
    const fromWorkspace = projectDisplayNameForWorkspace(workspace, {
      workspaceId: "workspace-generic",
      connectorName: "Codex with ChatGPT · repaired label",
    });
    expect(fromDoctor).toBe(fromWorkspace);
    expect(Array.from(fromDoctor).length).toBeLessThanOrEqual(CHATGPT_PROJECT_DISPLAY_NAME_LIMIT);
  });
});
