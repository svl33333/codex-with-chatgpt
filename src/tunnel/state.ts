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

export const TUNNEL_CHOICE_PROMPT = `ChatGPT に接続する前に、セキュア接続方式を選択してください。
Cloudflare アカウントと、Cloudflare に追加済みのドメインがありますか？
- ある：固定ドメインを使用します。一度設定すれば、通常は再起動後に変更不要です。Cloudflare に一度ログインし、ドメインにサブドメインを追加します。
- ない：一時アドレスを使用します。登録は不要で機能は同じですが、再起動後にアドレスが変わることがあります。その場合はこのプロジェクトの接続だけを更新します。
アカウントがなくても利用できます。どちらを選びますか？ドメインがある場合は例：example.com`;

export const NAMED_LOGIN_PROMPT =
  "ブラウザーで Cloudflare のログイン画面を開きます。ログインしてドメインを選択してください。完了は画面状態から検出します。";

export const NAMED_FALLBACK_MESSAGE =
  "今回は一時アドレスを使用します。機能は同じですが、接続復旧に時間がかかる場合があります。固定ドメインへの変更は後から選択できます。";

export const NAMED_REPAIR_MESSAGE =
  "固定ドメインに接続できません。ブラウザーで Cloudflare にログインしてドメインを選択してください。完了は画面状態から検出します。";
