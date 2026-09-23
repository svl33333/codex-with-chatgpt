import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Japanese user-facing localization", () => {
  it("keeps active setup/recovery prompts out of the old Chinese wording", () => {
    const files = [
      path.join(root, "skill", "SKILL.md"),
      path.join(root, "src", "cli", "index.ts"),
      path.join(root, "src", "config", "ui-prefs.ts"),
      path.join(root, "src", "config", "endpoint.ts"),
      path.join(root, "src", "tunnel", "state.ts"),
    ];
    const combined = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    for (const forbidden of ["好了", "完成后告诉我", "请登录 ChatGPT", "自动配置没有成功", "配对码："]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});
