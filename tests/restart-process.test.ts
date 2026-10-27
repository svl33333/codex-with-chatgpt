import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { AuthStore } from "../src/auth/store.js";
import { bindingFile, makeConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { readRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { adminFetch } from "../src/process/daemon.js";
import { restartWorkspace, waitForBridgeExit } from "../src/connection/restart.js";

let directories: string[], children: ChildProcess[], tunnelPids: number[], state: string;
const publicUrl = "https://process-restart.example.invalid";
beforeEach(() => { directories = []; children = []; tunnelPids = []; state = isolateStateDir(); directories.push(state); });
afterEach(async () => {
  // These handles belong exclusively to this fixture; no state-file PID is signalled.
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.send({ shutdown: true }); await exited;
  }));
  delete process.env.C2C_STATE_DIR;
  for (const directory of directories) cleanup(directory);
});
function workspace() {
  const root = makeTmpDir("restart-process"); directories.push(root); makeGitRepo(root);
  git(root, "remote", "add", "origin", "https://github.com/example/restart-process");
  const ws = new Workspace(root);
  const binding = makeConnectionBinding({ workspaceId: ws.id, workspace: ws.name, workspaceRoot: ws.root,
    endpoint: publicUrl + "/mcp", endpointMode: "stable" });
  writeConnectionBinding(binding);
  writeLastEndpoint({ ...binding, publicUrl, mcpUrl: publicUrl + "/mcp", port: 32171 });
  writeTunnelState({ workspaceId: ws.id, preference: "named", provider: "cloudflare-named",
    tunnelId: "11111111-1111-4111-8111-111111111111", tunnelName: "synthetic-only",
    hostname: "process-restart.example.invalid", zone: "example.invalid", selectionSource: "workspace", askedAt: "fixture" });
  return ws;
}
async function start(ws: Workspace, candidate = false): Promise<RuntimeState> {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/restart-bridge.ts", ws.root, publicUrl, String(candidate)],
    { cwd: process.cwd(), env: { ...process.env, C2C_STATE_DIR: state }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic bridge readiness timed out")), 15_000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Synthetic bridge exited before readiness")); });
    child.on("message", (message: { ready?: boolean; tunnelPid?: number }) => {
      if (message.tunnelPid) tunnelPids.push(message.tunnelPid);
      if (message.ready) { clearTimeout(timer); resolve(); }
    });
  });
  const runtime = readRuntimeState(ws.id)!;
  if (runtime.pid !== child.pid) throw new Error("Synthetic bridge identity mismatch");
  return runtime;
}
async function read(runtime: RuntimeState, token: string) {
  const client = new Client({ name: "restart-fixture", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer " + token } } }));
    expect((await client.listTools()).tools.some((tool) => tool.name === "read_file")).toBe(true);
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Hello from Codex") })]));
  } finally { await client.close(); }
}
it("reconnects MCP with unchanged credentials after bridge and owned child exit, while another workspace stays live", async () => {
  const first = workspace(), second = workspace();
  const store = new AuthStore(first.id);
  store.registerClient({ redirectUris: ["https://fixture.example.invalid/callback"] });
  const tokens = store.issueTokens({ clientId: "synthetic-client", scopes: ["workspace.read", "offline_access"], resource: publicUrl + "/mcp" });
  const authFile = path.join(state, "auth", first.id + ".json");
  const authBefore = fs.readFileSync(authFile), bindingBefore = fs.readFileSync(bindingFile(first.id));
  const original = await start(first), other = await start(second);
  await adminFetch(original, "POST", "/admin/tunnel/start");
  await adminFetch(other, "POST", "/admin/tunnel/start");
  await read(original, tokens.accessToken);
  const oldTunnel = tunnelPids[0];
  await restartWorkspace(first.root, { start: async () => ({ runtime: await start(first, true), spawned: true }) });
  expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
  expect(() => process.kill(oldTunnel, 0)).toThrow();
  const current = readRuntimeState(first.id)!;
  expect(current.pid).not.toBe(original.pid);
  await read(current, tokens.accessToken);
  expect(fs.readFileSync(authFile)).toEqual(authBefore);
  expect(fs.readFileSync(bindingFile(first.id))).toEqual(bindingBefore);
  expect(readRuntimeState(second.id)?.pid).toBe(other.pid);
  expect((await adminFetch<{ workspaceId: string }>(other, "GET", "/admin/info")).workspaceId).toBe(second.id);
  for (const runtime of [current, other]) {
    await adminFetch(runtime, "POST", "/admin/shutdown?mode=restart");
    await waitForBridgeExit(runtime);
  }
}, 30_000);
