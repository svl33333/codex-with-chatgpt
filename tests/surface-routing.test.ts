import { describe, expect, it } from "vitest";
import {
  classifyConnectionOutcome,
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
  it("prefers the first verified route with the requested capability", () => {
    const result = selectSupportedSurface([
      observation({ routePreference: 2, surface: "settings-custom-app" }),
      observation({ routePreference: 1, routeDrift: true, capabilities: { create_app: "unavailable" } }),
    ]);
    expect(result.selected?.surface).toBe("settings-custom-app");
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

describe("connector outcome mapping", () => {
  it("maps zero-mutation reuse and endpoint recovery without replacing reconciler states", () => {
    expect(classifyConnectionOutcome("READY", { create: 0, delete: 0 }).outcome).toBe("REUSED");
    expect(classifyConnectionOutcome("READY", { create: 1, delete: 0 }).outcome).toBe("CREATED");
    expect(classifyConnectionOutcome("READY", { create: 1, delete: 1 }).outcome).toBe("RECOVERED");
  });
});
