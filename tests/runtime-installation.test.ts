import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = process.cwd();
const fixtureRoots: string[] = [];
const candidateVersion = "0.1.3-svl.15";
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

function createFixture(): InstallationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c installation-"));
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
  git(fixture, "tag", "v0.1.3-svl.15");
  fixture.skillSha256 = createHash("sha256").update(skillBody + "Candidate revision.\n").digest("hex");
  write(path.join(fixture.commandDirectory, "corepack.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(fixture.root, "build.cjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  write(path.join(fixture.root, "build.cjs"), "const fs=require('node:fs'); const path=require('node:path'); if(process.argv.includes('build')) {fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/fixture.txt','built'); if(process.env.C2C_FIXTURE_BUILD_ACTION) {eval(process.env.C2C_FIXTURE_BUILD_ACTION);}}\n");
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
} = {}) {
  const args = ["-Repository", fixture.repository, "-InstallRoot", fixture.installRoot];
  if (options.ref !== null) args.push("-Ref", options.ref ?? "candidate");
  if (options.expectations) args.push("-ExpectedCommit", fixture.candidateCommit, "-ExpectedVersion", candidateVersion, "-ExpectedSkillSha256", fixture.skillSha256);
  for (const [parameter, value] of [["ExpectedCommit", options.expectedCommit], ["ExpectedVersion", options.expectedVersion], ["ExpectedSkillSha256", options.expectedSkillSha256]]) {
    if (value !== undefined) args.push(`-${parameter}`, value);
  }
  const script = path.join(fixture.driverDirectory, options.bootstrap ? "bootstrap-custom-c2c.ps1" : "update-custom-c2c.ps1");
  const command = `$ErrorActionPreference='Stop'; ${options.lock ? `$held=[IO.File]::Open(${quote(options.lock)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {` : ""} & ${quote(script)} ${args.map((argument, index) => index % 2 === 0 ? argument : quote(argument)).join(" ")} ${options.lock ? "} finally { $held.Dispose() }" : ""}`;
  const execution = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 25_000,
    env: {
      ...process.env,
      PATH: `${fixture.commandDirectory}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_HOME: fixture.codexHome,
      LOCALAPPDATA: path.join(fixture.root, "local-app-data"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: fixture.emptyConfig,
      GIT_TERMINAL_PROMPT: "0",
      C2C_FIXTURE_BUILD_ACTION: options.buildAction ?? "",
    },
  });
  return { ...execution, stderr: execution.stderr.replace(/\r?\n\s*\|\s*/g, " ") };
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

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("isolated Runtime installation", () => {
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
    expect(JSON.parse(fs.readFileSync(activePaths(fixture)[0], "utf8")).ref).toBe("v0.1.3-svl.15");
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
    expect(command.stderr).toContain("original bytes retained");
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
});
