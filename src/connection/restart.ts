import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureFile } from "../config/paths.js";
import { endpointFile, normalizePublicUrl, writeLastEndpoint, type LastEndpoint } from "../config/endpoint.js";
import { bindingFile, endpointFingerprint, type ConnectionBinding } from "./identity.js";
import { Workspace } from "../workspace/manager.js";
import { resolveRestartRepository } from "../workspace/repository.js";
import { readUiPrefs } from "../config/ui-prefs.js";
import { readTunnelState, resolveTunnelSelection, tunnelStateFile } from "../tunnel/state.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { findBridgeObservation, RESTART_PROTOCOL, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, type BridgeStartOptions, type EnsureBridgeResult } from "../process/daemon.js";
import { withWorkspaceOperation } from "../process/workspace-operation.js";
import { SERVICE_NAME } from "../version.js";

type JsonObject = Record<string, unknown>;
function objectFrom(bytes: Buffer | null): JsonObject {
  try {
    const value: unknown = JSON.parse(bytes?.toString("utf8") ?? "");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  } catch { /* The error must not contain local metadata. */ }
  throw new Error("RESTART_METADATA_UNAVAILABLE");
}

function readBytes(file: string): Buffer | null {
  try { return fs.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("RESTART_METADATA_UNAVAILABLE");
  }
}

export function prepareRestart(workspaceRoot: string) {
  const workspace = new Workspace(workspaceRoot);
  const files = [
    bindingFile(workspace.id), endpointFile(workspace.id), tunnelStateFile(workspace.id),
    path.join(getStateDir(), "installation.json"), path.join(getStateDir(), "prefs.json"),
  ];
  const snapshots = files.map(readBytes);
  const binding = objectFrom(snapshots[0]);
  const endpoint = objectFrom(snapshots[1]);
  const installation = objectFrom(snapshots[3]);
  if (![1, 2].includes(binding.schemaVersion as number) ||
      binding.workspaceId !== workspace.id || binding.workspace !== workspace.name ||
      endpoint.workspaceId !== workspace.id || endpoint.workspace !== workspace.name ||
      typeof binding.canonicalRepository !== "string" ||
      typeof binding.installationId !== "string" ||
      !/^[0-9a-f-]{16,64}$/i.test(binding.installationId) ||
      binding.installationId !== installation.installationId ||
      typeof binding.connectorName !== "string" || !binding.connectorName.trim() ||
      !["stable", "ephemeral"].includes(binding.endpointMode as string)) {
    throw new Error("RESTART_BINDING_MISMATCH");
  }
  for (const field of ["canonicalRepository", "installationId", "endpointMode", "endpointFingerprint", "connectorName"]) {
    if (binding[field] !== endpoint[field]) throw new Error("RESTART_BINDING_MISMATCH");
  }
  const tunnel = readTunnelState(workspace.id);
  const selection = resolveTunnelSelection(tunnel, readUiPrefs());
  if (tunnel.workspaceId !== workspace.id || tunnel.preference !== "named" ||
      tunnel.provider !== "cloudflare-named" || !tunnel.tunnelName ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(tunnel.tunnelName) ||
      !tunnel.tunnelId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tunnel.tunnelId) ||
      !tunnel.hostname || !tunnel.zone || selection.mode !== "named" ||
      selection.zone !== tunnel.zone ||
      !(tunnel.selectionSource === selection.source || tunnel.selectionSource === undefined || tunnel.selectionSource === "workspace")) {
    throw new Error("RESTART_NAMED_REUSE_UNAVAILABLE");
  }
  const hostname = normalizeNamedTunnelHostname(tunnel.hostname);
  const publicUrl = "https://" + hostname;
  const mcpUrl = publicUrl + "/mcp";
  if (typeof endpoint.publicUrl !== "string" || normalizePublicUrl(endpoint.publicUrl) !== publicUrl ||
      typeof endpoint.mcpUrl !== "string" || normalizePublicUrl(endpoint.mcpUrl) !== mcpUrl ||
      binding.endpointFingerprint !== endpointFingerprint(endpoint.mcpUrl, binding.endpointMode as ConnectionBinding["endpointMode"])) {
    throw new Error("RESTART_ENDPOINT_MISMATCH");
  }
  const repository = resolveRestartRepository(workspace.root, binding.canonicalRepository);
  return {
    workspace, files, snapshots, repository, publicUrl, mcpUrl,
    binding: binding as unknown as ConnectionBinding,
    endpoint: endpoint as unknown as LastEndpoint,
    named: { tunnelId: tunnel.tunnelId, tunnelName: tunnel.tunnelName, hostname },
  };
}

type RestartContext = ReturnType<typeof prepareRestart>;

export function assertRestartUnchanged(context: RestartContext, writtenEndpoint?: Buffer): void {
  for (let index = 0; index < context.files.length; index++) {
    const expected = index === 1 && writtenEndpoint ? writtenEndpoint : context.snapshots[index];
    const current = readBytes(context.files[index]);
    if (expected === null ? current !== null : current === null || !expected.equals(current)) {
      throw new Error("RESTART_IDENTITY_CHANGED");
    }
  }
  const workspace = new Workspace(context.workspace.root);
  if (workspace.id !== context.workspace.id || workspace.name !== context.workspace.name ||
      JSON.stringify(resolveRestartRepository(workspace.root, context.binding.canonicalRepository)) !== JSON.stringify(context.repository)) {
    throw new Error("RESTART_GIT_CHANGED");
  }
}

