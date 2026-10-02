import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createDelegationGrant,
  delegationApprovalDigest,
  delegationScopeDigest,
  delegationTargetDigest,
  evaluateWorkspaceRead,
  normalizeDelegationScope,
} from "../src/conversation/delegation.js";
import { providerEvidenceProjection } from "../src/conversation/delegation-policy.js";
import { createTeamAiCapabilityProvider, resolveTeamAiAuthResult } from "../src/conversation/teamai.js";
import { cleanup, isolateStateDir } from "./helpers.js";

type Schema = Record<string, any>;

function resolveSchema(schema: Schema, root: Schema): Schema {
  if (typeof schema.$ref !== "string") return schema;
  const match = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!match) throw new Error(`unsupported test schema reference ${schema.$ref}`);
  return root.$defs[match[1]] as Schema;
}

function validate(value: unknown, rawSchema: Schema, root: Schema, location = "$", seen = new Set<string>()): string[] {
  const schema = resolveSchema(rawSchema, root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate: Schema) => validate(value, candidate, root, location, new Set(seen)).length === 0);
    return matches.length === 1 ? [] : [`${location} does not match exactly one schema branch`];
  }
  if (schema.const !== undefined && value !== schema.const) return [`${location} must equal ${String(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${location} is outside the enum`];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location} must be an object`];
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) return [`${location}.${key} is required`];
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) return [`${location}.${key} is not in the schema`];
    }
    const errors: string[] = [];
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) errors.push(...validate(object[key], child as Schema, root, `${location}.${key}`, seen));
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    return value.flatMap((item, index) => validate(item, schema.items as Schema, root, `${location}[${index}]`, seen));
  }
  if (schema.type === "string" && typeof value !== "string") return [`${location} must be a string`];
  if (schema.type === "integer" && (!Number.isInteger(value))) return [`${location} must be an integer`];
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${location} must be a number`];
  if (schema.type === "boolean" && typeof value !== "boolean") return [`${location} must be boolean`];
  return [];
}

function writeApprovalState(root: string, record: { action: string; scopeDigest: string; targetDigest: string; decisionId: string; approvedDigest: string }): string {
  const file = path.join(root, ".harness", "a1-delegated-authorization", "state.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `workflow:\n  step: 5\n  stage: Implementation + C2C Review\n  status: RUNNING\n  step4_approval:\n    approved: true\n    approved_at: 1970-01-01T00:00:01.000Z\n  delegation_approvals:\n    - decision_id: ${record.decisionId}\n      approved_digest: ${record.approvedDigest}\n      action: ${record.action}\n      scope_digest: ${record.scopeDigest}\n      target_digest: ${record.targetDigest}\n      approved_at: 1970-01-01T00:00:01.000Z\n      approver_identity_ref: human:step4\n`);
  return file;
}

describe("A1 serialized grant/proof schema contracts", () => {
  let stateDir: string;
  beforeEach(() => { stateDir = isolateStateDir(); });
  afterEach(() => cleanup(stateDir));

  it("validates generated grants and local/provider proof projections against the published schemas", () => {
    const grantSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema", "delegation-grant.schema.json"), "utf8")) as Schema;
    const proofSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema", "delegation-proof.schema.json"), "utf8")) as Schema;
    const action = "workspace_read" as const;
    const scope = normalizeDelegationScope({
      workspaceId: "schema-workspace",
      workstreamId: "a1-delegated-authorization",
      workspaceRoot: stateDir,
      canonicalRepository: "https://github.com/example/repo",
      worktreeRoot: stateDir,
      branch: "a1-delegated-authorization",
      stage: "Implementation + C2C Review",
      canonicalAction: action,
    }, action);
    const target = { kind: "workspace_read" as const, operation: "status" as const, maxBytes: 1024 };
    const notBefore = new Date(1_000).toISOString();
    const expiresAt = new Date(61_000).toISOString();
    const approvalDigest = delegationApprovalDigest({ policyVersion: "a1-v1", action, scope, target, notBefore, expiresAt, maxUses: 256 });
    const statePath = writeApprovalState(stateDir, { action, scopeDigest: delegationScopeDigest(scope), targetDigest: delegationTargetDigest(target), decisionId: "schema-grant", approvedDigest: approvalDigest });
    const grant = createDelegationGrant({
      action, scope, target, grantId: "schema-grant", notBefore, expiresAt, maxUses: 256, clock: () => 1_000,
      approval: { workflowStatePath: statePath, checkpoint: "a1-test", decisionId: "schema-grant", approverIdentityRef: "human:step4", approvedAt: new Date(1_000).toISOString(), approvedDigest: approvalDigest },
    });
    const proof = JSON.parse(JSON.stringify(evaluateWorkspaceRead({
      action,
      scope,
      activeBinding: {
        workspaceId: scope.workspaceId,
        workstreamId: scope.workstreamId,
        workspaceRoot: scope.workspaceRoot ?? scope.worktreeRoot,
        canonicalRepository: scope.canonicalRepository,
        worktreeRoot: scope.worktreeRoot,
        branch: scope.branch,
        stage: scope.stage,
        taskId: "a1-test-task",
        checkpoint: "a1-test",
        eventKey: "a1-event",
      },
      target,
      grant,
      clock: () => 1_000,
    }).proof)) as Record<string, unknown>;
    expect(validate(grant, grantSchema, grantSchema)).toEqual([]);
    expect(validate(proof, proofSchema, proofSchema)).toEqual([]);
    const provider = createTeamAiCapabilityProvider({ source: "teamai", skillName: "github-cli-auth", capabilityVersion: "1.0.0", classify: () => ({ classification: "healthy", correlationId: "schema-provider" }) });
    const evidence = resolveTeamAiAuthResult(provider, { correlationId: "schema-provider", expectedAccount: "a@example.com", authAttemptId: "attempt-1" });
    const providerProof = JSON.parse(JSON.stringify({ ...proof, provider: providerEvidenceProjection(evidence), decisionDigest: "a".repeat(64) })) as Record<string, unknown>;
    expect(validate(providerProof, proofSchema, proofSchema)).toEqual([]);
  });
});
