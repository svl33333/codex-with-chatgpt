import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync(path.join(process.cwd(), "skill", "SKILL.md"), "utf8");
const normalizedSkill = skill.replace(/\s+/g, " ");

describe("Codex-native Skill contract", () => {
  it("keeps the automatic in-app browser setup flow", () => {
    for (const phrase of [
      "Prefer the built-in in-app browser (iab)",
      "supported authenticated-browser-profile fallback",
      "semantic surface capability",
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
    expect(normalizedSkill).toContain("Prefer the built-in in-app browser (iab)");
    expect(normalizedSkill).toContain("An explicit C2C request");
  });

  it("uses Japanese rather than the former Chinese setup and recovery wording", () => {
    expect(normalizedSkill).toContain("ChatGPT で新しいプロジェクトを作成し");
    expect(normalizedSkill).toContain("projectDisplayName");
    expect(normalizedSkill).toContain("c2c workspace -w <workspace> --json");
    expect(normalizedSkill).toContain("プロジェクト限定メモリ");
    expect(normalizedSkill).toContain("プロジェクトで整理");

    for (const phrase of [
      "使用 Codex with ChatGPT",
      "用 ChatGPT 规划",
      "连接 ChatGPT",
      "安全连接",
      "检测到",
      "开发人员模式",
      "插件总管",
      "加插件",
      "新对话",
      "接下来用手动教学配置",
      "自动配置没有成功",
      "当前项目已识别",
      "请登录 ChatGPT",
      "请在 ChatGPT 里新建一个项目",
      "仅限项目记忆",
      "按项目整理",
      "项目设置",
      "库访问权限",
      "已完成 12 轮协作",
      "断开 ChatGPT",
      "全关掉以后",
      "全关掉后连接失效",
    ]) {
      expect(normalizedSkill).not.toContain(phrase);
    }
  });

  it("continues from machine-observable setup state without acknowledgement stops", () => {
    expect(normalizedSkill).toContain("c2c provisioning set");
    expect(normalizedSkill).toContain("resume immediately");
    expect(normalizedSkill).toContain("workspace_info");
    expect(normalizedSkill).toContain("c2c app-selection record");
    expect(normalizedSkill).toContain("--invocation pending");
    expect(normalizedSkill).toContain("--invocation succeeded");
    expect(normalizedSkill).toContain("--selection-task <task>");
    expect(normalizedSkill).toContain("verifies this exact successful record");
    expect(normalizedSkill).not.toContain("waiting for the user to say「完了」");
    expect(normalizedSkill).not.toContain("完了」と伝えてください");
    expect(normalizedSkill).not.toContain("承認してから続行");
  });

  it("uses the app-shell custom-MCP route and runtime-owned consent decision", () => {
    expect(normalizedSkill).toContain("clear any inherited search/filter");
    expect(normalizedSkill).toContain("Create a custom MCP server");
    expect(normalizedSkill).toContain("Settings -> Plugins");
    expect(normalizedSkill).toContain("route drift");
    expect(normalizedSkill).toContain("c2c consent verify-account");
    expect(normalizedSkill).toContain("machine-verified `ConnectionBinding.accountFingerprint`");
    expect(normalizedSkill).toContain("c2c consent prepare");
    expect(normalizedSkill).toContain("c2c consent decide");
    expect(normalizedSkill).toContain("--challenge-id <id>");
    expect(normalizedSkill).toContain("--observation-json <runtime-only-path>");
    expect(normalizedSkill).toContain("atomically consumed");
    expect(normalizedSkill).toContain("first-time automatic setup");
    expect(normalizedSkill).toContain("reconnect/recovery");
    expect(normalizedSkill).toContain("guided manual setup");
  });

  it("uses the exact message-keyed ReviewerProof production path", () => {
    expect(normalizedSkill).toContain("c2c reviewer-proof build");
    expect(normalizedSkill).toContain("--evidence-json <runtime-only-path>");
    expect(normalizedSkill).toContain("--output <runtime-only-proof-path>");
    expect(normalizedSkill).toContain("--reviewer-proof-json <runtime-only-proof-path>");
    expect(normalizedSkill).toContain("complete required `git_diff`");
    expect(normalizedSkill).toContain("Do not use a second or substituted proof");
    expect(normalizedSkill).toContain("Never use the old boolean-only app-selection or READY command sequence");
  });

  it("keeps runtime proof files until READY consumes the same proof", () => {
    const buildIndex = normalizedSkill.indexOf("c2c reviewer-proof build");
    const readyIndex = normalizedSkill.indexOf(
      "c2c provisioning set -w <workspace> --phase ready",
    );
    const cleanupIndex = normalizedSkill.indexOf(
      "remove the runtime-only evidence and proof files",
    );

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(buildIndex);
    expect(cleanupIndex).toBeGreaterThan(readyIndex);
  });

  it("keeps runtime setup and recovery output localized and observable", () => {
    const runtime = [
      fs.readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8"),
      fs.readFileSync(path.join(process.cwd(), "src", "config", "endpoint.ts"), "utf8"),
      fs.readFileSync(path.join(process.cwd(), "src", "config", "ui-prefs.ts"), "utf8"),
      fs.readFileSync(path.join(process.cwd(), "src", "tunnel", "state.ts"), "utf8"),
    ].join("\n");

    for (const phrase of [
      "当前项目已识别",
      "正在连接 ChatGPT",
      "安全连接已建立",
      "配对码",
      "开发人员模式",
      "配置方式",
      "完成后告诉我",
      "告诉我「好了」",
    ]) {
      expect(runtime).not.toContain(phrase);
    }
    expect(runtime).toContain("ChatGPT に接続しています");
    expect(runtime).toContain("完了はブラウザとトンネルの状態から自動検知");
    expect(runtime).toContain("チャットでの報告は不要");
  });
});
