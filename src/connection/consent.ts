import { SUPPORTED_SCOPES } from "../auth/store.js";
import type { ConnectionBinding } from "./identity.js";

export type ConnectorConsentSurface = "chatgpt-unreviewed-mcp" | "unknown";
export type ConnectorConsentAction = "AUTO_CONFIRM" | "HUMAN_REQUIRED";

type ConsentBinding = Pick<
  ConnectionBinding,
  "workspace" | "canonicalRepository" | "installationId" | "endpointMode" | "endpointFingerprint" | "connectorName"
>;

export interface ConnectorConsentContext {
  setupMode: "auto" | "manual" | null;
  explicitC2CRequest: boolean;
  consentSurface: ConnectorConsentSurface;
  ownershipResolved: boolean;
  accountIdentityResolved: boolean;
  expected: ConsentBinding;
  observed: ConsentBinding & { scopes: readonly string[] };
  blockers?: {
    loginRequired?: boolean;
    captcha?: boolean;
    twoFactor?: boolean;
    destructive?: boolean;
    unexpectedAccount?: boolean;
  };
}

export interface ConnectorConsentDecision {
  action: ConnectorConsentAction;
  reason: string;
}

const DEFAULT_EXPECTED_SCOPES = [...SUPPORTED_SCOPES];

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actual.length === actualSet.size && actualSet.size === expectedSet.size && expected.every((scope) => actualSet.has(scope));
}

function matchesExpectedBinding(expected: ConsentBinding, observed: ConsentBinding): boolean {
  return (
    observed.workspace === expected.workspace &&
    observed.canonicalRepository === expected.canonicalRepository &&
    observed.installationId === expected.installationId &&
    observed.endpointMode === expected.endpointMode &&
    observed.endpointFingerprint === expected.endpointFingerprint &&
    observed.connectorName === expected.connectorName
  );
}

/**
 * Decide whether a visible ChatGPT warning belongs to this exact read-only C2C
 * operation. The browser layer must establish the structured consent surface
 * and binding from the live DOM before calling this function; warning text by
 * itself is never sufficient.
 */
export function determineConnectorConsentAction(context: ConnectorConsentContext): ConnectorConsentDecision {
  if (context.setupMode !== "auto") {
    return { action: "HUMAN_REQUIRED", reason: "setup mode is not auto" };
  }
  if (!context.explicitC2CRequest) {
    return { action: "HUMAN_REQUIRED", reason: "explicit C2C request is not established" };
  }
  if (context.consentSurface !== "chatgpt-unreviewed-mcp") {
    return { action: "HUMAN_REQUIRED", reason: "consent surface is not the verified ChatGPT C2C warning" };
  }
  if (!context.ownershipResolved) {
    return { action: "HUMAN_REQUIRED", reason: "connector ownership is unresolved" };
  }
  if (!context.accountIdentityResolved) {
    return { action: "HUMAN_REQUIRED", reason: "ChatGPT account identity is unresolved" };
  }

  const blockers = context.blockers ?? {};
  if (blockers.loginRequired) return { action: "HUMAN_REQUIRED", reason: "ChatGPT login is required" };
  if (blockers.captcha) return { action: "HUMAN_REQUIRED", reason: "CAPTCHA is present" };
  if (blockers.twoFactor) return { action: "HUMAN_REQUIRED", reason: "unsupported 2FA is present" };
  if (blockers.destructive) return { action: "HUMAN_REQUIRED", reason: "operation is destructive or security-sensitive" };
  if (blockers.unexpectedAccount) return { action: "HUMAN_REQUIRED", reason: "account selection is ambiguous" };

  if (!matchesExpectedBinding(context.expected, context.observed)) {
    return { action: "HUMAN_REQUIRED", reason: "connector identity, endpoint, or workspace binding mismatches" };
  }

  // Keep the allowed set owned by the runtime. A browser adapter must not be
  // able to widen this gate by supplying write or administrative scopes as
  // its own "expected" value.
  if (!sameStringSet(context.observed.scopes, DEFAULT_EXPECTED_SCOPES)) {
    return { action: "HUMAN_REQUIRED", reason: "OAuth scopes are unexpected" };
  }

  return {
    action: "AUTO_CONFIRM",
    reason: "verified expected read-only C2C connector consent",
  };
}

export function connectorConsentBinding(binding: ConnectionBinding): ConsentBinding {
  return {
    workspace: binding.workspace,
    canonicalRepository: binding.canonicalRepository,
    installationId: binding.installationId,
    endpointMode: binding.endpointMode,
    endpointFingerprint: binding.endpointFingerprint,
    connectorName: binding.connectorName,
  };
}
