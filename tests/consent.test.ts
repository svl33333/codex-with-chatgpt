import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SUPPORTED_SCOPES } from "../src/auth/store.js";
import {
  clearConsentChallengeRegistry,
  connectorConsentBinding,
  decideConnectorConsent,
  determineConnectorConsentAction,
  prepareConnectorConsent,
  type ConnectorConsentContext,
  type ConnectorConsentObservation,
} from "../src/connection/consent.js";
import type { ConnectionBinding } from "../src/connection/identity.js";
import { makeConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { mergeUiPrefs } from "../src/config/ui-prefs.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

const binding: ConnectionBinding = {
  schemaVersion: 2,
  workspaceId: "workspace-id",
  workspace: "codex-with-chatgpt",
  canonicalRepository: "https://github.com/svl33333/codex-with-chatgpt",
  installationId: "11111111-1111-4111-8111-111111111111",
  endpointMode: "ephemeral",
  endpointFingerprint: "0123456789abcdef01234567",
  connectorName: "Codex with ChatGPT · codex-with-chatgpt · 11111111",
  accountFingerprint: "account-verified-1",
  updatedAt: "2026-10-06T00:00:00.000Z",
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
    expectedAccountFingerprint: binding.accountFingerprint ?? null,
    observed: { ...expected, accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES] },
    freshness: "current",
    challengeId: `c2c_consent_${"a".repeat(32)}`,
    ...overrides,
  };
}

