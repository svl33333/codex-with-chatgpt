import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir, writeSecureJson } from "../src/config/paths.js";
import { bindingFile, getInstallationIdentity, makeConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { endpointFile, readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { prepareRestart, assertRestartUnchanged, restartWorkspace, waitForBridgeExit, type RestartDependencies, type RestartInfo } from "../src/connection/restart.js";
import { resolveWorkspaceRepository } from "../src/workspace/repository.js";
import { ensureBridge } from "../src/process/daemon.js";
import { RESTART_PROTOCOL, type RuntimeState } from "../src/bridge/runtime.js";
import { SERVICE_NAME } from "../src/version.js";

const directories: string[] = [];
let workspace: Workspace;
const tunnelId = "11111111-1111-4111-8111-111111111111";
function fixture(mode: "stable" | "ephemeral" = "stable") {
  const root = makeTmpDir("restart-workspace"); directories.push(root);
  makeGitRepo(root);
  git(root, "remote", "add", "origin", "https://github.com/example/restart-fixture");
  const current = new Workspace(root);
  const publicUrl = "https://restart.example.invalid";
  const binding = makeConnectionBinding({
    workspaceId: current.id, workspace: current.name, workspaceRoot: current.root,
    endpoint: publicUrl + "/mcp", endpointMode: mode,
    projectName: "retained", readOnlyRequired: true, accountFingerprint: "synthetic-account",
  });
  writeSecureJson(bindingFile(current.id), { ...binding, schemaVersion: 1, extension: { retained: ["a", 7] } });
  writeLastEndpoint({
    workspaceId: current.id, workspace: current.name, canonicalRepository: binding.canonicalRepository,
    installationId: binding.installationId, endpointMode: mode, endpointFingerprint: binding.endpointFingerprint,
    connectorName: binding.connectorName, publicUrl, mcpUrl: publicUrl + "/mcp", port: 32171,
  });
  writeTunnelState({
    workspaceId: current.id, preference: "named", provider: "cloudflare-named",
    tunnelId, tunnelName: "existing-fixture", hostname: "restart.example.invalid",
    zone: "example.invalid", askedAt: "fixture", selectionSource: "workspace",
  });
  return current;
}

function services(current = workspace) {
  const runtime = (pid: number, port: number): RuntimeState => ({
    service: SERVICE_NAME, version: "fixture", workspaceId: current.id, workspaceRoot: current.root,
    pid, port, adminToken: "synthetic-only", startedAt: "2026-01-01T00:00:00Z", publicUrl: null,
  });
  const old = runtime(50001, 32171), next = runtime(50002, 32172);
  old.publicUrl = "https://restart.example.invalid";
  let established = false, paused = true;
  const calls: string[] = [];
  const reply: RestartDependencies["request"] = async <T>(selected: RuntimeState, method: "GET" | "POST", route: string): Promise<T> => {
    calls.push(method + " " + route);
    let value: unknown = {};
    if (route === "/admin/info") {
      value = {
        service: SERVICE_NAME, workspaceId: current.id, workspaceRoot: current.root,
        pid: selected.pid, startedAt: selected.startedAt, restartProtocol: RESTART_PROTOCOL,
        authorizationPaused: selected.pid === next.pid ? paused : false,
        publicUrl: selected.pid === old.pid || established ? "https://restart.example.invalid" : null,
        tunnel: { running: selected.pid === old.pid || established, provider: "cloudflare-named",
          url: selected.pid === old.pid || established ? "https://restart.example.invalid" : null },
      } satisfies RestartInfo;
    }
    if (route === "/admin/tunnel/start") established = true;
    if (route === "/admin/restart/complete") paused = false;
    return value as T;
  };
  const dependencies: RestartDependencies = {
    observe: vi.fn(async () => ({ state: "healthy", runtime: old })),
    start: vi.fn(async () => ({ runtime: next, spawned: true })),
    waitForExit: vi.fn(async () => undefined), request: reply,
  };
  return { dependencies, calls, old, next };
}

beforeEach(() => {
  directories.push(isolateStateDir());
  workspace = fixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const directory of directories.splice(0)) cleanup(directory);
});

describe("identity-preserving named restart", () => {
  it.each(["stable", "ephemeral"] as const)("keeps %s mode, fingerprint, schema and extension metadata", async (mode) => {
    if (mode === "ephemeral") workspace = fixture(mode);
    const before = fs.readFileSync(bindingFile(workspace.id));
    const endpoint = readLastEndpoint(workspace.id)!;
    const { dependencies, calls } = services();
    await expect(restartWorkspace(workspace.root, dependencies)).resolves.toMatchObject({ ok: true, workspaceId: workspace.id });
    expect(fs.readFileSync(bindingFile(workspace.id))).toEqual(before);
    expect(readLastEndpoint(workspace.id)).toMatchObject({ ...endpoint, port: 32172, savedAt: expect.any(String) });
    expect(dependencies.start).toHaveBeenCalledWith(workspace.root, { restart: {
      tunnelId, tunnelName: "existing-fixture", hostname: "restart.example.invalid",
    } });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST /admin/shutdown?mode=restart", "POST /admin/tunnel/start", "POST /admin/restart/complete",
    ]);
  });

  it("validates a detached repository without relaxing the shared evidence resolver", async () => {
    git(workspace.root, "checkout", "--detach", "HEAD");
    expect(() => resolveWorkspaceRepository(workspace.root)).toThrow("DETACHED_REPOSITORY_UNAVAILABLE");
    expect(prepareRestart(workspace.root).repository.branch).toBeNull();
    await expect(restartWorkspace(workspace.root, services().dependencies)).resolves.toMatchObject({ ok: true });
    expect(() => git(workspace.root, "symbolic-ref", "--quiet", "HEAD")).toThrow();
  });

  it.each(["remote", "root", "installation", "identity", "uuid", "quick", "mode"] as const)(
    "rejects %s contradictions before any lifecycle request", async (fault) => {
      if (fault === "remote") git(workspace.root, "remote", "set-url", "origin", "https://github.com/example/other");
      if (fault === "root") {
        const file = bindingFile(workspace.id);
        writeSecureJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), workspaceId: "other" });
      }
      if (fault === "installation") writeSecureJson(path.join(getStateDir(), "installation.json"), { installationId: "22222222-2222-4222-8222-222222222222" });
      if (fault === "identity") fs.unlinkSync(bindingFile(workspace.id));
      if (fault === "uuid" || fault === "quick") {
        const context = prepareRestart(workspace.root);
        const state = JSON.parse(fs.readFileSync(context.files[2], "utf8"));
        if (fault === "uuid") delete state.tunnelId;
        else state.preference = "quick";
        writeSecureJson(context.files[2], state);
      }
      if (fault === "mode") writeLastEndpoint({ ...readLastEndpoint(workspace.id)!, endpointMode: "ephemeral" });
      const { dependencies, calls } = services();
      await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow();
      expect(dependencies.observe).not.toHaveBeenCalled();
      expect(dependencies.start).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  );

  it("rejects ambiguous detached remotes instead of selecting the saved string", () => {
    git(workspace.root, "remote", "add", "other", "https://github.com/example/other");
    git(workspace.root, "checkout", "--detach", "HEAD");
    expect(() => prepareRestart(workspace.root)).toThrow("AMBIGUOUS_REPOSITORY_REMOTE");
  });

  it("allows a later legitimate commit but rejects a changed HEAD inside an operation", () => {
    const previous = prepareRestart(workspace.root);
    write(workspace.root, "new.txt", "new commit");
    git(workspace.root, "add", "new.txt"); git(workspace.root, "commit", "-m", "advance fixture");
    expect(() => assertRestartUnchanged(previous)).toThrow("RESTART_GIT_CHANGED");
    expect(prepareRestart(workspace.root).repository.identity.head).not.toBe(previous.repository.identity.head);
  });

  it.each([undefined, 0, 2])("sends no shutdown to an unsupported bridge protocol %s", async (protocol) => {
    const { dependencies, calls } = services();
    const original = dependencies.request;
    dependencies.request = async <T>(runtime: RuntimeState, method: "GET" | "POST", route: string): Promise<T> => {
      const value = await original<T>(runtime, method, route);
      if (route === "/admin/info") return { ...value, restartProtocol: protocol };
      return value;
    };
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_PROTOCOL_UNAVAILABLE");
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it.each(["quick", "different-url", "unknown"] as const)("does not stop a live connection that contradicts metadata: %s", async (fault) => {
    const { dependencies, calls } = services();
    const original = dependencies.request;
    dependencies.request = async <T>(runtime: RuntimeState, method: "GET" | "POST", route: string): Promise<T> => {
      const value = await original<T>(runtime, method, route);
      if (route !== "/admin/info") return value;
      const current = value as RestartInfo;
      if (fault === "quick") current.tunnel.provider = "cloudflare-quick";
      if (fault === "different-url") current.publicUrl = "https://different.example.invalid";
      if (fault === "unknown") current.tunnel.running = false;
      return current as T;
    };
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_LIVE_ENDPOINT_MISMATCH");
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it("does not spawn until exit after the shutdown acknowledgment", async () => {
    const { dependencies } = services();
    let release!: () => void;
    let waiting!: () => void;
    const entered = new Promise<void>((resolve) => { waiting = resolve; });
    dependencies.waitForExit = vi.fn(() => { waiting(); return new Promise<void>((resolve) => { release = resolve; }); });
    const restarting = restartWorkspace(workspace.root, dependencies);
    await entered;
    expect(dependencies.start).not.toHaveBeenCalled();
    dependencies.waitForExit = vi.fn(async () => undefined);
    release();
    await restarting;
  });

  it("uses the same exclusion for restart, normal spawn and metadata writers", async () => {
    const { dependencies } = services();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    dependencies.waitForExit = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
    const restarting = restartWorkspace(workspace.root, dependencies);
    await waiting;
    expect(() => ensureBridge(workspace.root)).toThrow("WORKSPACE_BUSY");
    expect(() => writeLastEndpoint(readLastEndpoint(workspace.id)!)).toThrow("WORKSPACE_BUSY");
    expect(() => writeConnectionBinding(prepareRestart(workspace.root).binding)).toThrow("WORKSPACE_BUSY");
    const other = fixture();
    expect(() => writeLastEndpoint(readLastEndpoint(other.id)!)).not.toThrow();
    release();
    await restarting;
  });

  it("preserves identity when candidate start fails", async () => {
    const before = fs.readFileSync(bindingFile(workspace.id));
    const endpoint = fs.readFileSync(endpointFile(workspace.id));
    const { dependencies } = services();
    dependencies.start = vi.fn(async () => { throw new Error("fixture start failure"); });
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_FAILED");
    expect(fs.readFileSync(bindingFile(workspace.id))).toEqual(before);
    expect(fs.readFileSync(endpointFile(workspace.id))).toEqual(endpoint);
  });

  it("does not signal a live PID while waiting for exit", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(waitForBridgeExit({ ...services().old, pid: 55555 }, 1)).rejects.toThrow("RESTART_EXIT_TIMEOUT");
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it("preserves the cleanup-incomplete diagnostic through the restart coordinator", async () => {
    const { dependencies } = services();
    dependencies.start = async () => { throw new Error("RESTART_CANDIDATE_CLEANUP_FAILED"); };
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_CANDIDATE_CLEANUP_FAILED");
  });

  it("restores the prior endpoint after a paused candidate fails completion", async () => {
    const before = fs.readFileSync(endpointFile(workspace.id));
    const { dependencies, calls } = services();
    const request = dependencies.request;
    dependencies.request = async <T>(runtime: RuntimeState, method: "GET" | "POST", route: string): Promise<T> => {
      if (route === "/admin/restart/complete") throw new Error("synthetic completion failure");
      return request<T>(runtime, method, route);
    };
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_FAILED");
    expect(fs.readFileSync(endpointFile(workspace.id))).toEqual(before);
    expect(calls.filter((call) => call === "POST /admin/shutdown?mode=restart")).toHaveLength(2);
    expect(dependencies.waitForExit).toHaveBeenCalledTimes(2);
  });

  it("leaves a completed candidate running when its completion response was lost", async () => {
    const { dependencies, calls } = services();
    const request = dependencies.request;
    dependencies.request = async <T>(runtime: RuntimeState, method: "GET" | "POST", route: string): Promise<T> => {
      const result = await request<T>(runtime, method, route);
      if (route === "/admin/restart/complete") throw new Error("synthetic lost acknowledgment");
      return result;
    };
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_FAILED_CANDIDATE_REMAINS");
    expect(calls.filter((call) => call === "POST /admin/shutdown?mode=restart")).toHaveLength(1);
    expect(readLastEndpoint(workspace.id)?.port).toBe(32172);
  });

  it("keeps original identity when the endpoint cannot be atomically saved", async () => {
    const endpoint = endpointFile(workspace.id), before = fs.readFileSync(endpoint);
    const binding = fs.readFileSync(bindingFile(workspace.id));
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === endpoint) throw new Error("synthetic write failure");
      rename(from, to);
    });
    const { dependencies, calls } = services();
    await expect(restartWorkspace(workspace.root, dependencies)).rejects.toThrow("RESTART_FAILED");
    expect(fs.readFileSync(endpoint)).toEqual(before);
    expect(fs.readFileSync(bindingFile(workspace.id))).toEqual(binding);
    expect(calls.filter((call) => call === "POST /admin/shutdown?mode=restart")).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(endpoint)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reconnects an already stopped bridge with the same binding", async () => {
    const before = fs.readFileSync(bindingFile(workspace.id));
    const { dependencies, calls } = services();
    dependencies.observe = async () => ({ state: "stopped", runtime: null, reason: "runtime_missing" });
    await restartWorkspace(workspace.root, dependencies);
    expect(calls).not.toContain("POST /admin/shutdown?mode=restart");
    expect(fs.readFileSync(bindingFile(workspace.id))).toEqual(before);
  });

  it("does not generate a new installation when the saved identity is missing", () => {
    const file = path.join(getStateDir(), "installation.json");
    expect(getInstallationIdentity().installationId).toBeTruthy();
    fs.unlinkSync(file);
    expect(() => prepareRestart(workspace.root)).toThrow("RESTART_METADATA_UNAVAILABLE");
    expect(fs.existsSync(file)).toBe(false);
  });
});
