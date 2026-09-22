import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

/** Machine-local setup phases. This file never contains credentials or message bodies. */
export const PROVISIONING_PHASES = [
  "uninitialized",
  "runtime_ready",
  "human_auth_required",
  "authenticated",
  "connector_provisioning",
  "connector_ready",
  "project_binding",
  "workspace_verification",
  "ready",
  "degraded",
  "repairing",
  "human_action_required",
] as const;

export type ProvisioningPhase = (typeof PROVISIONING_PHASES)[number];

export interface ProvisioningState {
  schemaVersion: 1;
  workspaceId: string;
  phase: ProvisioningPhase;
  reason?: string;
  retryCount?: number;
  updatedAt: string;
}

export interface ProvisioningObservation {
  workspaceReady: boolean;
  runtimeReady: boolean;
  authenticated: boolean;
  connectorProvisioning?: boolean;
  connectorReady: boolean;
  projectBinding?: boolean;
  projectBound: boolean;
  workspaceVerification?: boolean;
  workspaceVerified: boolean;
  degraded?: boolean;
  repairing?: boolean;
  humanAuthRequired?: boolean;
  humanActionRequired?: boolean;
}

export function provisioningFile(workspaceId: string): string {
  return path.join(getStateDir(), "provisioning", `${workspaceId}.json`);
}

function isPhase(value: unknown): value is ProvisioningPhase {
  return typeof value === "string" && (PROVISIONING_PHASES as readonly string[]).includes(value);
}

export function readProvisioningState(workspaceId: string): ProvisioningState | null {
  const value = readJsonIfExists<Partial<ProvisioningState>>(provisioningFile(workspaceId));
  if (!value || value.schemaVersion !== 1 || value.workspaceId !== workspaceId || !isPhase(value.phase)) return null;
  return {
    schemaVersion: 1,
    workspaceId,
    phase: value.phase,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(typeof value.retryCount === "number" && Number.isSafeInteger(value.retryCount) && value.retryCount >= 0
      ? { retryCount: value.retryCount }
      : {}),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function writeProvisioningState(
  workspaceId: string,
  phase: ProvisioningPhase,
  patch: Pick<ProvisioningState, "reason" | "retryCount"> = {}
): ProvisioningState {
  const next: ProvisioningState = {
    schemaVersion: 1,
    workspaceId,
    phase,
    ...(patch.reason?.trim() ? { reason: patch.reason.trim().slice(0, 400) } : {}),
    ...(patch.retryCount !== undefined && Number.isSafeInteger(patch.retryCount) && patch.retryCount >= 0
      ? { retryCount: patch.retryCount }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  writeSecureJson(provisioningFile(workspaceId), next);
  return next;
}

/** Derive a phase from live observations rather than conversation prose. */
export function deriveProvisioningPhase(observation: ProvisioningObservation): ProvisioningPhase {
  if (observation.humanActionRequired) return "human_action_required";
  if (observation.humanAuthRequired) return "human_auth_required";
  if (observation.repairing) return "repairing";
  if (observation.degraded) return "degraded";
  if (!observation.workspaceReady) return "uninitialized";
  if (!observation.runtimeReady) return "uninitialized";
  if (!observation.authenticated) return "runtime_ready";
  if (observation.connectorProvisioning) return "connector_provisioning";
  if (!observation.connectorReady) return "authenticated";
  if (observation.projectBinding) return "project_binding";
  if (!observation.projectBound) return "connector_ready";
  if (observation.workspaceVerification || !observation.workspaceVerified) return "workspace_verification";
  return "ready";
}
