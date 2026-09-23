import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPES } from "../src/auth/store.js";
import { connectorConsentBinding, determineConnectorConsentAction, type ConnectorConsentContext } from "../src/connection/consent.js";
import type { ConnectionBinding } from "../src/connection/identity.js";

const binding: ConnectionBinding = {
  schemaVersion: 1,
  workspaceId: "workspace-id",
  workspace: "codex-with-chatgpt",
  canonicalRepository: "https://github.com/svl33333/codex-with-chatgpt",
  installationId: "11111111-1111-4111-8111-111111111111",
  endpointMode: "ephemeral",
  endpointFingerprint: "0123456789abcdef01234567",
  connectorName: "Codex with ChatGPT · codex-with-chatgpt · 11111111",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

function context(overrides: Partial<ConnectorConsentContext> = {}): ConnectorConsentContext {
  const expected = connectorConsentBinding(binding);
  return {
    setupMode: "auto",
    explicitC2CRequest: true,
    consentSurface: "chatgpt-unreviewed-mcp",
    ownershipResolved: true,
    accountIdentityResolved: true,
    expected,
    observed: { ...expected, scopes: [...SUPPORTED_SCOPES] },
    ...overrides,
  };
}

describe("determineConnectorConsentAction", () => {
  it("automatically confirms the verified expected C2C warning", () => {
    expect(determineConnectorConsentAction(context())).toEqual({
      action: "AUTO_CONFIRM",
      reason: "verified expected read-only C2C connector consent",
    });
  });

  it("does not require a conversational acknowledgement after the automatic decision", () => {
    const decision = determineConnectorConsentAction(context());
    expect(decision.action).toBe("AUTO_CONFIRM");
    expect("acknowledgementRequired" in decision).toBe(false);
  });

  it("fails closed for a wrong connector identity", () => {
    expect(
      determineConnectorConsentAction(context({ observed: { ...connectorConsentBinding(binding), connectorName: "Other connector", scopes: [...SUPPORTED_SCOPES] } }))
        .action
    ).toBe("HUMAN_REQUIRED");
  });

  it("fails closed for endpoint or workspace mismatch", () => {
    const expected = connectorConsentBinding(binding);
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...expected, endpointFingerprint: "fedcba9876543210fedcba98", scopes: [...SUPPORTED_SCOPES] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...expected, workspace: "other-workspace", scopes: [...SUPPORTED_SCOPES] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
  });

  it("keeps unknown connector consent human-required", () => {
    expect(determineConnectorConsentAction(context({ consentSurface: "unknown" })).action).toBe("HUMAN_REQUIRED");
  });

  it("keeps login, CAPTCHA, and 2FA human-required", () => {
    for (const blockers of [{ loginRequired: true }, { captcha: true }, { twoFactor: true }]) {
      expect(determineConnectorConsentAction(context({ blockers })).action).toBe("HUMAN_REQUIRED");
    }
  });

  it("rejects unexpected OAuth scopes", () => {
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), scopes: [...SUPPORTED_SCOPES, "workspace.write"] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
  });

  it("requires auto setup and an explicit C2C request", () => {
    expect(determineConnectorConsentAction(context({ setupMode: "manual" })).action).toBe("HUMAN_REQUIRED");
    expect(determineConnectorConsentAction(context({ explicitC2CRequest: false })).action).toBe("HUMAN_REQUIRED");
  });
});
