export type ChatGPTSurfaceId =
  | "plugin-hub-custom-mcp"
  | "settings-custom-app"
  | "authenticated-browser-profile";

export type SurfaceCapability =
  | "create_app"
  | "authorize"
  | "select_app"
  | "verify_project"
  | "verify_account";

export type SurfaceStatus = "available" | "unavailable" | "unknown" | "human_boundary";

export type SurfaceOutcome =
  | "REUSED"
  | "CREATED"
  | "RECOVERED"
  | "HUMAN_BOUNDARY"
  | "RECOVERABLE_FAILURE"
  | "REQUIRED_CAPABILITY_UNAVAILABLE";

export type CustomMcpRouteStatus = "READY" | "ROUTE_DRIFT" | "HUMAN_REQUIRED" | "REQUIRED_CAPABILITY_UNAVAILABLE";

/** Observable app-shell checkpoints for the supported custom-MCP creation path. */
export interface CustomMcpRouteObservation {
  surface: ChatGPTSurfaceId;
  appShellVisible: boolean;
  pluginsRouteVisible: boolean;
  inheritedFilterCleared: boolean;
  addVisible: boolean;
  createCustomMcpVisible: boolean;
  settingsRedirected?: boolean;
  routeDrift?: boolean;
  accountStatus?: SurfaceStatus;
  workspaceStatus?: SurfaceStatus;
}

export interface CustomMcpRouteSelection {
  status: CustomMcpRouteStatus;
  recoverySurface?: "plugin-hub-custom-mcp";
  reason: string;
}

export interface SurfaceObservation {
  surface: ChatGPTSurfaceId;
  routePreference: number;
  originStatus: "verified" | "unverified" | "mismatch";
  accountStatus: SurfaceStatus;
  workspaceStatus: SurfaceStatus;
  capabilities: Partial<Record<SurfaceCapability, SurfaceStatus>>;
  policyStatus: SurfaceStatus;
  browserStatus: SurfaceStatus;
  routeDrift?: boolean;
  reason?: string;
}

export interface SurfaceSelection {
  selected: SurfaceObservation | null;
  capability: SurfaceCapability;
  outcome?: SurfaceOutcome;
  reason?: string;
}

function hasHumanBoundary(observation: SurfaceObservation): boolean {
  return [
    observation.originStatus === "mismatch",
    observation.accountStatus === "human_boundary",
    observation.workspaceStatus === "human_boundary",
    observation.policyStatus === "human_boundary",
    observation.browserStatus === "human_boundary",
    ...Object.values(observation.capabilities).map((status) => status === "human_boundary"),
  ].some(Boolean);
}

function hasRecoverableFailure(observation: SurfaceObservation): boolean {
  return [
    observation.originStatus === "unverified",
    observation.accountStatus === "unknown",
    observation.workspaceStatus === "unknown",
    observation.browserStatus === "unknown" || observation.browserStatus === "unavailable",
    observation.routeDrift === true,
    ...Object.values(observation.capabilities).map((status) => status === "unknown"),
  ].some(Boolean);
}

function isCreationRouteDrift(observation: SurfaceObservation, capability: SurfaceCapability): boolean {
  return capability === "create_app" && observation.surface === "settings-custom-app";
}

/**
 * Classify the semantic app-shell creation route. Settings is a management
 * surface only; a redirect there is recoverable route drift, never proof that
 * custom MCP creation is unavailable.
 */
export function selectCustomMcpCreationRoute(observation: CustomMcpRouteObservation): CustomMcpRouteSelection {
  if (observation.accountStatus === "human_boundary" || observation.workspaceStatus === "human_boundary") {
    return { status: "HUMAN_REQUIRED", reason: "account or workspace security boundary is unresolved" };
  }
  const routeDrift = observation.routeDrift === true || observation.settingsRedirected === true || observation.surface === "settings-custom-app";
  if (routeDrift) {
    return {
      status: "ROUTE_DRIFT",
      recoverySurface: "plugin-hub-custom-mcp",
      reason: "historical creation route landed on Settings; recover through the plugin app-shell",
    };
  }
  if (
    observation.surface === "plugin-hub-custom-mcp" &&
    observation.appShellVisible &&
    observation.pluginsRouteVisible &&
    observation.inheritedFilterCleared &&
    observation.addVisible &&
    observation.createCustomMcpVisible
  ) {
    return { status: "READY", reason: "plugin app-shell exposes Add and Create custom MCP server" };
  }
  return { status: "REQUIRED_CAPABILITY_UNAVAILABLE", reason: "plugin app-shell does not expose the observable custom-MCP creation controls" };
}

/** Pick the highest-preference route whose account and workspace are verified. */
export function selectSupportedSurface(
  observations: readonly SurfaceObservation[],
  capability: SurfaceCapability = "create_app"
): SurfaceSelection {
  const ordered = [...observations].sort((left, right) => left.routePreference - right.routePreference);
  const usable = ordered.find(
    (observation) =>
      !isCreationRouteDrift(observation, capability) &&
      observation.originStatus === "verified" &&
      observation.accountStatus === "available" &&
      observation.workspaceStatus === "available" &&
      observation.policyStatus !== "human_boundary" &&
      observation.browserStatus === "available" &&
      observation.capabilities[capability] === "available"
  );
  if (usable) return { selected: usable, capability };

  if (ordered.some(hasHumanBoundary)) {
    return { selected: null, capability, outcome: "HUMAN_BOUNDARY", reason: "surface requires an account or security decision" };
  }
  if (ordered.some((observation) => hasRecoverableFailure(observation) || isCreationRouteDrift(observation, capability))) {
    return { selected: null, capability, outcome: "RECOVERABLE_FAILURE", reason: "supported surface is not currently verified" };
  }
  return {
    selected: null,
    capability,
    outcome: "REQUIRED_CAPABILITY_UNAVAILABLE",
    reason: `no supported surface exposes ${capability}`,
  };
}

/** Convert a verified surface plus connector mutations into a compatibility outcome. */
export function classifyConnectionOutcome(
  status: "READY" | "CONNECTION_WAITING" | "BLOCKED",
  mutations: { create: number; delete: number },
  reason?: string
): { outcome: SurfaceOutcome; reason?: string } {
  if (status === "READY" && mutations.create === 0 && mutations.delete === 0) return { outcome: "REUSED" };
  if (status === "READY" && mutations.create > 0 && mutations.delete === 0) return { outcome: "CREATED" };
  if (status === "READY" && mutations.delete > 0) return { outcome: "RECOVERED" };
  if (status === "CONNECTION_WAITING") return { outcome: "RECOVERABLE_FAILURE", reason };
  return { outcome: "HUMAN_BOUNDARY", reason };
}
