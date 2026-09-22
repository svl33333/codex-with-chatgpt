import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { TunnelMode, UiPrefsView } from "../config/ui-prefs.js";

export type TunnelPreference = "unset" | "quick" | "named";
export type TunnelSelectionSource = "workspace" | "machine" | "teamai" | "interactive" | "fallback";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
  /** Where the current preference came from; absent means legacy workspace state. */
  selectionSource?: TunnelSelectionSource;
}

export interface ResolvedTunnelSelection {
  mode: TunnelMode | null;
  zone: string | null;
  source: TunnelSelectionSource | "interactive";
  retryingFallback: boolean;
}

/**
 * A first-time setup must not silently downgrade a resolved named policy to a
 * local bridge.  Keep this check in the runtime so callers cannot accidentally
 * reintroduce the old `--no-tunnel` -> Quick Tunnel path.
 */
export function validateSetupTunnelFlag(selection: ResolvedTunnelSelection, tunnelEnabled: boolean): void {
  if (!tunnelEnabled && selection.mode === "named" && Boolean(selection.zone)) {
    throw new Error(
      "NAMED_TUNNEL_REQUIRED: resolved connection policy is named; first-time setup must provision/reuse the named tunnel"
    );
  }
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

/** Resolve workspace > machine override > TeamAI default > interactive. */
export function resolveTunnelSelection(state: TunnelState, prefs: Pick<
  UiPrefsView,
  "defaultTunnelMode" | "defaultTunnelZone" | "tunnelModeOverride" | "tunnelZoneOverride"
>): ResolvedTunnelSelection {
  const legacyOrWorkspace =
    state.preference !== "unset" &&
    Boolean(state.askedAt) &&
    (state.selectionSource === undefined || state.selectionSource === "workspace" || state.selectionSource === "interactive");
  if (legacyOrWorkspace) {
    return {
      mode: state.preference === "quick" || state.preference === "named" ? state.preference : null,
      zone: state.preference === "named" ? state.zone ?? null : null,
      source: state.selectionSource === "interactive" ? "interactive" : "workspace",
      retryingFallback: false,
    };
  }

  if (prefs.tunnelModeOverride) {
    return {
      mode: prefs.tunnelModeOverride,
      zone: prefs.tunnelModeOverride === "named" ? prefs.tunnelZoneOverride ?? prefs.defaultTunnelZone : null,
      source: "machine",
      retryingFallback: state.selectionSource === "fallback",
    };
  }

  if (prefs.defaultTunnelMode) {
    return {
      mode: prefs.defaultTunnelMode,
      zone: prefs.defaultTunnelMode === "named" ? prefs.defaultTunnelZone : null,
      source: "teamai",
      retryingFallback: state.selectionSource === "fallback",
    };
  }

  return {
    mode: null,
    zone: null,
    source: "interactive",
    retryingFallback: false,
  };
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `ChatGPTに接続する前に、公開接続方式を選択してください。
Cloudflareアカウントと、Cloudflareに追加済みのドメインがありますか？
- ある：固定ドメインを使用できます。コネクタの設定は通常1回だけで、再起動後も変更は不要です。Cloudflareへのログインとサブドメイン作成を一度行います。
- ない：一時アドレスを使用します。登録は不要で機能は同じですが、再起動後にアドレスが変わるため、ChatGPT側の接続を自動で更新する場合があります。
Cloudflareアカウントがなくても利用できます。方式を選択するか、ドメインがある場合はドメイン名（例：example.com）を入力してください。`;

export const NAMED_LOGIN_PROMPT =
  "ブラウザが開きます。Cloudflareにログインしてドメインを選択してください。完了はブラウザとトンネルの状態から自動検知して続行します。チャットでの報告は不要です。";

export const NAMED_FALLBACK_MESSAGE =
  "今回は一時アドレスを使用します。機能は同じですが、接続復旧に時間がかかる場合があります。固定ドメインへ変更する場合は設定から選択してください。";

export const NAMED_REPAIR_MESSAGE =
  "固定ドメインに一時的に接続できません。表示されるブラウザでCloudflareにログインしてドメインを選択してください。復旧は状態から自動検知して続行します。チャットでの報告は不要です。";
