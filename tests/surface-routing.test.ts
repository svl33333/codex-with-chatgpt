import { describe, expect, it } from "vitest";
import {
  classifyConnectionOutcome,
  selectCustomMcpCreationRoute,
  selectSupportedSurface,
  type SurfaceObservation,
} from "../src/provisioning/chatgpt-surface.js";

function observation(overrides: Partial<SurfaceObservation> = {}): SurfaceObservation {
  return {
    surface: "plugin-hub-custom-mcp",
    routePreference: 1,
    originStatus: "verified",
    accountStatus: "available",
    workspaceStatus: "available",
    capabilities: { create_app: "available" },
    policyStatus: "available",
    browserStatus: "available",
    ...overrides,
  };
}

describe("ChatGPT surface selection", () => {
  it("does not treat Settings as the custom-MCP creation authority", () => {
    const result = selectSupportedSurface([
      observation({ routePreference: 2, surface: "settings-custom-app" }),
      observation({ routePreference: 1, routeDrift: true, capabilities: { create_app: "unavailable" } }),
    ]);
    expect(result.selected).toBeNull();
    expect(result.outcome).toBe("RECOVERABLE_FAILURE");
  });

  it("classifies stale or unavailable routes as recoverable while a fallback is unverified", () => {
    const result = selectSupportedSurface([
      observation({ routeDrift: true, capabilities: { create_app: "unavailable" } }),
      observation({ surface: "settings-custom-app", accountStatus: "unknown" }),
    ]);
    expect(result.outcome).toBe("RECOVERABLE_FAILURE");
  });

  it("keeps security/account boundaries distinct from capability absence", () => {
    const result = selectSupportedSurface([observation({ accountStatus: "human_boundary" })]);
    expect(result.outcome).toBe("HUMAN_BOUNDARY");
    expect(selectSupportedSurface([observation({ capabilities: { create_app: "unavailable" } })]).outcome).toBe(
      "REQUIRED_CAPABILITY_UNAVAILABLE"
    );
  });
});

describe("semantic custom-MCP app-shell route", () => {
  const ready = {
    surface: "plugin-hub-custom-mcp" as const,
    appShellVisible: true,
    pluginsRouteVisible: true,
    inheritedFilterCleared: true,
    addVisible: true,
    createCustomMcpVisible: true,
    accountStatus: "available" as const,
    workspaceStatus: "available" as const,
  };

  it("requires the app-shell, filter clearing, Add, and Create controls", () => {
    expect(selectCustomMcpCreationRoute(ready)).toMatchObject({ status: "READY" });
    expect(selectCustomMcpCreationRoute({ ...ready, inheritedFilterCleared: false }).status).toBe(
      "REQUIRED_CAPABILITY_UNAVAILABLE"
    );
  });

  it("classifies a Settings redirect as route drift with app-shell recovery", () => {
    expect(selectCustomMcpCreationRoute({
      ...ready,
      surface: "settings-custom-app",
      settingsRedirected: true,
      addVisible: false,
      createCustomMcpVisible: false,
    })).toMatchObject({ status: "ROUTE_DRIFT", recoverySurface: "plugin-hub-custom-mcp" });
  });

  it("keeps account boundaries distinct from capability absence", () => {
    expect(selectCustomMcpCreationRoute({ ...ready, accountStatus: "human_boundary" }).status).toBe("HUMAN_REQUIRED");
  });
});

describe("connector outcome mapping", () => {
  it("maps zero-mutation reuse and endpoint recovery without replacing reconciler states", () => {
    expect(classifyConnectionOutcome("READY", { create: 0, delete: 0 }).outcome).toBe("REUSED");
    expect(classifyConnectionOutcome("READY", { create: 1, delete: 0 }).outcome).toBe("CREATED");
    expect(classifyConnectionOutcome("READY", { create: 1, delete: 1 }).outcome).toBe("RECOVERED");
  });
});
