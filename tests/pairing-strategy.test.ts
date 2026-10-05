import { describe, expect, it } from "vitest";
import { selectPairingStrategy } from "../src/pairing/strategy.js";

describe("automatic pairing strategy", () => {
  it("uses the stronger handoff only when every capability is proven", () => {
    expect(selectPairingStrategy({ setupMode: "auto", capability: {
      runtimeHandoff: true, exactBinding: true, verifiedOAuthSurface: true, automaticSubmission: true,
    } })).toMatchObject({ strategy: "runtime_handoff", automatic: true });
  });

  it("falls back automatically to the bounded compatibility path", () => {
    expect(selectPairingStrategy({ setupMode: "auto", capability: { runtimeHandoff: false } }))
      .toMatchObject({ strategy: "compatibility", automatic: true, reason: "compatibility_fallback" });
    expect(selectPairingStrategy({ setupMode: "auto", override: "compatibility" }))
      .toMatchObject({ strategy: "compatibility", automatic: true, reason: "compatibility_override" });
  });

  it("keeps manual behavior explicit rather than an automatic fallback", () => {
    expect(selectPairingStrategy({ setupMode: "manual" })).toMatchObject({ strategy: "compatibility", automatic: false, reason: "manual_mode" });
  });
});
