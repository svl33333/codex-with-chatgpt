import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { parseZoneInput } from "../tunnel/hostname.js";

export type SetupMode = "auto" | "manual";
export type TunnelMode = "quick" | "named";

export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];
export const TUNNEL_MODES: readonly TunnelMode[] = ["quick", "named"];

/** Shown once, before the first ChatGPT connection on this machine. */
export const SETUP_CHOICE_PROMPT = [
  "ChatGPT に初めて接続する前に、設定方式を選択してください（初回のみ。以後は保持されます）：",
  "",
  "**1. AI 自動設定（プレビュー）**",
  "内蔵ブラウザーで設定を実行します。ログイン、CAPTCHA、または本人確認が必要な場合だけ操作してください。",
  "利点：画面をほとんど操作する必要がありません。",
  "注意：手順が多く時間がかかる場合があります。設定が同じ箇所で2回失敗した場合は手動設定に切り替えます。",
  "",
  "**2. 手動設定**",
  "画面を開く場所と入力項目を一つずつ案内し、ブラウザー上の操作を依頼します。",
  "利点：約3分で完了し、手順を確認しながら進められます。",
  "注意：案内に従って画面を操作する必要があります。",
  "",
  "「1」または「2」と返信してください。選択されるまで設定を開始しません。",
].join("\n");

interface StoredUiPrefs {
  developerModeEnabled?: boolean;
  setupMode?: SetupMode;
  defaultTunnelMode?: TunnelMode;
  defaultTunnelZone?: string;
  tunnelModeOverride?: TunnelMode;
  tunnelZoneOverride?: string;
  updatedAt: string;
}

export interface UiPrefsView {
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  defaultTunnelMode: TunnelMode | null;
  defaultTunnelZone: string | null;
  tunnelModeOverride: TunnelMode | null;
  tunnelZoneOverride: string | null;
  setupChoicePrompt: string;
  remembered: {
    developerMode: boolean;
    setupMode: boolean;
  };
}

export function prefsFile(): string {
  return path.join(getStateDir(), "prefs.json");
}

function readStored(): StoredUiPrefs | null {
  const raw = readJsonIfExists<StoredUiPrefs>(prefsFile());
  if (!raw || typeof raw !== "object") return null;
  const setupMode = raw.setupMode === "auto" || raw.setupMode === "manual" ? raw.setupMode : undefined;
  const defaultTunnelMode = TUNNEL_MODES.includes(raw.defaultTunnelMode as TunnelMode)
    ? (raw.defaultTunnelMode as TunnelMode)
    : undefined;
  const tunnelModeOverride = TUNNEL_MODES.includes(raw.tunnelModeOverride as TunnelMode)
    ? (raw.tunnelModeOverride as TunnelMode)
    : undefined;
  const defaultTunnelZone = typeof raw.defaultTunnelZone === "string" ? parseZoneInput(raw.defaultTunnelZone) ?? undefined : undefined;
  const tunnelZoneOverride = typeof raw.tunnelZoneOverride === "string" ? parseZoneInput(raw.tunnelZoneOverride) ?? undefined : undefined;
  return {
    developerModeEnabled: raw.developerModeEnabled === true,
    setupMode,
    defaultTunnelMode,
    defaultTunnelZone,
    tunnelModeOverride,
    tunnelZoneOverride,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

export function readUiPrefs(): UiPrefsView {
  const stored = readStored();
  const developerModeEnabled = stored?.developerModeEnabled === true;
  const setupMode = stored?.setupMode ?? null;
  return {
    developerModeEnabled,
    setupMode,
    defaultTunnelMode: stored?.defaultTunnelMode ?? null,
    defaultTunnelZone: stored?.defaultTunnelZone ?? null,
    tunnelModeOverride: stored?.tunnelModeOverride ?? null,
    tunnelZoneOverride: stored?.tunnelZoneOverride ?? null,
    setupChoicePrompt: SETUP_CHOICE_PROMPT,
    remembered: {
      developerMode: developerModeEnabled,
      setupMode: setupMode !== null,
    },
  };
}

export interface UiPrefsPatch {
  developerModeEnabled?: true;
  setupMode?: SetupMode;
  defaultTunnelMode?: TunnelMode;
  defaultTunnelZone?: string;
  tunnelModeOverride?: TunnelMode;
  tunnelZoneOverride?: string;
}

export function mergeUiPrefs(patch: UiPrefsPatch): UiPrefsView {
  if (patch.setupMode !== undefined && !SETUP_MODES.includes(patch.setupMode)) {
    throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
  }
  if (patch.defaultTunnelMode !== undefined && !TUNNEL_MODES.includes(patch.defaultTunnelMode)) {
    throw new Error(`default-tunnel must be one of ${TUNNEL_MODES.join(", ")}`);
  }
  if (patch.tunnelModeOverride !== undefined && !TUNNEL_MODES.includes(patch.tunnelModeOverride)) {
    throw new Error(`tunnel-override must be one of ${TUNNEL_MODES.join(", ")}`);
  }
  const defaultTunnelZone = patch.defaultTunnelZone === undefined ? undefined : parseZoneInput(patch.defaultTunnelZone);
  if (patch.defaultTunnelZone !== undefined && !defaultTunnelZone) {
    throw new Error("default-tunnel-zone must be a valid hostname");
  }
  const tunnelZoneOverride = patch.tunnelZoneOverride === undefined ? undefined : parseZoneInput(patch.tunnelZoneOverride);
  if (patch.tunnelZoneOverride !== undefined && !tunnelZoneOverride) {
    throw new Error("tunnel-override-zone must be a valid hostname");
  }
  const previous = readStored();
  const setupMode = patch.setupMode ?? previous?.setupMode;
  const resolvedDefaultTunnelMode = patch.defaultTunnelMode ?? previous?.defaultTunnelMode;
  const resolvedDefaultTunnelZone = defaultTunnelZone ?? previous?.defaultTunnelZone;
  const resolvedTunnelModeOverride = patch.tunnelModeOverride ?? previous?.tunnelModeOverride;
  const resolvedTunnelZoneOverride = tunnelZoneOverride ?? previous?.tunnelZoneOverride;
  const stored: StoredUiPrefs = {
    updatedAt: new Date().toISOString(),
  };
  // Only persist "confirmed on". Never write false — that would skip the
  // Security page on a new ChatGPT account or a machine restore.
  if (patch.developerModeEnabled === true || previous?.developerModeEnabled === true) {
    stored.developerModeEnabled = true;
  }
  if (setupMode) stored.setupMode = setupMode;
  if (resolvedDefaultTunnelMode) stored.defaultTunnelMode = resolvedDefaultTunnelMode;
  if (resolvedDefaultTunnelZone) stored.defaultTunnelZone = resolvedDefaultTunnelZone;
  if (resolvedTunnelModeOverride) stored.tunnelModeOverride = resolvedTunnelModeOverride;
  if (resolvedTunnelZoneOverride) stored.tunnelZoneOverride = resolvedTunnelZoneOverride;
  writeSecureJson(prefsFile(), stored);
  return readUiPrefs();
}