export interface RestartInfo {
  service: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  startedAt: string;
  publicUrl: string | null;
  restartProtocol?: number;
  authorizationPaused?: boolean;
  tunnel: { running: boolean; url: string | null; provider: string };
}

export interface RestartDependencies {
  observe: typeof findBridgeObservation;
  start: (root: string, options: BridgeStartOptions) => Promise<EnsureBridgeResult>;
  request: typeof adminFetch;
  waitForExit: (runtime: RuntimeState) => Promise<void>;
}

export async function waitForBridgeExit(runtime: RuntimeState, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(runtime.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error("RESTART_EXIT_UNKNOWN");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("RESTART_EXIT_TIMEOUT");
}

function verifyBridge(context: RestartContext, runtime: RuntimeState, info: RestartInfo): void {
  if (runtime.workspaceId !== context.workspace.id || runtime.workspaceRoot !== context.workspace.root ||
      info.service !== SERVICE_NAME || info.workspaceId !== context.workspace.id ||
      info.workspaceRoot !== context.workspace.root || info.pid !== runtime.pid || info.startedAt !== runtime.startedAt) {
    throw new Error("RESTART_BRIDGE_MISMATCH");
  }
  if (info.restartProtocol !== RESTART_PROTOCOL) throw new Error("RESTART_PROTOCOL_UNAVAILABLE");
}

export function restartWorkspace(workspaceRoot: string, overrides: Partial<RestartDependencies> = {}) {
  return withWorkspaceOperation(new Workspace(workspaceRoot).id, async () => {
    const dependencies: RestartDependencies = {
      observe: findBridgeObservation, start: ensureBridge, request: adminFetch,
      waitForExit: waitForBridgeExit, ...overrides,
    };
    const context = prepareRestart(workspaceRoot);
    const previous = await dependencies.observe(context.workspace.id);
    if (previous.state === "unknown") throw new Error("RESTART_BRIDGE_UNKNOWN");
    if (previous.state === "healthy") {
      const info = await dependencies.request<RestartInfo>(previous.runtime, "GET", "/admin/info");
      verifyBridge(context, previous.runtime, info);
      if (info.tunnel.provider !== "cloudflare-named" || !info.tunnel.running ||
          info.publicUrl !== context.publicUrl || info.tunnel.url !== context.publicUrl ||
          previous.runtime.publicUrl !== context.publicUrl) {
        throw new Error("RESTART_LIVE_ENDPOINT_MISMATCH");
      }
      assertRestartUnchanged(context);
      await dependencies.request(previous.runtime, "POST", "/admin/shutdown?mode=restart");
      await dependencies.waitForExit(previous.runtime);
    }
    assertRestartUnchanged(context);
    let candidate: RuntimeState | null = null;
    let writtenEndpoint: Buffer | undefined;
    try {
      const started = await dependencies.start(context.workspace.root, { restart: context.named });
      if (!started.spawned) throw new Error("RESTART_CANDIDATE_NOT_OWNED");
      candidate = started.runtime;
      let info = await dependencies.request<RestartInfo>(candidate, "GET", "/admin/info");
      verifyBridge(context, candidate, info);
      if (info.authorizationPaused !== true) throw new Error("RESTART_CANDIDATE_NOT_PAUSED");
      assertRestartUnchanged(context);
      await dependencies.request(candidate, "POST", "/admin/tunnel/start", 90_000);
      info = await dependencies.request<RestartInfo>(candidate, "GET", "/admin/info");
      verifyBridge(context, candidate, info);
      if (info.publicUrl !== context.publicUrl || !info.tunnel.running ||
          info.tunnel.provider !== "cloudflare-named" || info.tunnel.url !== context.publicUrl) {
        throw new Error("RESTART_TUNNEL_MISMATCH");
      }
      assertRestartUnchanged(context);
      const saved = writeLastEndpoint({ ...context.endpoint, port: candidate.port });
      writtenEndpoint = Buffer.from(JSON.stringify(saved, null, 2));
      assertRestartUnchanged(context, writtenEndpoint);
      await dependencies.request(candidate, "POST", "/admin/restart/complete");
      return { ok: true, workspaceId: context.workspace.id, port: candidate.port, mcpUrl: context.endpoint.mcpUrl };
    } catch (error) {
      if (!candidate && error instanceof Error && error.message === "RESTART_CANDIDATE_CLEANUP_FAILED") {
        throw new Error("RESTART_CANDIDATE_CLEANUP_FAILED");
      }
      if (candidate) {
        try {
          const info = await dependencies.request<RestartInfo>(candidate, "GET", "/admin/info");
          verifyBridge(context, candidate, info);
          if (info.authorizationPaused !== true) throw new Error("RESTART_COMPLETION_UNCONFIRMED");
          await dependencies.request(candidate, "POST", "/admin/shutdown?mode=restart");
          await dependencies.waitForExit(candidate);
          if (writtenEndpoint && readBytes(context.files[1])?.equals(writtenEndpoint)) {
            writeSecureFile(context.files[1], context.snapshots[1]!);
          }
        } catch {
          throw new Error("RESTART_FAILED_CANDIDATE_REMAINS");
        }
      }
      throw new Error("RESTART_FAILED");
    }
  });
}
