export type SetupMode = "auto" | "manual";
export type PairingStrategy = "runtime_handoff" | "compatibility";
export type PairingStrategyOverride = "auto" | "compatibility";

export interface PairingCapability {
  runtimeHandoff: boolean;
  exactBinding: boolean;
  verifiedOAuthSurface: boolean;
  automaticSubmission: boolean;
}

export interface PairingStrategySelection {
  strategy: PairingStrategy;
  automatic: boolean;
  reason: "runtime_handoff_ready" | "compatibility_override" | "compatibility_fallback" | "manual_mode";
}

/**
 * Select the strongest proven path without turning an automatic failure into
 * routine manual setup. The compatibility path is the published fallback.
 */
export function selectPairingStrategy(input: {
  setupMode: SetupMode;
  override?: PairingStrategyOverride;
  capability?: Partial<PairingCapability>;
}): PairingStrategySelection {
  if (input.setupMode === "manual") {
    return { strategy: "compatibility", automatic: false, reason: "manual_mode" };
  }
  if (input.override === "compatibility") {
    return { strategy: "compatibility", automatic: true, reason: "compatibility_override" };
  }
  const capability = input.capability ?? {};
  const runtimeHandoffReady =
    capability.runtimeHandoff === true &&
    capability.exactBinding === true &&
    capability.verifiedOAuthSurface === true &&
    capability.automaticSubmission === true;
  if (runtimeHandoffReady) {
    return { strategy: "runtime_handoff", automatic: true, reason: "runtime_handoff_ready" };
  }
  return { strategy: "compatibility", automatic: true, reason: "compatibility_fallback" };
}

export const determinePairingStrategy = selectPairingStrategy;

export function isAutomaticPairingStrategy(value: PairingStrategySelection): boolean {
  return value.automatic && (value.strategy === "runtime_handoff" || value.strategy === "compatibility");
}
