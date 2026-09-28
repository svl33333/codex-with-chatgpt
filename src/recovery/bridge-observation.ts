import { adminFetch } from "../process/daemon.js";
import { findBridgeObservation, type RuntimeState } from "../bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";
import { canonicalizeRecoveryRoot, type RecoveryBindingRecord } from "./bindings.js";

export interface RecoveryAdminInfo {
  service: string;
  version: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

export type OwnedBridgeObservation =
  | { state: "healthy"; runtime: RuntimeState; info: RecoveryAdminInfo }
  | { state: "stopped"; runtime: RuntimeState | null; reason: string }
  | { state: "ambiguous"; runtime: RuntimeState | null; reason: string };

export interface BridgeObservationDependencies {
  findBridgeObservation?: typeof findBridgeObservation;
  adminFetch?: <T = unknown>(runtime: RuntimeState, method: "GET" | "POST", route: string, timeoutMs?: number) => Promise<T>;
}

function looksLikeAdminInfo(value: unknown): value is RecoveryAdminInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const tunnel = raw.tunnel as Record<string, unknown> | undefined;
  return (
    raw.service === SERVICE_NAME &&
    typeof raw.version === "string" &&
    typeof raw.workspaceId === "string" &&
    typeof raw.workspaceName === "string" &&
    typeof raw.workspaceRoot === "string" &&
    Number.isInteger(raw.port) &&
    (raw.publicUrl === null || typeof raw.publicUrl === "string") &&
    Boolean(tunnel) &&
    typeof tunnel?.running === "boolean" &&
    (tunnel.url === null || typeof tunnel.url === "string") &&
    typeof tunnel.provider === "string" &&
    Number.isInteger(raw.tokenCount) &&
    typeof raw.pairingActive === "boolean" &&
    Number.isInteger(raw.pid) &&
    typeof raw.startedAt === "string"
  );
}

/**
 * Liveness comes from /health, but ownership-sensitive reuse and shutdown
 * require authenticated /admin/info to agree with persisted runtime state.
 */
export async function observeOwnedBridge(
  expectedRoot: string,
  record?: RecoveryBindingRecord,
  dependencies: BridgeObservationDependencies = {},
): Promise<OwnedBridgeObservation> {
  let workspace: Workspace;
  try {
    workspace = new Workspace(expectedRoot);
  } catch (error) {
    return { state: "ambiguous", runtime: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const observed = await (dependencies.findBridgeObservation ?? findBridgeObservation)(workspace.id);
  if (observed.state === "stopped") {
    return { state: "stopped", runtime: observed.runtime, reason: observed.reason };
  }
  if (observed.state === "unknown") {
    return { state: "ambiguous", runtime: observed.runtime, reason: observed.reason };
  }
  const runtime = observed.runtime;
  let info: RecoveryAdminInfo;
  try {
    const response = await (dependencies.adminFetch ?? adminFetch)<unknown>(runtime, "GET", "/admin/info", 5_000);
    if (!looksLikeAdminInfo(response)) throw new Error("admin/info response is malformed");
    info = response;
  } catch (error) {
    return { state: "ambiguous", runtime, reason: `authenticated admin identity unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let adminRoot: string;
  let runtimeRoot: string;
  try {
    adminRoot = canonicalizeRecoveryRoot(info.workspaceRoot);
    runtimeRoot = canonicalizeRecoveryRoot(runtime.workspaceRoot);
  } catch (error) {
    return { state: "ambiguous", runtime, reason: `bridge root cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}` };
  }
  const expectedCanonical = canonicalizeRecoveryRoot(workspace.root);
  if (
    info.workspaceId !== workspace.id ||
    info.workspaceId !== runtime.workspaceId ||
    adminRoot !== runtimeRoot ||
    adminRoot !== expectedCanonical ||
    runtime.port !== info.port ||
    runtime.pid !== info.pid ||
    runtime.startedAt !== info.startedAt ||
    runtime.publicUrl !== info.publicUrl ||
    info.version !== runtime.version ||
    (record && record.connectionBindingId !== info.workspaceId)
  ) {
    return { state: "ambiguous", runtime, reason: "authenticated bridge identity disagrees with runtime or recovery binding" };
  }
  if (info.service !== SERVICE_NAME || runtime.service !== SERVICE_NAME || info.version !== VERSION) {
    return { state: "ambiguous", runtime, reason: "bridge service/version is not owned by this runtime" };
  }
  return { state: "healthy", runtime, info };
}

export async function verifyOwnedBridgeShutdown(expectedRoot: string, record?: RecoveryBindingRecord): Promise<boolean> {
  const observed = await observeOwnedBridge(expectedRoot, record);
  if (observed.state !== "healthy") return false;
  try {
    await adminFetch(observed.runtime, "POST", "/admin/shutdown", 5_000);
    return true;
  } catch {
    return false;
  }
}
