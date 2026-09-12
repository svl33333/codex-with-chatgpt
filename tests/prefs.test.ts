import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeUiPrefs,
  prefsFile,
  readUiPrefs,
  SETUP_CHOICE_PROMPT,
} from "../src/config/ui-prefs.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("ui prefs", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("starts empty and is not bound to a workspace", () => {
    dirs.push(isolateStateDir());
    const prefs = readUiPrefs();
    expect(prefs.developerModeEnabled).toBe(false);
    expect(prefs.setupMode).toBeNull();
    expect(prefs.defaultTunnelMode).toBeNull();
    expect(prefs.defaultTunnelZone).toBeNull();
    expect(prefs.tunnelModeOverride).toBeNull();
    expect(prefs.tunnelZoneOverride).toBeNull();
    expect(prefs.remembered).toEqual({ developerMode: false, setupMode: false });
    expect(prefs.setupChoicePrompt).toBe(SETUP_CHOICE_PROMPT);
    expect(prefs.setupChoicePrompt).toContain("AI 自动化配置（预览版）");
    expect(prefs.setupChoicePrompt).toContain("手动教学配置");
    expect(prefs.setupChoicePrompt).toContain("请回复「1」或「2」");
  });

  it("remembers developer mode as on only, never as off", () => {
    dirs.push(isolateStateDir());
    const saved = mergeUiPrefs({ developerModeEnabled: true });
    expect(saved.developerModeEnabled).toBe(true);
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as { developerModeEnabled?: boolean };
    expect(raw.developerModeEnabled).toBe(true);
    expect(JSON.stringify(raw)).not.toMatch(/token|pairing|secret/i);
  });

  it("saves setup mode without dropping developer mode", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ developerModeEnabled: true });
    const next = mergeUiPrefs({ setupMode: "manual" });
    expect(next.developerModeEnabled).toBe(true);
    expect(next.setupMode).toBe("manual");
    const auto = mergeUiPrefs({ setupMode: "auto" });
    expect(auto.setupMode).toBe("auto");
    expect(auto.developerModeEnabled).toBe(true);
  });

  it("rejects an unknown setup mode", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ setupMode: "browser" as "auto" })).toThrow(/setup-mode/);
    expect(readUiPrefs().setupMode).toBeNull();
  });

  it("ignores a hand-edited developerModeEnabled false", () => {
    dirs.push(isolateStateDir());
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ developerModeEnabled: false, setupMode: "auto", updatedAt: "2026-01-01T00:00:00.000Z" }),
      { mode: 0o600 }
    );
    expect(readUiPrefs().developerModeEnabled).toBe(false);
    expect(readUiPrefs().remembered.developerMode).toBe(false);
    expect(readUiPrefs().setupMode).toBe("auto");
  });

  it("stores public tunnel defaults and machine overrides without credentials", () => {
    dirs.push(isolateStateDir());
    const saved = mergeUiPrefs({
      setupMode: "auto",
      defaultTunnelMode: "named",
      defaultTunnelZone: "https://aristocrats.win/",
      tunnelModeOverride: "quick",
    });
    expect(saved.defaultTunnelMode).toBe("named");
    expect(saved.defaultTunnelZone).toBe("aristocrats.win");
    expect(saved.tunnelModeOverride).toBe("quick");
    const raw = fs.readFileSync(prefsFile(), "utf8");
    expect(raw).toContain("aristocrats.win");
    expect(raw).not.toMatch(/token|credential|cookie|pairing|secret/i);
  });

  it("rejects invalid tunnel defaults", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ defaultTunnelMode: "manual" as "named" })).toThrow(/default-tunnel/);
    expect(() => mergeUiPrefs({ defaultTunnelZone: "not a hostname" })).toThrow(/default-tunnel-zone/);
  });
});