function observation(challengeId: string, overrides: Partial<ConnectorConsentObservation> = {}): ConnectorConsentObservation {
  return {
    consentSurface: "chatgpt-unreviewed-mcp",
    ownershipResolved: true,
    accountIdentityResolved: true,
    observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES] },
    freshness: "current",
    challengeId,
    ...overrides,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("runtime-owned connector consent policy", () => {
  it("automatically confirms only the exact current read-only C2C warning", () => {
    expect(determineConnectorConsentAction(context())).toEqual({
      action: "AUTO_CONFIRM",
      reason: "verified expected read-only C2C connector consent",
    });
    expect("acknowledgementRequired" in determineConnectorConsentAction(context())).toBe(false);
  });

  it("fails closed for missing authority, stale evidence, account mismatch, and scope drift", () => {
    expect(determineConnectorConsentAction(context({ expectedAccountFingerprint: null })).action).toBe("HUMAN_REQUIRED");
    expect(determineConnectorConsentAction(context({ freshness: "stale" })).action).toBe("HUMAN_REQUIRED");
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: "foreign", scopes: [...SUPPORTED_SCOPES] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES, "workspace.write"] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
  });

  it("keeps manual mode, unknown surfaces, and unresolved ownership human-required", () => {
    expect(determineConnectorConsentAction(context({ setupMode: "manual" })).action).toBe("HUMAN_REQUIRED");
    expect(determineConnectorConsentAction(context({ consentSurface: "unknown" })).action).toBe("HUMAN_REQUIRED");
    expect(determineConnectorConsentAction(context({ ownershipResolved: false })).action).toBe("HUMAN_REQUIRED");
    expect(determineConnectorConsentAction(context({ explicitC2CRequest: false })).action).toBe("HUMAN_REQUIRED");
  });

  it("fails closed for every durable binding dimension and every blocker", () => {
    const dimensions = {
      workspace: "other-workspace",
      canonicalRepository: "https://github.com/other/repository",
      installationId: "22222222-2222-4222-8222-222222222222",
      endpointMode: "stable" as const,
      endpointFingerprint: "fedcba9876543210fedcba98",
      connectorName: "Other connector",
    };
    for (const [field, value] of Object.entries(dimensions)) {
      expect(
        determineConnectorConsentAction(
          context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES], [field]: value } })
        ).action,
        field
      ).toBe("HUMAN_REQUIRED");
    }
    for (const field of ["loginRequired", "captcha", "twoFactor", "destructive", "unexpectedAccount"] as const) {
      expect(determineConnectorConsentAction(context({ blockers: { [field]: true } })).action, field).toBe("HUMAN_REQUIRED");
    }
  });

  it("rejects duplicate, missing, and write OAuth scopes", () => {
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [SUPPORTED_SCOPES[0], SUPPORTED_SCOPES[0]] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: SUPPORTED_SCOPES.slice(1) } })
      ).action
    ).toBe("HUMAN_REQUIRED");
    expect(
      determineConnectorConsentAction(
        context({ observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES, "workspace.write"] } })
      ).action
    ).toBe("HUMAN_REQUIRED");
  });

  it("requires the current binding account and never accepts a browser-derived expected account", () => {
    const observation: ConnectorConsentObservation = {
      consentSurface: "chatgpt-unreviewed-mcp",
      ownershipResolved: true,
      accountIdentityResolved: true,
      observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES] },
      freshness: "current",
      challengeId: `c2c_consent_${"b".repeat(32)}`,
    };
    const prepared = prepareConnectorConsent({ workspaceId: "workspace-id", binding, setupMode: "auto", now: 1_000, ttlMs: 1_000 });
    expect(prepared.action).toBe("READY");
    expect(
      decideConnectorConsent({
        workspaceId: "workspace-id",
        binding: { ...binding, accountFingerprint: "changed-account" },
        setupMode: "auto",
        explicitC2CRequest: true,
        challengeId: prepared.challengeId!,
        evidence: { ...observation, challengeId: prepared.challengeId! },
        now: 1_500,
      }).action
    ).toBe("HUMAN_REQUIRED");
    clearConsentChallengeRegistry("workspace-id");
  });

  it("terminalizes a live challenge after the first invalid decision attempt", () => {
    const stateDir = makeTmpDir("consent-terminal-state");
    process.env.C2C_STATE_DIR = stateDir;
    const workspaceId = "terminalize-invalid-evidence";
    clearConsentChallengeRegistry(workspaceId);
    const cases: Array<(challengeId: string) => ConnectorConsentObservation> = [
      (challengeId) => observation(challengeId, { freshness: "stale" }),
      (challengeId) => observation(challengeId, {
        observed: { ...connectorConsentBinding(binding), accountFingerprint: binding.accountFingerprint, scopes: [...SUPPORTED_SCOPES, "workspace.write"] },
      }),
    ];
    for (const makeInvalidObservation of cases) {
      const prepared = prepareConnectorConsent({ workspaceId, binding, setupMode: "auto", now: 10_000, ttlMs: 10_000 });
      expect(prepared.action).toBe("READY");
      const challengeId = prepared.challengeId!;
      expect(
        decideConnectorConsent({
          workspaceId,
          binding,
          setupMode: "auto",
          explicitC2CRequest: true,
          challengeId,
          evidence: makeInvalidObservation(challengeId),
          now: 10_500,
        }).action
      ).toBe("HUMAN_REQUIRED");
      expect(
        decideConnectorConsent({
          workspaceId,
          binding,
          setupMode: "auto",
          explicitC2CRequest: true,
          challengeId,
          evidence: observation(challengeId),
          now: 10_600,
        }).action
      ).toBe("HUMAN_REQUIRED");
    }
    clearConsentChallengeRegistry(workspaceId);
    cleanup(stateDir);
    delete process.env.C2C_STATE_DIR;
  });

  it("terminalizes stale binding and account attempts and bounds expiry/unknown/registry state", () => {
    const stateDir = makeTmpDir("consent-bounded-state");
    process.env.C2C_STATE_DIR = stateDir;
    const workspaceId = "terminalize-binding-and-account";
    clearConsentChallengeRegistry(workspaceId);
    for (const changedBinding of [
      { ...binding, connectorName: "changed-connector" },
      { ...binding, accountFingerprint: "changed-account" },
    ]) {
      const prepared = prepareConnectorConsent({ workspaceId, binding, setupMode: "auto", now: 20_000, ttlMs: 10_000 });
      const challengeId = prepared.challengeId!;
      expect(
        decideConnectorConsent({
          workspaceId,
          binding: changedBinding,
          setupMode: "auto",
          explicitC2CRequest: true,
          challengeId,
          evidence: observation(challengeId),
          now: 20_500,
        }).action
      ).toBe("HUMAN_REQUIRED");
      expect(
        decideConnectorConsent({
          workspaceId,
          binding,
          setupMode: "auto",
          explicitC2CRequest: true,
          challengeId,
          evidence: observation(challengeId),
          now: 20_600,
        }).action
      ).toBe("HUMAN_REQUIRED");
    }

    const expired = prepareConnectorConsent({ workspaceId, binding, setupMode: "auto", now: 30_000, ttlMs: 1_000 });
    expect(
      decideConnectorConsent({
        workspaceId,
        binding,
        setupMode: "auto",
        explicitC2CRequest: true,
        challengeId: expired.challengeId!,
        evidence: observation(expired.challengeId!),
        now: 31_001,
      }).action
    ).toBe("HUMAN_REQUIRED");
    const unknown = `c2c_consent_${"z".repeat(32)}`;
    expect(
      decideConnectorConsent({
        workspaceId,
        binding,
        setupMode: "auto",
        explicitC2CRequest: true,
        challengeId: unknown,
        evidence: observation(unknown),
        now: 31_001,
      }).action
    ).toBe("HUMAN_REQUIRED");

    for (let index = 0; index < 65; index += 1) {
      expect(prepareConnectorConsent({ workspaceId, binding, setupMode: "auto", now: 40_000 + index, ttlMs: 120_000 }).action).toBe("READY");
    }
    const registryFiles = fs.readdirSync(path.join(process.env.C2C_STATE_DIR ?? "", "consent"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".json"));
    expect(registryFiles.length).toBeLessThanOrEqual(64);
    clearConsentChallengeRegistry(workspaceId);
    cleanup(stateDir);
    delete process.env.C2C_STATE_DIR;
  });
});

