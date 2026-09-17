import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync(path.join(process.cwd(), "skill", "SKILL.md"), "utf8");
const normalizedSkill = skill.replace(/\s+/g, " ");

describe("Codex-native Skill contract", () => {
  it("keeps the automatic in-app browser setup flow", () => {
    for (const phrase of [
      "ALWAYS use the built-in in-app browser (iab)",
      "`setupMode` is `auto`: automatic browser setup",
      "Fill the known form in one script",
      "Only then run `c2c pair --json`",
      "workspace_info",
      "markHandoff",
      "markDeliverable",
      "defaultTunnelMode",
      "defaultTunnelZone",
      "c2c prefs --json",
      "explicit C2C request",
      "must not pass `--no-tunnel`",
      "zero connector mutations",
      "A connector create, tunnel provision, pairing, browser action, or form submit by itself is never a HUMAN_WAITING reason",
    ]) {
      expect(normalizedSkill).toContain(phrase);
    }
  });

  it("does not broaden HUMAN_WAITING to safe browser actions", () => {
    expect(normalizedSkill).toContain("Only involve the user for logins, CAPTCHA, 2FA, explicit consent screens, or");
    expect(normalizedSkill).toContain("A browser/js timeout, a page still loading/generating, or waiting for user login/2FA does NOT count as a failure");
    expect(normalizedSkill).toContain("Do not wait for 8 tools");
    expect(normalizedSkill).toContain("never blind-resend");
  });

  it("separates workspace-scoped and machine-wide CLI flags", () => {
    expect(normalizedSkill).not.toContain("Always pass `-w <workspace root>`");
    expect(normalizedSkill).toContain("For workspace-scoped commands, pass `-w <workspace root>`");
    expect(normalizedSkill).toContain("Machine-wide commands are `update-check`, `sandbox-allow`, `prefs` (`get` and `set`), and `tunnel login`");
    expect(normalizedSkill).toContain("`c2c update-check --json` (do not pass `-w`)");
    expect(normalizedSkill).toContain("`c2c sandbox-allow --json` (do not pass `-w`)");
    expect(normalizedSkill).toContain("accepts and ignores a leftover `-w <anything>`");
    expect(normalizedSkill).toContain("These prefs are for this machine, not per workspace");
    expect(normalizedSkill).toContain("ALWAYS use the built-in in-app browser (iab)");
    expect(normalizedSkill).toContain("An explicit C2C request");
  });
});
