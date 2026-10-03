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

/** Pick the highest-preference route whose account and workspace are verified. */
export function selectSupportedSurface(
  observations: readonly SurfaceObservation[],
  capability: SurfaceCapability = "create_app"
): SurfaceSelection {
  const ordered = [...observations].sort((left, right) => left.routePreference - right.routePreference);
  const usable = ordered.find(
    (observation) =>
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
  if (ordered.some(hasRecoverableFailure)) {
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