describe("production consent challenge path", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("establishes account authority through the production CLI path before consent preparation", () => {
    const stateDir = isolateStateDir();
    const workspaceRoot = makeTmpDir("consent-account-workspace");
    const evidenceDir = makeTmpDir("consent-account-evidence");
    dirs.push(stateDir, workspaceRoot, evidenceDir);
    makeGitRepo(workspaceRoot);
    const workspace = new Workspace(workspaceRoot);
    writeConnectionBinding(makeConnectionBinding({
      workspaceId: workspace.id,
      workspace: workspace.name,
      workspaceRoot,
      endpoint: "https://example.test/mcp",
      endpointMode: "stable",
      connectorName: "Codex with ChatGPT",
    }));
    mergeUiPrefs({ setupMode: "auto" });
    const env = { C2C_STATE_DIR: stateDir };
    const initialBinding = JSON.parse(fs.readFileSync(path.join(stateDir, "bindings", `${workspace.id}.json`), "utf8")) as ConnectionBinding;
    expect(initialBinding.accountFingerprint).toBeUndefined();
    const accountEvidencePath = write(evidenceDir, "account-observation.json", JSON.stringify({
      source: "authenticated-account-surface",
      ownershipResolved: true,
      accountIdentityResolved: true,
      freshness: "current",
      observed: { ...connectorConsentBinding(initialBinding), accountFingerprint: "account-established-by-surface" },
    }));
    const verified = runCli(["consent", "verify-account", "-w", workspaceRoot, "--observation-json", accountEvidencePath, "--json"], env);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, action: "BOUND", accountFingerprint: "account-established-by-surface" });
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "bindings", `${workspace.id}.json`), "utf8")) as ConnectionBinding;
    expect(saved.accountFingerprint).toBe("account-established-by-surface");

    const prepared = runCli(["consent", "prepare", "-w", workspaceRoot, "--json"], env);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ ok: true, action: "READY" });
  });

  it("registers, atomically consumes, and rejects replay through the CLI", () => {
    const stateDir = isolateStateDir();
    const workspaceRoot = makeTmpDir("consent-cli-workspace");
    const evidenceDir = makeTmpDir("consent-cli-evidence");
    dirs.push(stateDir, workspaceRoot, evidenceDir);
    makeGitRepo(workspaceRoot);
    const workspace = new Workspace(workspaceRoot);
    writeConnectionBinding(makeConnectionBinding({
      workspaceId: workspace.id,
      workspace: workspace.name,
      workspaceRoot,
      endpoint: "https://example.test/mcp",
      endpointMode: "stable",
      connectorName: "Codex with ChatGPT",
      accountFingerprint: "account-verified-1",
    }));
    mergeUiPrefs({ setupMode: "auto" });
    const env = { C2C_STATE_DIR: stateDir };

    const prepared = runCli(["consent", "prepare", "-w", workspaceRoot, "--json"], env);
    expect(prepared.status).toBe(0);
    const challenge = JSON.parse(prepared.stdout) as { action: string; challengeId: string };
    expect(challenge).toMatchObject({ ok: true, action: "READY", challengeId: expect.stringMatching(/^c2c_consent_/) });

    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "bindings", `${workspace.id}.json`), "utf8")) as ConnectionBinding;
    const evidencePath = write(
      evidenceDir,
      "observation.json",
      JSON.stringify({
        consentSurface: "chatgpt-unreviewed-mcp",
        ownershipResolved: true,
        accountIdentityResolved: true,
        freshness: "current",
        observed: {
          workspace: saved.workspace,
          canonicalRepository: saved.canonicalRepository,
          installationId: saved.installationId,
          endpointMode: saved.endpointMode,
          endpointFingerprint: saved.endpointFingerprint,
          connectorName: saved.connectorName,
          accountFingerprint: saved.accountFingerprint,
          scopes: [...SUPPORTED_SCOPES],
        },
      })
    );

    const decided = runCli(
      ["consent", "decide", "-w", workspaceRoot, "--challenge-id", challenge.challengeId, "--observation-json", evidencePath, "--explicit-c2c", "--json"],
      env
    );
    expect(decided.status).toBe(0);
    expect(JSON.parse(decided.stdout)).toMatchObject({ ok: true, action: "AUTO_CONFIRM" });

    const replay = runCli(
      ["consent", "decide", "-w", workspaceRoot, "--challenge-id", challenge.challengeId, "--observation-json", evidencePath, "--explicit-c2c", "--json"],
      env
    );
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, action: "HUMAN_REQUIRED" });
    const stateFiles = fs.readdirSync(path.join(stateDir, "consent"), { recursive: true }).map(String).join("\n");
    expect(stateFiles).not.toMatch(/https?:|workspace\.write|token|cookie/i);
  });

  it("allows exactly one concurrent consumer to auto-confirm", async () => {
    const stateDir = isolateStateDir();
    const workspaceRoot = makeTmpDir("consent-concurrent-workspace");
    const evidenceDir = makeTmpDir("consent-concurrent-evidence");
    dirs.push(stateDir, workspaceRoot, evidenceDir);
    makeGitRepo(workspaceRoot);
    const workspace = new Workspace(workspaceRoot);
    writeConnectionBinding(makeConnectionBinding({
      workspaceId: workspace.id,
      workspace: workspace.name,
      workspaceRoot,
      endpoint: "https://example.test/mcp",
      endpointMode: "stable",
      connectorName: "Codex with ChatGPT",
      accountFingerprint: "account-verified-1",
    }));
    mergeUiPrefs({ setupMode: "auto" });
    const env = { C2C_STATE_DIR: stateDir };
    const prepared = runCli(["consent", "prepare", "-w", workspaceRoot, "--json"], env);
    const challenge = JSON.parse(prepared.stdout) as { challengeId: string };
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "bindings", `${workspace.id}.json`), "utf8")) as ConnectionBinding;
    const evidencePath = write(evidenceDir, "observation.json", JSON.stringify({
      consentSurface: "chatgpt-unreviewed-mcp",
      ownershipResolved: true,
      accountIdentityResolved: true,
      freshness: "current",
      observed: { ...connectorConsentBinding(saved), accountFingerprint: saved.accountFingerprint, scopes: [...SUPPORTED_SCOPES] },
    }));
    const args = ["consent", "decide", "-w", workspaceRoot, "--challenge-id", challenge.challengeId, "--observation-json", evidencePath, "--explicit-c2c", "--json"];
    const results = await Promise.all([runCliAsync(args, env), runCliAsync(args, env)]);
    const actions = results.map((result) => JSON.parse(result.stdout).action).sort();
    expect(actions).toEqual(["AUTO_CONFIRM", "HUMAN_REQUIRED"]);
  });
});
