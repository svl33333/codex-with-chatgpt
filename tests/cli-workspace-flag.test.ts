import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { gitInfo } from "../src/workspace/git.js";
import { messageIdempotencyKey } from "../src/conversation/delivery.js";
import { buildReviewerProof } from "../src/provisioning/reviewer-proof.js";
import { makeConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";

const projectRoot = path.resolve(process.cwd());
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

describe("machine-wide commands accept leftover -w without using workspace state", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.C2C_CLOUDFLARED_PATH;
    delete process.env.TUNNEL_ORIGIN_CERT;
  });

  it("update-check accepts -w and keeps the same machine-wide result", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const env = { C2C_STATE_DIR: stateDir };
    const withoutWorkspace = runCli(["update-check", "--json"], env);
    const withWorkspace = runCli(["update-check", "-w", "C:/dummy-workspace", "--json"], env);
    expect(withoutWorkspace.status).toBe(0);
    expect(withWorkspace.status).toBe(0);
    expect(withWorkspace.stderr).not.toMatch(/unknown option/i);
    expect(JSON.parse(withWorkspace.stdout)).toMatchObject({ ok: true, version: expect.any(String) });
    expect(JSON.parse(withoutWorkspace.stdout)).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(stateDir, "C:/dummy-workspace"))).toBe(false);
  });

  it("sandbox-allow accepts -w without creating workspace-specific allowlist state", () => {
    const stateDir = isolateStateDir();
    const codexHome = makeTmpDir("cli-w-codex-home");
    dirs.push(stateDir, codexHome);
    const env = { C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome };
    const withoutWorkspace = runCli(["sandbox-allow", "--json"], env);
    const withWorkspace = runCli(["sandbox-allow", "-w", "C:/dummy-workspace", "--json"], env);
    expect(withoutWorkspace.status).toBe(0);
    expect(withWorkspace.status).toBe(0);
    expect(withWorkspace.stderr).not.toMatch(/unknown option/i);
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(stateDir.replace(/\\/g, "/"));
    expect(config).not.toContain("dummy-workspace");
    expect(fs.existsSync(path.join(stateDir, "C:/dummy-workspace"))).toBe(false);
  });

  it("prefs get/set accept -w while reading and writing only machine prefs", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const env = { C2C_STATE_DIR: stateDir };
    const setResult = runCli(["prefs", "set", "--setup-mode", "auto", "-w", "C:/dummy-workspace", "--json"], env);
    expect(setResult.status).toBe(0);
    expect(setResult.stderr).not.toMatch(/unknown option/i);
    const machinePrefs = JSON.parse(fs.readFileSync(path.join(stateDir, "prefs.json"), "utf8"));
    expect(machinePrefs.setupMode).toBe("auto");
    expect(fs.existsSync(path.join(stateDir, "C:/dummy-workspace"))).toBe(false);

    const withoutWorkspace = runCli(["prefs", "get", "--json"], env);
    const withWorkspace = runCli(["prefs", "get", "-w", "C:/dummy-workspace", "--json"], env);
    const legacyDefault = runCli(["prefs", "--json", "-w", "C:/dummy-workspace"], env);
    expect(withoutWorkspace.status).toBe(0);
    expect(withWorkspace.status).toBe(0);
    expect(legacyDefault.status).toBe(0);
    expect(withWorkspace.stderr).not.toMatch(/unknown option/i);
    expect(legacyDefault.stderr).not.toMatch(/unknown option/i);
    expect(JSON.parse(withWorkspace.stdout)).toEqual(JSON.parse(withoutWorkspace.stdout));
    expect(JSON.parse(legacyDefault.stdout)).toEqual(JSON.parse(withoutWorkspace.stdout));
  });

  it("tunnel login accepts -w without opening a real Cloudflare login", () => {
    const stateDir = isolateStateDir();
    const fakeCloudflared = write(makeTmpDir("fake-cloudflared"), "cloudflared.exe", "not an executable\n");
    dirs.push(stateDir, path.dirname(fakeCloudflared));
    const result = runCli(["tunnel", "login", "-w", "C:/dummy-workspace", "--json"], {
      C2C_STATE_DIR: stateDir,
      C2C_CLOUDFLARED_PATH: fakeCloudflared,
      TUNNEL_ORIGIN_CERT: path.join(stateDir, "missing-cert.pem"),
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.stdout).toMatch(/\"ok\":false/);
    expect(result.stdout).not.toMatch(/dummy-workspace/);
  });

  it("explicit named tunnel choice fails closed instead of silently choosing Quick", () => {
    const stateDir = isolateStateDir();
    const workspace = makeTmpDir("explicit-named-workspace");
    const fakeCloudflared = write(makeTmpDir("fake-cloudflared-named"), "cloudflared.exe", "not an executable\n");
    const dummyCert = write(stateDir, "origin-cert.pem", "fixture certificate\n");
    dirs.push(stateDir, workspace, path.dirname(fakeCloudflared));
    const result = runCli(["tunnel", "choose", "-w", workspace, "--mode", "named", "--zone", "example.com", "--json"], {
      C2C_STATE_DIR: stateDir,
      C2C_CLOUDFLARED_PATH: fakeCloudflared,
      TUNNEL_ORIGIN_CERT: dummyCert,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/NAMED_PROVISION_FAILED/);
    expect(result.stdout).not.toMatch(/\"fallback\":true/);
    expect(result.stdout).not.toMatch(/\"preference\":\"quick\"/);
  });

  it("still rejects unrelated unknown options", () => {
    const result = runCli(["update-check", "--definitely-not-a-real-option"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown option/i);
  });
});

describe("C2C readiness consumes the successful current-message app record", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("requires pending → succeeded evidence for the exact delivery identity", () => {
    const stateDir = isolateStateDir();
    const workspace = makeTmpDir("cli-readiness-workspace");
    dirs.push(stateDir, workspace);
    const env = { C2C_STATE_DIR: stateDir };
    makeGitRepo(workspace);
    const workspaceObject = new Workspace(workspace);
    const workspaceId = workspaceObject.id;
    const binding = makeConnectionBinding({
      workspaceId,
      workspace: workspaceObject.name,
      workspaceRoot: workspace,
      endpoint: "https://example.test/mcp",
      endpointMode: "stable",
      connectorName: "Codex with ChatGPT",
    });
    writeConnectionBinding(binding);
    const git = gitInfo(workspace);
    if (!git.isRepo || !git.branch || !git.commit) throw new Error("test fixture git repository was not initialized");
    const messageKey = messageIdempotencyKey({ taskId: "task-readiness", iteration: 2, messageId: "message-readiness" });
    const reviewerProof = buildReviewerProof({
      messageKey,
      appIdentity: { workspaceId, connectorName: binding.connectorName, installationId: binding.installationId },
      capability: "read-only",
      repository: binding.canonicalRepository,
      root: workspace,
      workspaceInfo: {
        workspaceId,
        workspaceName: workspaceObject.name,
        root: workspace,
        repository: binding.canonicalRepository,
        git: { isRepo: true, branch: git.branch, commit: git.commit, dirty: git.dirty },
      },
      gitStatus: { isRepo: true, branch: git.branch, staged: [], unstaged: [], untracked: [] },
      gitDiff: { isRepo: true, mode: "unstaged", diff: "" },
    });
    const reviewerProofPath = write(workspace, "reviewer-proof.json", JSON.stringify(reviewerProof));
    const common = [
      "app-selection",
      "record",
      "-w",
      workspace,
      "--task",
      "task-readiness",
      "--iteration",
      "2",
      "--message-id",
      "message-readiness",
      "--target-workstream",
      "a0-chatgpt-surface-compatibility",
      "--connector-name",
      "Codex with ChatGPT",
      "--requested-app",
      "A0 app",
      "--selection-method",
      "product_equivalent",
    ];
    const pending = runCli([...common, "--invocation", "pending", "--current-message-available", "--json"], env);
    expect(pending.status).toBe(0);
    const succeeded = runCli(
      [...common, "--invocation", "succeeded", "--current-message-available", "--workspace-verified", "--reviewer-proof-json", reviewerProofPath, "--json"],
      env
    );
    expect(succeeded.status).toBe(0);

    const ready = runCli(
      [
        "provisioning",
        "set",
        "-w",
        workspace,
        "--phase",
        "ready",
        "--surface",
        "plugin-hub-custom-mcp",
        "--outcome",
        "REUSED",
        "--account-verified",
        "--read-only-verified",
        "--oauth-contract-verified",
        "--project-verified",
        "--message-selection-verified",
        "--selection-task",
        "task-readiness",
        "--selection-iteration",
        "2",
        "--selection-message-id",
        "message-readiness",
        "--reviewer-proof-json",
        reviewerProofPath,
        "--json",
      ],
      env
    );
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout).state).toMatchObject({ phase: "ready", messageSelectionVerified: true });
    expect(JSON.parse(ready.stdout).state.messageSelectionKey).toEqual(expect.any(String));

    const tamperedProof = JSON.parse(fs.readFileSync(reviewerProofPath, "utf8")) as Record<string, unknown>;
    tamperedProof.evidenceDigest = "0".repeat(64);
    const tamperedProofPath = write(workspace, "reviewer-proof-tampered.json", JSON.stringify(tamperedProof));
    const tamperedSelection = runCli(
      [...common, "--invocation", "succeeded", "--current-message-available", "--workspace-verified", "--reviewer-proof-json", tamperedProofPath, "--json"],
      env
    );
    expect(tamperedSelection.status).not.toBe(0);
    expect(`${tamperedSelection.stdout}\n${tamperedSelection.stderr}`).toMatch(/WORKSPACE_MISMATCH|digest/i);

    const substitutedReady = runCli(
      [
        "provisioning",
        "set",
        "-w",
        workspace,
        "--phase",
        "ready",
        "--surface",
        "plugin-hub-custom-mcp",
        "--outcome",
        "REUSED",
        "--account-verified",
        "--read-only-verified",
        "--oauth-contract-verified",
        "--project-verified",
        "--message-selection-verified",
        "--selection-task",
        "task-readiness",
        "--selection-iteration",
        "2",
        "--selection-message-id",
        "message-readiness",
        "--reviewer-proof-json",
        tamperedProofPath,
        "--json",
      ],
      env
    );
    expect(substitutedReady.status).not.toBe(0);
    expect(`${substitutedReady.stdout}\n${substitutedReady.stderr}`).toMatch(/WORKSPACE_MISMATCH|does not match/i);

    const withoutRecord = runCli(
      [
        "provisioning",
        "set",
        "-w",
        workspace,
        "--phase",
        "ready",
        "--surface",
        "plugin-hub-custom-mcp",
        "--outcome",
        "REUSED",
        "--account-verified",
        "--read-only-verified",
        "--oauth-contract-verified",
        "--project-verified",
        "--message-selection-verified",
        "--selection-task",
        "task-readiness",
        "--selection-iteration",
        "2",
        "--selection-message-id",
        "different-message",
        "--json",
      ],
      env
    );
    expect(withoutRecord.status).not.toBe(0);
    expect(`${withoutRecord.stdout}\n${withoutRecord.stderr}`).toMatch(/successful current-message app selection/i);
  });

  it("builds the production ReviewerProof from exact connector evidence", () => {
    const stateDir = isolateStateDir();
    const workspace = makeTmpDir("cli-reviewer-proof-workspace");
    const evidenceDir = makeTmpDir("cli-reviewer-proof-evidence");
    const outputDir = makeTmpDir("cli-reviewer-proof-output");
    dirs.push(stateDir, workspace, evidenceDir, outputDir);
    const env = { C2C_STATE_DIR: stateDir };
    makeGitRepo(workspace);
    const workspaceObject = new Workspace(workspace);
    const binding = makeConnectionBinding({
      workspaceId: workspaceObject.id,
      workspace: workspaceObject.name,
      workspaceRoot: workspace,
      endpoint: "https://example.test/mcp",
      endpointMode: "stable",
      connectorName: "Codex with ChatGPT",
    });
    writeConnectionBinding(binding);
    const git = gitInfo(workspace);
    if (!git.isRepo || !git.branch || !git.commit) throw new Error("test fixture git repository was not initialized");
    const evidencePath = write(evidenceDir, "evidence.json", JSON.stringify({
      appIdentity: { workspaceId: workspaceObject.id, connectorName: binding.connectorName, installationId: binding.installationId },
      repository: binding.canonicalRepository,
      root: workspace,
      workspaceInfo: {
        workspaceId: workspaceObject.id,
        workspaceName: workspaceObject.name,
        root: workspace,
        repository: binding.canonicalRepository,
        git: { isRepo: true, branch: git.branch, commit: git.commit, dirty: git.dirty },
      },
      gitStatus: { isRepo: true, branch: git.branch, staged: [], unstaged: [], untracked: [] },
      gitDiff: { isRepo: true, mode: "unstaged", diff: "", hasMore: false },
    }));
    const outputPath = path.join(outputDir, "proof.json");
    const result = runCli([
      "reviewer-proof",
      "build",
      "-w",
      workspace,
      "--task",
      "task-proof-build",
      "--iteration",
      "1",
      "--message-id",
      "message-proof-build",
      "--evidence-json",
      evidencePath,
      "--output",
      outputPath,
      "--json",
    ], env);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; messageKey: string };
    expect(output).toMatchObject({ ok: true, messageKey: expect.any(String) });
    const proof = JSON.parse(fs.readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    expect(proof).toMatchObject({ schemaVersion: 1, capability: "read-only", messageKey: output.messageKey });
    expect(proof.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
