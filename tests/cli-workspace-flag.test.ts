import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

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
