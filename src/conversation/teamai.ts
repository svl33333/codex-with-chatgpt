import type { TeamAiCredentialClassification } from "./authorization.js";

const TEAMAI_RESULT: unique symbol = Symbol("teamai-github-cli-auth-result");
const TEAMAI_PROVIDER: unique symbol = Symbol("teamai-github-cli-auth-provider");

export interface TeamAiObservation {
  restrictedContextError?: string;
  expectedAccount?: string;
  credentialVisibleAccount?: string;
  authAttemptId?: string;
  correlationId: string;
}

export interface TeamAiCapabilityProvider {
  /** Only a provider resolved by the TeamAI-owned boundary may classify. */
  readonly [TEAMAI_PROVIDER]: true;
  readonly source: "teamai";
  readonly skillName: "github-cli-auth";
  readonly capabilityVersion: string;
  classify(observation: TeamAiObservation): {
    classification: TeamAiCredentialClassification;
    correlationId?: string;
    expectedAccount?: string;
  };
}

export interface TeamAiCapabilityProviderDefinition {
  readonly source: "teamai";
  readonly skillName: "github-cli-auth";
  readonly capabilityVersion: string;
  classify(observation: TeamAiObservation): {
    classification: TeamAiCredentialClassification;
    correlationId?: string;
    expectedAccount?: string;
  };
}

export interface TeamAiCapabilityResult {
  readonly [TEAMAI_RESULT]: true;
  readonly classifier: "github-cli-auth";
  readonly source: "teamai";
  readonly capabilityVersion: string;
  readonly classification: TeamAiCredentialClassification;
  readonly correlationId: string;
  readonly expectedAccount?: string;
  readonly authAttemptId?: string;
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/[\r\n]+/g, " ");
  return normalized ? normalized.slice(0, max) : undefined;
}

function isClassification(value: unknown): value is TeamAiCredentialClassification {
  return value === "healthy" || value === "credential_context_unavailable" || value === "auth_invalid_or_expired" || value === "human_security_boundary" || value === "capability_unavailable";
}

/**
 * Brand a provider returned by the TeamAI github-cli-auth runtime boundary.
 * The durable A0 layer never accepts a structural object or a JSON result as
 * a classifier; the TeamAI-owned provider invocation must supply the result.
 */
export function createTeamAiCapabilityProvider(
  provider: TeamAiCapabilityProviderDefinition
): TeamAiCapabilityProvider {
  if (provider.source !== "teamai" || provider.skillName !== "github-cli-auth" || !bounded(provider.capabilityVersion, 128) || typeof provider.classify !== "function") {
    throw new Error("unverified TeamAI github-cli-auth capability provider");
  }
  return {
    [TEAMAI_PROVIDER]: true,
    source: provider.source,
    skillName: provider.skillName,
    capabilityVersion: bounded(provider.capabilityVersion, 128)!,
    classify: provider.classify.bind(provider),
  };
}

export function assertTeamAiCapabilityProvider(value: unknown): asserts value is TeamAiCapabilityProvider {
  if (!value || typeof value !== "object" || (value as { [TEAMAI_PROVIDER]?: unknown })[TEAMAI_PROVIDER] !== true) {
    throw new Error("TeamAI github-cli-auth provider was not resolved by its runtime boundary");
  }
  const provider = value as TeamAiCapabilityProvider;
  if (provider.source !== "teamai" || provider.skillName !== "github-cli-auth" || !bounded(provider.capabilityVersion, 128) || typeof provider.classify !== "function") {
    throw new Error("unverified TeamAI github-cli-auth capability provider");
  }
}

/** Resolve one result from the dynamically selected TeamAI capability. */
export function resolveTeamAiAuthResult(
  provider: TeamAiCapabilityProvider,
  observation: TeamAiObservation
): TeamAiCapabilityResult {
  assertTeamAiCapabilityProvider(provider);
  if (provider.source !== "teamai" || provider.skillName !== "github-cli-auth" || !bounded(provider.capabilityVersion, 128)) {
    throw new Error("unverified TeamAI github-cli-auth capability");
  }
  const correlationId = bounded(observation.correlationId, 256);
  if (!correlationId) throw new Error("TeamAI auth observation correlation is required");
  const result = provider.classify({
    ...observation,
    correlationId,
    ...(bounded(observation.restrictedContextError, 512) ? { restrictedContextError: bounded(observation.restrictedContextError, 512) } : {}),
    ...(bounded(observation.expectedAccount, 256) ? { expectedAccount: bounded(observation.expectedAccount, 256) } : {}),
    ...(bounded(observation.credentialVisibleAccount, 256) ? { credentialVisibleAccount: bounded(observation.credentialVisibleAccount, 256) } : {}),
    ...(bounded(observation.authAttemptId, 256) ? { authAttemptId: bounded(observation.authAttemptId, 256) } : {}),
  });
  if (!isClassification(result.classification)) throw new Error("TeamAI returned an unsupported authentication classification");
  const returnedCorrelation = bounded(result.correlationId, 256) ?? correlationId;
  if (returnedCorrelation !== correlationId) throw new Error("TeamAI result correlation does not match the observation");
  return {
    [TEAMAI_RESULT]: true,
    classifier: "github-cli-auth",
    source: "teamai",
    capabilityVersion: bounded(provider.capabilityVersion, 128)!,
    classification: result.classification,
    correlationId,
    ...(bounded(result.expectedAccount ?? observation.expectedAccount, 256)
      ? { expectedAccount: bounded(result.expectedAccount ?? observation.expectedAccount, 256) }
      : {}),
    ...(bounded(observation.authAttemptId, 256) ? { authAttemptId: bounded(observation.authAttemptId, 256) } : {}),
  };
}

export function assertTeamAiAuthResult(result: TeamAiCapabilityResult): void {
  if (result[TEAMAI_RESULT] !== true || result.source !== "teamai" || result.classifier !== "github-cli-auth" || !bounded(result.capabilityVersion, 128) || !bounded(result.correlationId, 256) || !isClassification(result.classification)) {
    throw new Error("unverified TeamAI github-cli-auth result");
  }
}
