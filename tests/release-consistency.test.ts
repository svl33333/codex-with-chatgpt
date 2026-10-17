import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const candidateVersion = "0.1.3-svl.17";
const candidateRef = "v0.1.3-svl.17";

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("custom runtime release consistency", () => {
  it("keeps the candidate version and default refs aligned", () => {
    const packageJson = JSON.parse(read("package.json")) as { version: string };
    expect(packageJson.version).toBe(candidateVersion);
    expect(read("src/version.ts")).toContain(`VERSION = "${candidateVersion}"`);
    const provenanceDocument = read("docs/custom-stability-patches.md");
    expect(provenanceDocument).toContain(`Custom version: \`${candidateVersion}\``);
    expect(provenanceDocument).toContain("Publication status: source candidate; no `.17` tag or release has been published.");
    expect(provenanceDocument).toContain("Previous immutable tag: `v0.1.3-svl.16` at `9b80750bd55cd6f526b78c01dacab649ea04d9c4`.");
    expect(read("scripts/bootstrap-custom-c2c.ps1")).toContain(`[string]$Ref = "${candidateRef}"`);
    expect(read("scripts/install-codex-c2c-skill.ps1")).toContain(`[string]$Ref = "${candidateRef}"`);
  });

  it("does not retain stale release defaults in the scoped release surfaces", () => {
    for (const file of [
      "package.json",
      "src/version.ts",
      "docs/custom-stability-patches.md",
      "scripts/bootstrap-custom-c2c.ps1",
      "scripts/install-codex-c2c-skill.ps1",
    ]) {
      expect(read(file), file).not.toMatch(/0\.1\.3-svl\.12|v0\.1\.3-svl\.12/);
    }
  });

  it("keeps update-custom-c2c manifest-driven when no ref is supplied", () => {
    const updater = read("scripts/update-custom-c2c.ps1");
    expect(updater).toContain("if (-not $Ref)");
    expect(updater).toContain("$manifest.ref");
    expect(updater).not.toMatch(/\[string\]\$Ref\s*=\s*"v0\.1\.3-svl\./);
  });

  it("keeps bootstrap as the updater entry point with optional expected identities", () => {
    const bootstrap = read("scripts/bootstrap-custom-c2c.ps1");
    expect(bootstrap).toContain("update-custom-c2c.ps1");
    expect(bootstrap).not.toContain("git clone");
    for (const parameter of ["ExpectedCommit", "ExpectedVersion", "ExpectedSkillSha256"]) {
      expect(bootstrap).toContain(`[string]$${parameter}`);
      expect(read("scripts/update-custom-c2c.ps1")).toContain(`[string]$${parameter}`);
    }
  });
});
