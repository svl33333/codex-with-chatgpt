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
});
