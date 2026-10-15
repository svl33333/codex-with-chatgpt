import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = process.cwd();
const fixtureRoots: string[] = [];
let nativeExecutionSequence = 0;
const candidateVersion = "0.1.3-svl.16";
const previousVersion = "0.1.3-svl.14";
const skillBody = "---\nname: codex-with-chatgpt\n---\nUse the in-app browser.\n";
const shell = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).status === 0 ? "pwsh" : "powershell";

interface InstallationFixture {
  root: string;
  repository: string;
  installRoot: string;
  codexHome: string;
  commandDirectory: string;
  driverDirectory: string;
  emptyConfig: string;
  previousCommit: string;
  candidateCommit: string;
  skillSha256: string;
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(fixture: InstallationFixture, ...args: string[]): string {
  const command = spawnSync("git", args, {
    cwd: fixture.repository,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: fixture.emptyConfig, GIT_TERMINAL_PROMPT: "0" },
  });
  expect(command.status, command.stderr).toBe(0);
  return command.stdout.trim();
}

function commit(fixture: InstallationFixture, message: string): string {
  git(fixture, "add", ".");
  git(fixture, "commit", "--quiet", "-m", message);
  return git(fixture, "rev-parse", "HEAD");
}

function createFixture(shortRoot = false): InstallationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), shortRoot ? "r31-" : "c2c installation-"));
  fixtureRoots.push(root);
  const fixture: InstallationFixture = {
    root,
    repository: path.join(root, "source"),
    installRoot: path.join(root, "installed runtime"),
    codexHome: path.join(root, "isolated codex"),
    commandDirectory: path.join(root, "commands"),
    driverDirectory: path.join(root, "driver"),
    emptyConfig: path.join(root, "empty-git-config"),
    previousCommit: "",
    candidateCommit: "",
    skillSha256: "",
  };
  fs.mkdirSync(fixture.repository, { recursive: true });
  write(fixture.emptyConfig, "");
  for (const script of ["bootstrap-custom-c2c.ps1", "update-custom-c2c.ps1", "install-codex-c2c-skill.ps1"]) {
    write(path.join(fixture.driverDirectory, script), fs.readFileSync(path.join(sourceRoot, "scripts", script)));
  }
  git(fixture, "init", "--quiet", "--initial-branch=fixture");
  git(fixture, "config", "user.name", "Synthetic Installation Fixture");
  git(fixture, "config", "user.email", "fixture@example.invalid");
  git(fixture, "config", "core.autocrlf", "false");
  write(path.join(fixture.repository, ".gitignore"), "dist/\nnode_modules/\n");
  write(path.join(fixture.repository, "package.json"), JSON.stringify({ name: "c2c-synthetic-fixture", version: previousVersion }));
  write(path.join(fixture.repository, "skill", "SKILL.md"), skillBody);
  write(path.join(fixture.repository, "bin", "c2c.js"), "const fs = require('node:fs'); const path = require('node:path'); if(fs.existsSync(path.join(__dirname, '../dist/cli.cjs'))) require('../dist/cli.cjs'); console.log(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);\n");
  write(path.join(fixture.repository, "scripts", "install-codex-c2c-skill.ps1"), fs.readFileSync(path.join(sourceRoot, "scripts", "install-codex-c2c-skill.ps1")));
  fixture.previousCommit = commit(fixture, "previous synthetic release");
  git(fixture, "tag", "previous");
  write(path.join(fixture.repository, "package.json"), JSON.stringify({ name: "c2c-synthetic-fixture", version: candidateVersion }));
  write(path.join(fixture.repository, "skill", "SKILL.md"), skillBody + "Candidate revision.\n");
  fixture.candidateCommit = commit(fixture, "candidate synthetic release");
  git(fixture, "tag", "candidate");
  git(fixture, "tag", "v0.1.3-svl.16");
  fixture.skillSha256 = createHash("sha256").update(skillBody + "Candidate revision.\n").digest("hex");
  write(path.join(fixture.commandDirectory, "corepack.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(fixture.root, "build.cjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  write(path.join(fixture.root, "build.cjs"), "const fs=require('node:fs'); const path=require('node:path'); if(process.argv.includes('build')) {fs.mkdirSync('node_modules',{recursive:true}); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/fixture.txt','built'); if(process.env.C2C_FIXTURE_BUILD_ACTION) {eval(process.env.C2C_FIXTURE_BUILD_ACTION);}}\n");
  write(path.join(fixture.codexHome, "ui-prefs.json"), '{"setupMode":"manual","fixture":"preserve"}\r\n');
  return fixture;
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function invoke(fixture: InstallationFixture, options: {
  bootstrap?: boolean;
  ref?: string | null;
  expectations?: boolean;
  expectedCommit?: string;
  expectedVersion?: string;
  expectedSkillSha256?: string;
  lock?: string;
  buildAction?: string;
  parentScript?: string;
  timeout?: number;
  environment?: NodeJS.ProcessEnv;
} = {}) {
  const args = ["-Repository", fixture.repository, "-InstallRoot", fixture.installRoot];
  if (options.ref !== null) args.push("-Ref", options.ref ?? "candidate");
  if (options.expectations) args.push("-ExpectedCommit", fixture.candidateCommit, "-ExpectedVersion", candidateVersion, "-ExpectedSkillSha256", fixture.skillSha256);
  for (const [parameter, value] of [["ExpectedCommit", options.expectedCommit], ["ExpectedVersion", options.expectedVersion], ["ExpectedSkillSha256", options.expectedSkillSha256]]) {
    if (value !== undefined) args.push(`-${parameter}`, value);
  }
  const script = path.join(fixture.driverDirectory, options.bootstrap ? "bootstrap-custom-c2c.ps1" : "update-custom-c2c.ps1");
  const command = options.parentScript ?? `$ErrorActionPreference='Stop'; ${options.lock ? `$held=[IO.File]::Open(${quote(options.lock)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {` : ""} & ${quote(script)} ${args.map((argument, index) => index % 2 === 0 ? argument : quote(argument)).join(" ")} ${options.lock ? "} finally { $held.Dispose() }" : ""}`;
  const argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];
  const execution = spawnSync(shell, argv, {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: options.timeout ?? 25_000,
    env: {
      ...process.env,
      PATH: `${fixture.commandDirectory}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_HOME: fixture.codexHome,
      LOCALAPPDATA: path.join(fixture.root, "local-app-data"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: fixture.emptyConfig,
      GIT_TERMINAL_PROMPT: "0",
      C2C_FIXTURE_BUILD_ACTION: options.buildAction ?? "",
      ...options.environment,
    },
  });
  return { ...execution, argv: [shell, ...argv], stderr: execution.stderr.replace(/\r?\n\s*\|\s*/g, " ") };
}

function activePaths(fixture: InstallationFixture): string[] {
  return [
    path.join(fixture.installRoot, "runtime.json"),
    path.join(fixture.installRoot, "bin", "c2c-svl.cmd"),
    path.join(fixture.codexHome, "skills", "codex-with-chatgpt", "SKILL.md"),
    path.join(fixture.codexHome, "skills", "codex-with-chatgpt", "c2c-skill-source.json"),
    path.join(fixture.codexHome, "ui-prefs.json"),
  ];
}

function snapshot(fixture: InstallationFixture): Array<string | null> {
  return activePaths(fixture).map(file => fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null);
}

function installPrevious(fixture: InstallationFixture): void {
  const command = invoke(fixture, { ref: "previous" });
  expect(command.status, command.stderr).toBe(0);
}

function failAfterActivation(fixture: InstallationFixture): void {
  const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
  write(driver, fs.readFileSync(driver, "utf8").replace(/^(\s*\$writtenFiles \+= Write-ActivationFile \$previousFiles\[0\].*)$/m, "$1\n    throw 'synthetic post-activation failure'"));
}

function failAfterFirstSkillWrite(fixture: InstallationFixture): void {
  const installer = path.join(fixture.driverDirectory, "install-codex-c2c-skill.ps1");
  write(installer, fs.readFileSync(installer, "utf8").replace("$writtenFiles += Write-SkillFile $previousFiles[1]", "throw 'synthetic post-Skill failure'\n  $writtenFiles += Write-SkillFile $previousFiles[1]"));
}

function injectBeforeCheckedDeletion(fixture: InstallationFixture, owner: "updater" | "installer", target: string, actor: string): void {
  const driver = path.join(fixture.driverDirectory, owner === "updater" ? "update-custom-c2c.ps1" : "install-codex-c2c-skill.ps1");
  const deletion = "[C2CFileRollback]::DeleteOwnedFile($Written.Path, $Written.OwnedFile, $Written.Written)";
  const injection = `if ($Written.Path -eq ${quote(target)}) { & ${quote(process.execPath)} ${quote(actor)}; if ($LASTEXITCODE -ne 0) { throw 'synthetic actor failed' } }; ${deletion}`;
  const source = fs.readFileSync(driver, "utf8");
  expect(source).toContain(deletion);
  write(driver, source.replace(deletion, injection));
}

function createMutationActor(fixture: InstallationFixture, target: string, mode: "edit" | "replace"): string {
  const actor = path.join(fixture.root, "mutation.cjs");
  const proof = path.join(fixture.root, "mutation-proof.json");
  write(actor, `const fs=require('node:fs');const target=${JSON.stringify(target)};const before=fs.readFileSync(target);${mode === "edit" ? "fs.writeFileSync(target,'concurrent new bytes');" : "fs.writeFileSync(target+'.replacement',before);fs.renameSync(target,target+'.prior-owned');fs.renameSync(target+'.replacement',target);"}fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({mode:${JSON.stringify(mode)},before:before.toString('base64'),after:fs.readFileSync(target).toString('base64')}));`);
  return actor;
}

function preserveNativeExecution(fixture: InstallationFixture, label: string, execution: unknown): void {
  const evidence = process.env.C2C_INSTALLATION_EVIDENCE_DIR;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, `${path.basename(fixture.root)}-${++nativeExecutionSequence}-${label}.json`), JSON.stringify(execution, null, 2), { flag: "wx" });
  }
}

function createRealPnpmFixture(): InstallationFixture {
  const fixture = createFixture(true);
  installPrevious(fixture);
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: sourceRoot, encoding: "utf8" });
  expect(tracked.status, tracked.stderr).toBe(0);
  const inputs: Record<string, string> = {};
  for (const name of tracked.stdout.split("\0").filter(Boolean)) {
    if (name.startsWith(".harness/") || name.startsWith(".maintenance-bootstrap/")) continue;
    const bytes = fs.readFileSync(path.join(sourceRoot, name));
    write(path.join(fixture.repository, name), bytes);
    inputs[name] = createHash("sha256").update(bytes).digest("hex");
  }
  fixture.candidateCommit = commit(fixture, "current public Runtime source fixture");
  git(fixture, "tag", "-f", "candidate");
  fixture.skillSha256 = createHash("sha256").update(fs.readFileSync(path.join(fixture.repository, "skill/SKILL.md"), "utf8").replace(/\r\n?/g, "\n")).digest("hex");
  const locations = spawnSync("where.exe", ["corepack.cmd"], { encoding: "utf8" });
  const corepack = locations.stdout.split(/\r?\n/).find(location => fs.existsSync(location) && !location.startsWith(fixture.commandDirectory));
  expect(corepack, "A real Corepack executable is required on Windows").toBeTruthy();
  write(path.join(fixture.root, "real-corepack.cjs"), `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const argv=process.argv.slice(2);const child=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c','""'+${JSON.stringify(corepack)}+'" '+argv.join(' ')+'"'],{stdio:'inherit',windowsVerbatimArguments:true});if(child.status!==0)process.exit(child.status||1);if(argv.includes('build')){if(process.env.C2C_FIXTURE_BUILD_ACTION)eval(process.env.C2C_FIXTURE_BUILD_ACTION);}\n`);
  write(path.join(fixture.commandDirectory, "corepack.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(fixture.root, "real-corepack.cjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  preserveNativeExecution(fixture, "inputs", { source: inputs, fixtureCommit: fixture.candidateCommit, skillSha256: fixture.skillSha256, realCorepack: corepack, node: process.execPath, nodeVersion: process.version, packageManager: JSON.parse(fs.readFileSync(path.join(fixture.repository, "package.json"), "utf8")).packageManager });
  return fixture;
}

function invokeRealPnpm(fixture: InstallationFixture, buildAction = "") {
  const directories = Object.fromEntries(["home", "appdata", "local", "temp", "corepack", "store", "cache", "state"].map(name => [name, path.join(fixture.root, name)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  const globalConfig = path.join(fixture.root, "empty-npm-global");
  write(globalConfig, "");
  const startedAt = new Date().toISOString();
  const execution = invoke(fixture, { expectations: true, timeout: 180_000, buildAction, environment: {
    HOME: directories.home, USERPROFILE: directories.home, APPDATA: directories.appdata, LOCALAPPDATA: directories.local,
    TEMP: directories.temp, TMP: directories.temp, COREPACK_HOME: directories.corepack, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    C2C_STATE_DIR: directories.state, NPM_CONFIG_USERCONFIG: fixture.emptyConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_STORE_DIR: directories.store, NPM_CONFIG_CACHE: directories.cache, NPM_CONFIG_NODE_LINKER: "isolated",
    NPM_TOKEN: "", NODE_AUTH_TOKEN: "",
  } });
  preserveNativeExecution(fixture, "execution", { startedAt, finishedAt: new Date().toISOString(), shell, argv: execution.argv, cwd: fixture.root, status: execution.status, signal: execution.signal, error: execution.error?.message, stdout: execution.stdout, stderr: execution.stderr });
  return execution;
}

describe.runIf(process.platform === "win32")("real Windows pnpm final placement", () => {
  it("W01 builds at the final path and activates working CLI and all declared dependencies", () => {
    const fixture = createRealPnpmFixture();
    const execution = invokeRealPnpm(fixture);
    expect(execution.status, execution.stdout + execution.stderr).toBe(0);
    const checkout = path.join(fixture.installRoot, "candidate");
    const cli = spawnSync(process.execPath, ["bin/c2c.js", "--version"], { cwd: checkout, encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe(candidateVersion);
    const dependencies = Object.keys(JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).dependencies);
    for (const dependency of dependencies) expect(fs.statSync(fs.realpathSync(path.join(checkout, "node_modules", dependency))).isDirectory()).toBe(true);
    const imports = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('commander'); await import('express'); await import('ignore'); await import('zod'); await import('@modelcontextprotocol/sdk/client/index.js');"], { cwd: checkout, encoding: "utf8" });
    expect(imports.status, imports.stderr).toBe(0);
    const verified = /Dependency links verified: (\d+); elapsedMs: (\d+)/.exec(execution.stdout);
    expect(Number(verified?.[1])).toBeGreaterThan(dependencies.length);
    const manifest = JSON.parse(fs.readFileSync(activePaths(fixture)[0], "utf8"));
    expect(manifest.checkout).toBe(checkout);
    expect(manifest.commit).toBe(fixture.candidateCommit);
    expect(fs.readFileSync(activePaths(fixture)[2])).toEqual(fs.readFileSync(path.join(checkout, "skill/SKILL.md")));
    expect(fs.readFileSync(activePaths(fixture)[4], "utf8")).toContain('"setupMode":"manual"');
    const noOp = invokeRealPnpm(fixture, "throw new Error('no-op must not build');");
    expect(noOp.status, noOp.stderr).toBe(0);
    expect(noOp.stdout).toContain("Existing generated code was not executed or verified");
    preserveNativeExecution(fixture, "acceptance", { cli: { status: cli.status, stdout: cli.stdout }, dependencyCount: dependencies.length, linkCount: Number(verified?.[1]), inspectionElapsedMs: Number(verified?.[2]), noOpStatus: noOp.status });
  }, 180_000);

  it.each(["commander", "nested"])("rejects real pnpm %s link corruption before activation", kind => {
    const fixture = createRealPnpmFixture();
    const before = snapshot(fixture);
    const action = kind === "commander"
      ? "const target=path.join(process.cwd(),'node_modules','commander');fs.unlinkSync(target);fs.symlinkSync(path.join(process.cwd(),'missing-commander'),target,'junction');"
      : "const store=path.join(process.cwd(),'node_modules','.pnpm');const dependency=fs.readdirSync(store).find(name=>name.startsWith('vitest@'));if(!dependency)throw new Error('real nested dependency not found');const target=path.join(store,dependency,'node_modules','vite');if(!fs.lstatSync(target).isSymbolicLink())throw new Error('real nested pnpm link required');fs.unlinkSync(target);fs.symlinkSync(path.join(process.cwd(),'missing-nested'),target,'junction');const cli=spawnSync(process.execPath,['bin/c2c.js','--version'],{encoding:'utf8'});if(cli.status!==0)throw new Error('W03 requires working CLI');console.log('W03 CLI still succeeds: '+cli.stdout.trim());";
    const execution = invokeRealPnpm(fixture, action);
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain("Dependency link validation failed");
    expect(execution.stderr).toContain(kind === "commander" ? "commander" : "vite");
    expect(execution.stderr).not.toContain(kind === "commander" ? "missing-commander" : "missing-nested");
    if (kind === "nested") expect(execution.stdout).toContain(`W03 CLI still succeeds: ${candidateVersion}`);
    expect(snapshot(fixture)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.installRoot, "candidate", "dist"))).toBe(true);
  }, 180_000);
});

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^(c2c installation-|r31-)/.test(path.basename(resolved))) throw new Error("Unexpected fixture cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "win32")("isolated Runtime installation", () => {
  it("W04 preserves a foreign directory appearing immediately before final-path reservation", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    const reservation = "[IO.Directory]::Move($candidateDirectory, $versionDirectory)";
    const source = fs.readFileSync(driver, "utf8");
    expect(source).toContain(reservation);
    write(driver, source.replace(reservation, `New-Item -ItemType Directory -Path $versionDirectory | Out-Null; [IO.File]::WriteAllText((Join-Path $versionDirectory 'foreign.txt'),'foreign owner'); ${reservation}`));
    const execution = invoke(fixture);
    expect(execution.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    const collision = path.join(fixture.installRoot, "candidate");
    expect(fs.readdirSync(collision)).toEqual(["foreign.txt"]);
    expect(fs.readFileSync(path.join(collision, "foreign.txt"), "utf8")).toBe("foreign owner");
  });

  it.each(["build", "CLI", "missing dependencies", "linked root", "circular link"])("W05 preserves active files and reports the final prepared path on %s failure", kind => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const actions: Record<string, string> = {
      build: "throw new Error('synthetic build failure');",
      CLI: "fs.writeFileSync('dist/cli.cjs',`throw new Error('synthetic CLI failure');`);",
      "missing dependencies": "fs.rmdirSync('node_modules');",
      "linked root": "fs.rmdirSync('node_modules');fs.mkdirSync('dist/external-store');fs.symlinkSync(require('node:path').resolve('dist/external-store'),'node_modules','junction');",
      "circular link": "fs.symlinkSync(require('node:path').resolve('node_modules/cycle'),'node_modules/cycle','junction');",
    };
    const execution = invoke(fixture, { buildAction: actions[kind] });
    expect(execution.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    expect(execution.stderr).toContain(`Prepared candidate retained at: ${path.join(fixture.installRoot, "candidate")}`);
  });

  it("rejects an ACL-unreadable link target without changing active files or disclosing its path", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const target = path.join(fixture.root, "denied-external-target");
    fs.mkdirSync(target);
    const deny = spawnSync("icacls.exe", [target, "/deny", "*S-1-1-0:(RD)"], { encoding: "utf8" });
    expect(deny.status, deny.stderr).toBe(0);
    try {
      const execution = invoke(fixture, { buildAction: `fs.symlinkSync(${JSON.stringify(target)},'node_modules/unreadable','junction');` });
      expect(execution.status).not.toBe(0);
      expect(execution.stderr).toContain("Dependency link validation failed");
      expect(execution.stderr).toContain("unreadable");
      expect(execution.stderr).not.toContain("denied-external-target");
      expect(snapshot(fixture)).toEqual(before);
    } finally {
      const restore = spawnSync("icacls.exe", [target, "/remove:d", "*S-1-1-0"], { encoding: "utf8" });
      expect(restore.status, restore.stderr).toBe(0);
    }
  });

  it("installs the exact candidate and leaves an unchanged active version as a no-op without executing generated code", () => {
    const fixture = createFixture();
    const installed = invoke(fixture, { bootstrap: true, expectations: true });
    expect(installed.status, installed.stderr).toBe(0);
    const checkout = path.join(fixture.installRoot, "candidate");
    const fetchHead = fs.readFileSync(path.join(checkout, ".git", "FETCH_HEAD"));
    const manifest = JSON.parse(fs.readFileSync(activePaths(fixture)[0], "utf8"));
    expect(manifest.commit).toBe(fixture.candidateCommit);
    expect(manifest.ref).toBe("candidate");
    expect(fs.readFileSync(activePaths(fixture)[2])).toEqual(fs.readFileSync(path.join(fixture.repository, "skill", "SKILL.md")));
    const before = snapshot(fixture);
    const marker = path.join(fixture.root, "untrusted-generated-code-ran");
    write(path.join(checkout, "dist", "cli.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
    const reused = invoke(fixture, { expectations: true });
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain("generated code was not executed or verified");
    expect(fs.existsSync(marker)).toBe(false);
    expect(snapshot(fixture)).toEqual(before);
    expect(fs.readFileSync(path.join(checkout, ".git", "FETCH_HEAD"))).toEqual(fetchHead);
    expect(fs.readFileSync(activePaths(fixture)[4], "utf8")).toContain('"setupMode":"manual"');
  });

  it("uses the bootstrap default ref and updater manifest ref without expected arguments", () => {
    const fixture = createFixture();
    const installed = invoke(fixture, { bootstrap: true, ref: null });
    expect(installed.status, installed.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(activePaths(fixture)[0], "utf8")).ref).toBe("v0.1.3-svl.16");
    const updated = invoke(fixture, { ref: null });
    expect(updated.status, updated.stderr).toBe(0);
  });

  it.each([
    ["commit", { expectedCommit: "0".repeat(40) }],
    ["version", { expectedVersion: "0.0.0" }],
    ["Skill digest", { expectedSkillSha256: "0".repeat(64) }],
  ])("refuses a fetched %s mismatch before build or activation", (_kind, options) => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const command = invoke(fixture, { ...options, buildAction: "throw new Error('build must not run');" });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("mismatch");
    expect(command.stderr).not.toContain("build must not run");
    expect(snapshot(fixture)).toEqual(before);
  });

  it("refuses a changed second fetch using the parent's earlier exact commit", () => {
    const fixture = createFixture();
    const earlierCommit = fixture.candidateCommit;
    write(path.join(fixture.repository, "changed.txt"), "second fetch differs");
    commit(fixture, "replace mutable ref");
    git(fixture, "tag", "-f", "candidate");
    const before = snapshot(fixture);
    const command = invoke(fixture, { expectedCommit: earlierCommit });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("commit mismatch");
    expect(snapshot(fixture)).toEqual(before);
  });

  it("uses the existing LF-normalized expected Skill digest while installing the actual CRLF bytes", () => {
    const fixture = createFixture();
    const crlfSkill = (skillBody + "Candidate revision.\n").replaceAll("\n", "\r\n");
    write(path.join(fixture.repository, "skill", "SKILL.md"), crlfSkill);
    fixture.candidateCommit = commit(fixture, "synthetic CRLF candidate");
    git(fixture, "tag", "-f", "candidate");
    const command = invoke(fixture, { expectations: true });
    expect(command.status, command.stderr).toBe(0);
    expect(fs.readFileSync(activePaths(fixture)[2])).toEqual(Buffer.from(crlfSkill));
  });

  it("refuses candidate source changes made during build before activation", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const command = invoke(fixture, { buildAction: "require('node:fs').writeFileSync('package.json','{\"version\":\"0.0.0\"}');" });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("unknown changes");
    expect(snapshot(fixture)).toEqual(before);
  });

  it.each(["dirty", "different commit", "inactive same commit", "non-checkout"])("preserves a %s version-directory collision", kind => {
    const fixture = createFixture();
    installPrevious(fixture);
    const collision = path.join(fixture.installRoot, "candidate");
    if (kind === "non-checkout") write(path.join(collision, "local.txt"), "keep me");
    else {
      git(fixture, "clone", "--quiet", "--branch", kind === "different commit" ? "previous" : "candidate", fixture.repository, collision);
      if (kind === "dirty") write(path.join(collision, "package.json"), "edited");
    }
    const before = snapshot(fixture);
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    if (kind === "non-checkout") expect(fs.readFileSync(path.join(collision, "local.txt"), "utf8")).toBe("keep me");
    if (kind === "dirty") expect(fs.readFileSync(path.join(collision, "package.json"), "utf8")).toBe("edited");
  });

  it.each(["edited Skill", "installed-only file", "installed-only directory", "missing metadata", "unavailable old source", "unknown repository"])("preserves %s during an attempted upgrade", kind => {
    const fixture = createFixture();
    installPrevious(fixture);
    const paths = activePaths(fixture);
    if (kind === "edited Skill") fs.appendFileSync(paths[2], "\r\nmanual bytes\0");
    if (kind === "installed-only file") write(path.join(path.dirname(paths[2]), "notes.txt"), "local note");
    if (kind === "installed-only directory") write(path.join(path.dirname(paths[2]), "personal", "notes.txt"), "local note");
    if (kind === "missing metadata") fs.rmSync(paths[3]);
    if (kind === "unavailable old source" || kind === "unknown repository") {
      const metadata = JSON.parse(fs.readFileSync(paths[3], "utf8"));
      if (kind === "unavailable old source") metadata.source = path.join(fixture.root, "missing", "SKILL.md");
      else metadata.repository = "https://example.invalid/other.git";
      write(paths[3], JSON.stringify(metadata));
    }
    const before = snapshot(fixture);
    const command = invoke(fixture, { expectations: true });
    expect(command.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
  });

  it("refuses active files changed while the candidate is built", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const paths = activePaths(fixture);
    const before = snapshot(fixture);
    const command = invoke(fixture, { buildAction: `require('node:fs').writeFileSync(${JSON.stringify(paths[1])},'concurrent edit');` });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("changed during preparation");
    expect(fs.readFileSync(paths[1], "utf8")).toBe("concurrent edit");
    expect(snapshot(fixture).filter((_entry, index) => index !== 1)).toEqual(before.filter((_entry, index) => index !== 1));
  });

  it.each([0, 1, 2, 3])("restores all original raw bytes when activation target %i refuses a write", index => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const command = invoke(fixture, { lock: activePaths(fixture)[index] });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("completed writes restored");
    expect(snapshot(fixture)).toEqual(before);
  });

  it("restores original absence after the candidate installer fails after partial activation", () => {
    const fixture = createFixture();
    const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    write(driver, fs.readFileSync(driver, "utf8").replace("$newManifest = [ordered]@", "throw 'synthetic post-launcher failure'\n    $newManifest = [ordered]@"));
    const before = snapshot(fixture);
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("completed writes restored");
    expect(snapshot(fixture)).toEqual(before);
    expect(fs.readdirSync(fixture.installRoot).some(name => name.startsWith(".rollback-"))).toBe(true);
  });

  it("preserves an edit made immediately before the owning installer refuses the upgrade", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    write(driver, fs.readFileSync(driver, "utf8").replace("$writtenFiles += & $skillScript", "[IO.File]::WriteAllText($previousFiles[2].Path, 'concurrent manual edit')\n    $writtenFiles += & $skillScript"));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(fs.readFileSync(activePaths(fixture)[2], "utf8")).toBe("concurrent manual edit");
    expect(snapshot(fixture).filter((_entry, index) => index !== 2)).toEqual(before.filter((_entry, index) => index !== 2));
  });

  it("preserves concurrent edits after a successful Skill write and retains old bytes when rollback conflicts", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const previousBackups = new Set(fs.readdirSync(fixture.installRoot).filter(name => name.startsWith(".rollback-")));
    const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    write(driver, fs.readFileSync(driver, "utf8").replace("$writtenFiles += Write-ActivationFile $previousFiles[1]", "[IO.File]::WriteAllText($previousFiles[2].Path, 'concurrent postwrite edit')\n    throw 'synthetic later failure'\n    $writtenFiles += Write-ActivationFile $previousFiles[1]"));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("restoration failed");
    expect(command.stderr).toContain("rollback snapshots retained");
    expect(fs.readFileSync(activePaths(fixture)[2], "utf8")).toBe("concurrent postwrite edit");
    expect(snapshot(fixture).filter((_entry, index) => index !== 2)).toEqual(before.filter((_entry, index) => index !== 2));
    const backups = fs.readdirSync(fixture.installRoot).filter(name => name.startsWith(".rollback-") && !previousBackups.has(name));
    expect(backups).toHaveLength(1);
    const backup = backups[0];
    expect(fs.readFileSync(path.join(fixture.installRoot, backup, "2.bin")).toString("base64")).toBe(before[2]);
  });

  it("uses the owning safe installer for an older candidate containing a destructive legacy installer", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const paths = activePaths(fixture);
    fs.appendFileSync(paths[2], "\nmanual edit");
    const legacyInstaller = path.join(fixture.repository, "scripts", "install-codex-c2c-skill.ps1");
    write(legacyInstaller, "param($SourceSkill,$Destination,$Repository,$Ref,$Commit)\nCopy-Item -LiteralPath $SourceSkill -Destination (Join-Path $Destination 'SKILL.md') -Force\n");
    commit(fixture, "synthetic unsafe old installer");
    git(fixture, "tag", "older-candidate");
    const before = snapshot(fixture);
    const command = invoke(fixture, { ref: "older-candidate" });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("Manually edited Skill");
    expect(snapshot(fixture)).toEqual(before);
  });

  it.each([0, 1, 2, 3])("restores existing raw bytes after a partial write of activation target %i", index => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const driver = path.join(fixture.driverDirectory, index < 2 ? "update-custom-c2c.ps1" : "install-codex-c2c-skill.ps1");
    const injection = `if ($Previous.Path -eq ${quote(activePaths(fixture)[index])}) { $stream.Write($Bytes, 0, 1); throw 'synthetic partial write' }\n      $stream.Write($Bytes, 0, $Bytes.Length)`;
    write(driver, fs.readFileSync(driver, "utf8").replace("$stream.Write($Bytes, 0, $Bytes.Length)", injection));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    expect(command.stderr).toContain("original bytes restored through the locked file");
  });

  it.each([0, 1, 2, 3])("preserves original absence after a partial write of new activation target %i", index => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const driver = path.join(fixture.driverDirectory, index < 2 ? "update-custom-c2c.ps1" : "install-codex-c2c-skill.ps1");
    const injection = `if ($Previous.Path -eq ${quote(activePaths(fixture)[index])}) { $stream.Write($Bytes, 0, 1); throw 'synthetic partial write' }\n      $stream.Write($Bytes, 0, $Bytes.Length)`;
    write(driver, fs.readFileSync(driver, "utf8").replace("$stream.Write($Bytes, 0, $Bytes.Length)", injection));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("incomplete staged bytes retained");
    expect(snapshot(fixture)).toEqual(before);
  });

  it("reports an in-write restoration failure and retains the original raw Skill bytes", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const driver = path.join(fixture.driverDirectory, "install-codex-c2c-skill.ps1");
    const injected = fs.readFileSync(driver, "utf8")
      .replace("$stream.Write($Bytes, 0, $Bytes.Length)", "$stream.Write($Bytes, 0, 1); throw 'synthetic partial write'")
      .replace("$stream.Write($Previous.Bytes, 0, $Previous.Bytes.Length)", "throw 'synthetic restoration failure'");
    write(driver, injected);
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toContain("restoration failed");
    expect(command.stderr).toContain("original bytes retained");
    expect(snapshot(fixture).filter((_entry, index) => index !== 2)).toEqual(before.filter((_entry, index) => index !== 2));
    const skillDirectory = path.dirname(activePaths(fixture)[2]);
    const backup = fs.readdirSync(skillDirectory).find(name => name.startsWith("SKILL.md.c2c-rollback-"))!;
    expect(fs.readFileSync(path.join(skillDirectory, backup)).toString("base64")).toBe(before[2]);
  });

  it("preserves empty original launcher bytes when a later activation step fails", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    fs.writeFileSync(activePaths(fixture)[1], Buffer.alloc(0));
    const before = snapshot(fixture);
    const command = invoke(fixture, { lock: activePaths(fixture)[0] });
    expect(command.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    expect(fs.existsSync(activePaths(fixture)[1])).toBe(true);
  });

  it.each([0, 1, 2, 3])("preserves a new edit after the updater rollback check of originally absent target %i", index => {
    const fixture = createFixture();
    failAfterActivation(fixture);
    const target = activePaths(fixture)[index];
    injectBeforeCheckedDeletion(fixture, "updater", target, createMutationActor(fixture, target, "edit"));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("concurrent new bytes");
    expect(command.stderr).toContain("partial rollback");
    expect(command.stderr).toContain("residual");
    expect(command.stderr).toContain("rollback snapshots retained");
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8")).mode).toBe("edit");
    for (const [otherIndex, otherPath] of activePaths(fixture).entries()) if (otherIndex < 4 && otherIndex !== index) expect(fs.existsSync(otherPath)).toBe(false);
  });

  it.each([0, 1, 2, 3])("preserves a same-byte replacement after the updater rollback check of originally absent target %i", index => {
    const fixture = createFixture();
    failAfterActivation(fixture);
    const target = activePaths(fixture)[index];
    injectBeforeCheckedDeletion(fixture, "updater", target, createMutationActor(fixture, target, "replace"));
    const command = invoke(fixture);
    expect(fs.existsSync(path.join(fixture.root, "mutation-proof.json")), command.stderr).toBe(true);
    const proof = JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8"));
    expect(command.status).not.toBe(0);
    expect(proof.before).toBe(proof.after);
    expect(fs.readFileSync(target).toString("base64")).toBe(proof.before);
    expect(command.stderr).toContain("identity changed");
    expect(command.stderr).toContain("partial rollback");
  });

  it.each(["edit", "replace"] as const)("preserves a successful %s after the standalone installer rollback check", mode => {
    const fixture = createFixture();
    failAfterFirstSkillWrite(fixture);
    const target = activePaths(fixture)[2];
    injectBeforeCheckedDeletion(fixture, "installer", target, createMutationActor(fixture, target, mode));
    const command = invoke(fixture);
    expect(fs.existsSync(path.join(fixture.root, "mutation-proof.json")), command.stderr).toBe(true);
    const proof = JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8"));
    expect(command.status).not.toBe(0);
    expect(fs.readFileSync(target).toString("base64")).toBe(proof.after);
    expect(command.stderr).toContain("partial rollback");
    if (mode === "replace") expect(command.stderr).toContain("identity changed");
    else expect(fs.readFileSync(target, "utf8")).toBe("concurrent new bytes");
  });

  it("blocks another process's edit and replacement while the checked deletion handle remains open", () => {
    const fixture = createFixture();
    failAfterActivation(fixture);
    const target = activePaths(fixture)[2];
    const actor = path.join(fixture.root, "exclusive-actor.cjs");
    const proofPath = path.join(fixture.root, "exclusive-proof.json");
    const replacement = target + ".replacement";
    write(actor, `const fs=require('node:fs');const proof={writeDenied:false,replaceDenied:false};fs.writeFileSync(${JSON.stringify(replacement)},'user replacement bytes');try{fs.writeFileSync(${JSON.stringify(target)},'user edit bytes')}catch{proof.writeDenied=true}try{fs.renameSync(${JSON.stringify(target)},${JSON.stringify(target + ".prior-owned")});fs.renameSync(${JSON.stringify(replacement)},${JSON.stringify(target)})}catch{proof.replaceDenied=true}fs.writeFileSync(${JSON.stringify(proofPath)},JSON.stringify(proof));`);
    const installer = path.join(fixture.driverDirectory, "install-codex-c2c-skill.ps1");
    const hook = `if (path == ${JSON.stringify(target)}) { using (var actor = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(${JSON.stringify(process.execPath)}, ${JSON.stringify(`"${actor}"`)}) { UseShellExecute = false, CreateNoWindow = true })) { if (!actor.WaitForExit(5000) || actor.ExitCode != 0) throw new IOException("Synthetic actor did not finish"); } }\n        if (!SetFileInformationByHandle`;
    write(installer, fs.readFileSync(installer, "utf8").replace("if (!SetFileInformationByHandle", hook));
    const before = snapshot(fixture);
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(snapshot(fixture)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).toEqual({ writeDenied: true, replaceDenied: true });
    expect(fs.readFileSync(replacement, "utf8")).toBe("user replacement bytes");
    expect(command.stderr).toContain("completed writes restored");
  });

  it.each(["updater", "installer"] as const)("reports an undeletable original-absence target during %s rollback", owner => {
    const fixture = createFixture();
    if (owner === "updater") failAfterActivation(fixture); else failAfterFirstSkillWrite(fixture);
    const target = activePaths(fixture)[2];
    const driver = path.join(fixture.driverDirectory, owner === "updater" ? "update-custom-c2c.ps1" : "install-codex-c2c-skill.ps1");
    const deletion = "[C2CFileRollback]::DeleteOwnedFile($Written.Path, $Written.OwnedFile, $Written.Written)";
    const locked = `if ($Written.Path -eq ${quote(target)}) { $otherReader = [IO.File]::Open($Written.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { ${deletion} } finally { $otherReader.Dispose() } } else { ${deletion} }`;
    write(driver, fs.readFileSync(driver, "utf8").replace(deletion, locked));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(command.stderr).toContain("partial rollback");
    expect(command.stderr).toContain("residual");
  });

  it.each(["updater", "installer"] as const)("reports a read-only original-absence target during %s rollback", owner => {
    const fixture = createFixture();
    if (owner === "updater") failAfterActivation(fixture); else failAfterFirstSkillWrite(fixture);
    const target = activePaths(fixture)[2];
    const driver = path.join(fixture.driverDirectory, owner === "updater" ? "update-custom-c2c.ps1" : "install-codex-c2c-skill.ps1");
    const deletion = "[C2CFileRollback]::DeleteOwnedFile($Written.Path, $Written.OwnedFile, $Written.Written)";
    write(driver, fs.readFileSync(driver, "utf8").replace(deletion, `if ($Written.Path -eq ${quote(target)}) { [IO.File]::SetAttributes($Written.Path, [IO.FileAttributes]::ReadOnly) }; ${deletion}`));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(command.stderr).toContain("partial rollback");
    expect(command.stderr).toContain("residual");
    fs.chmodSync(target, 0o666);
  });

  it("reports unsupported conditional deletion without falling back to path deletion", () => {
    const fixture = createFixture();
    failAfterActivation(fixture);
    const installer = path.join(fixture.driverDirectory, "install-codex-c2c-skill.ps1");
    write(installer, fs.readFileSync(installer, "utf8").replace("if (!SetFileInformationByHandle", "if (path.Length > 0) throw new NotSupportedException(\"Synthetic unsupported deletion\");\n        if (!SetFileInformationByHandle"));
    const command = invoke(fixture);
    expect(command.status).not.toBe(0);
    for (const target of activePaths(fixture).slice(0, 4)) expect(fs.existsSync(target)).toBe(true);
    expect(command.stderr).toContain("partial rollback");
    expect(command.stderr).toContain("rollback snapshots retained");
  });

  it("passes only successful in-memory write records through bootstrap and keeps parent scope and environment intact", () => {
    const fixture = createFixture();
    const progressFile = path.join(fixture.root, "build.cjs");
    fs.appendFileSync(progressFile, "\nconsole.log('synthetic native build progress');\n");
    const entry = path.join(fixture.driverDirectory, "bootstrap-custom-c2c.ps1");
    const report = path.join(fixture.root, "handoff.json");
    const call = `& ${quote(entry)} -Repository ${quote(fixture.repository)} -Ref candidate -InstallRoot ${quote(fixture.installRoot)} -ExpectedCommit ${quote(fixture.candidateCommit)} -ExpectedVersion ${quote(candidateVersion)} -ExpectedSkillSha256 ${quote(fixture.skillSha256)} -PassThru`;
    const parentScript = `$ErrorActionPreference='Stop'; $writtenFiles='parent scope'; $handoffFiles='parent handoff'; $beforeHome=$env:CODEX_HOME; $returned=@(${call}); $handles=@($returned|ForEach-Object{$_.OwnedFile.SafeFileHandle}); try { $proof=[ordered]@{count=$returned.Count;typed=@($returned|Where-Object{($_.Written -is [byte[]]) -and ($null -eq $_.Before) -and ($_.OwnedFile -is [IO.FileStream])}).Count;scopeIntact=($writtenFiles -eq 'parent scope' -and $handoffFiles -eq 'parent handoff');environmentIntact=($beforeHome -eq $env:CODEX_HOME);paths=@($returned|ForEach-Object{$_.Path});liveHandles=@($handles|Where-Object{-not $_.IsClosed}).Count} } finally { foreach($written in $returned){if($written.OwnedFile){$written.OwnedFile.Dispose()}} }; $proof.closedHandles=@($handles|Where-Object{$_.IsClosed}).Count; $proof.noOpCount=@(${call}).Count; [IO.File]::WriteAllText(${quote(report)},($proof|ConvertTo-Json -Depth 5));`;
    const command = invoke(fixture, { parentScript });
    expect(command.status, command.stderr).toBe(0);
    const proof = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(proof.count).toBe(4);
    expect(proof.typed).toBe(4);
    expect(proof.liveHandles).toBe(4);
    expect(proof.closedHandles).toBe(4);
    expect(proof.scopeIntact).toBe(true);
    expect(proof.environmentIntact).toBe(true);
    expect(proof.noOpCount).toBe(0);
    expect(new Set(proof.paths)).toEqual(new Set(activePaths(fixture).slice(0, 4)));
    expect(command.stdout).toContain("synthetic native build progress");
  });

  it("keeps a foreign change made after child success when the parent rolls back returned write records", () => {
    const fixture = createFixture();
    const entry = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    const target = activePaths(fixture)[2];
    const report = path.join(fixture.root, "parent-rollback.json");
    const parentScript = `$ErrorActionPreference='Stop'; $returned=@(& ${quote(entry)} -Repository ${quote(fixture.repository)} -Ref candidate -InstallRoot ${quote(fixture.installRoot)} -PassThru); $restoreFailures=@(); try { [IO.File]::WriteAllText(${quote(target)},'foreign change after child'); try { throw 'synthetic parent post-install failure' } catch { foreach($written in $returned){try{[C2CFileRollback]::DeleteOwnedFile($written.Path,$written.OwnedFile,$written.Written)}catch{$restoreFailures+=$written.Path}} } } finally {foreach($written in $returned){if($written.OwnedFile){$written.OwnedFile.Dispose()}}}; [IO.File]::WriteAllText(${quote(report)},([ordered]@{failures=$restoreFailures;returnedCount=$returned.Count}|ConvertTo-Json -Depth 4));`;
    const command = invoke(fixture, { parentScript });
    expect(command.status, command.stderr).toBe(0);
    const proof = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(proof.returnedCount).toBe(4);
    expect(proof.failures).toEqual([target]);
    expect(fs.readFileSync(target, "utf8")).toBe("foreign change after child");
    for (const [index, file] of activePaths(fixture).entries()) if (index < 4 && index !== 2) expect(fs.existsSync(file)).toBe(false);
  });

  it.each([0, 1, 2, 3])("preserves a same-byte replacement of existing updater target %i during rollback", index => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    failAfterActivation(fixture);
    const target = activePaths(fixture)[index];
    const actor = createMutationActor(fixture, target, "replace");
    const driver = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    const restore = "[void](Write-ActivationFile ([pscustomobject]@{ Path = $Written.Path; Bytes = $Written.Written }) $Written.Before $Written.OwnedFile)";
    const source = fs.readFileSync(driver, "utf8");
    expect(source).toContain(restore);
    write(driver, source.replace(restore, `if ($Written.Path -eq ${quote(target)}) { & ${quote(process.execPath)} ${quote(actor)}; if ($LASTEXITCODE -ne 0) { throw 'synthetic actor failed' } }; ${restore}`));
    const command = invoke(fixture);
    expect(fs.existsSync(path.join(fixture.root, "mutation-proof.json")), command.stderr).toBe(true);
    const proof = JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8"));
    expect(command.status).not.toBe(0);
    expect(fs.readFileSync(target).toString("base64")).toBe(proof.after);
    expect(proof.before).toBe(proof.after);
    expect(command.stderr).toContain("identity changed");
    expect(command.stderr).toContain("partial rollback");
    expect(snapshot(fixture).filter((_entry, other) => other !== index)).toEqual(before.filter((_entry, other) => other !== index));
  });

  it("preserves a same-byte replacement of an existing installer target during rollback", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    failAfterFirstSkillWrite(fixture);
    const target = activePaths(fixture)[2];
    const actor = createMutationActor(fixture, target, "replace");
    const driver = path.join(fixture.driverDirectory, "install-codex-c2c-skill.ps1");
    const restore = "[void](Write-SkillFile ([pscustomobject]@{ Path = $Written.Path; Bytes = $Written.Written }) $Written.Before $Written.OwnedFile)";
    const source = fs.readFileSync(driver, "utf8");
    expect(source).toContain(restore);
    write(driver, source.replace(restore, `& ${quote(process.execPath)} ${quote(actor)}; if ($LASTEXITCODE -ne 0) { throw 'synthetic actor failed' }; ${restore}`));
    const command = invoke(fixture);
    expect(fs.existsSync(path.join(fixture.root, "mutation-proof.json")), command.stderr).toBe(true);
    const proof = JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8"));
    expect(command.status).not.toBe(0);
    expect(fs.readFileSync(target).toString("base64")).toBe(proof.after);
    expect(command.stderr).toContain("identity changed");
    expect(snapshot(fixture).filter((_entry, index) => index !== 2)).toEqual(before.filter((_entry, index) => index !== 2));
  });

  it("passes live ownership for existing writes and rejects a same-byte replacement after child success", () => {
    const fixture = createFixture();
    installPrevious(fixture);
    const before = snapshot(fixture);
    const target = activePaths(fixture)[2];
    const actor = createMutationActor(fixture, target, "replace");
    const entry = path.join(fixture.driverDirectory, "update-custom-c2c.ps1");
    const report = path.join(fixture.root, "existing-parent-rollback.json");
    const parentScript = `$ErrorActionPreference='Stop'; $returned=@(& ${quote(entry)} -Repository ${quote(fixture.repository)} -Ref candidate -InstallRoot ${quote(fixture.installRoot)} -PassThru); $failures=@(); $liveCount=@($returned|Where-Object{($_.OwnedFile -is [IO.FileStream]) -and -not $_.OwnedFile.SafeFileHandle.IsClosed}).Count; try { & ${quote(process.execPath)} ${quote(actor)}; if($LASTEXITCODE -ne 0){throw 'synthetic actor failed'}; foreach($written in $returned){try{$stream=[IO.File]::Open($written.Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);try{[C2CFileRollback]::AssertSameFile($stream.SafeFileHandle,$written.OwnedFile);$current=New-Object byte[] $stream.Length;[void]$stream.Read($current,0,$current.Length);if([Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($written.Written)){throw 'foreign bytes'};$stream.Position=0;$stream.SetLength(0);$stream.Write($written.Before,0,$written.Before.Length);$stream.Flush()}finally{$stream.Dispose()}}catch{$failures+=$written.Path}} } finally {foreach($written in $returned){if($written.OwnedFile){$written.OwnedFile.Dispose()}}};[IO.File]::WriteAllText(${quote(report)},([ordered]@{failures=$failures;liveCount=$liveCount}|ConvertTo-Json -Depth 4));`;
    const command = invoke(fixture, { parentScript });
    expect(command.status, command.stderr).toBe(0);
    const proof = JSON.parse(fs.readFileSync(report, "utf8"));
    const mutation = JSON.parse(fs.readFileSync(path.join(fixture.root, "mutation-proof.json"), "utf8"));
    expect(proof.liveCount).toBe(4);
    expect(proof.failures).toEqual([target]);
    expect(fs.readFileSync(target).toString("base64")).toBe(mutation.after);
    expect(snapshot(fixture).filter((_entry, index) => index !== 2)).toEqual(before.filter((_entry, index) => index !== 2));
  });
});
