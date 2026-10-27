import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { bindingFile, endpointFingerprint, makeConnectionBinding, readConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { endpointFile, readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { writeRuntimeState } from "../src/bridge/runtime.js";
import { writeSecureJson } from "../src/config/paths.js";
import { SERVICE_NAME } from "../src/version.js";

let root: string, state: string, workspace: Workspace;
let server: http.Server;
let publicUrl: string;
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("normal-start-binding");
  makeGitRepo(root); git(root, "remote", "add", "origin", "https://github.com/example/demo");
  workspace = new Workspace(root); publicUrl = "https://fixture.example.invalid";
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.C2C_STATE_DIR;
  cleanup(root); cleanup(state);
});
function saved(mode: "stable" | "ephemeral") {
  const binding = makeConnectionBinding({ workspaceId: workspace.id, workspace: workspace.name,
    workspaceRoot: root, endpoint: publicUrl + "/mcp", endpointMode: mode, connectorName: "saved-connector" });
  writeSecureJson(bindingFile(workspace.id), { ...binding, extension: { keep: true } });
  writeLastEndpoint({ ...binding, port: 1, publicUrl, mcpUrl: publicUrl + "/mcp" });
  return binding;
}
async function runStart() {
  const startedAt = "2026-01-01T00:00:00Z";
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ service: SERVICE_NAME, version: "fixture", status: "ok", workspaceId: workspace.id }));
    } else if (request.url === "/admin/info") {
      response.end(JSON.stringify({ service: SERVICE_NAME, workspaceId: workspace.id, workspaceName: workspace.name,
        workspaceRoot: workspace.root, pid: process.pid, startedAt, publicUrl, tokenCount: 1, pairingActive: false,
        tunnel: { running: true, url: publicUrl, provider: "cloudflare-named" } }));
    } else {
      response.statusCode = 400; response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server missing");
  writeRuntimeState({ service: SERVICE_NAME, version: "fixture", workspaceId: workspace.id, workspaceRoot: workspace.root,
    pid: process.pid, port: address.port, adminToken: "synthetic-only", publicUrl, startedAt });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli/index.ts"), "start", "-w", workspace.root, "--json"], {
      cwd: process.cwd(), env: { ...process.env, C2C_STATE_DIR: state }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

describe("normal CLI start persistence", () => {
  it.each(["stable", "ephemeral"] as const)("inherits %s and optional metadata when URL is unchanged", async (mode) => {
    const binding = saved(mode);
    const completed = await runStart();
    expect(completed.code).toBe(0);
    expect(readConnectionBinding(workspace.id)?.endpointMode).toBe(mode);
    expect(readConnectionBinding(workspace.id)?.endpointFingerprint).toBe(binding.endpointFingerprint);
    expect(JSON.parse(fs.readFileSync(bindingFile(workspace.id), "utf8")).extension).toEqual({ keep: true });
  });

  it.each(["connectorName", "canonicalRepository", "installationId", "endpointFingerprint"] as const)(
    "rejects contradictory %s instead of choosing a record", async (field) => {
      saved("stable");
      const original = fs.readFileSync(bindingFile(workspace.id));
      const endpoint = readLastEndpoint(workspace.id)!;
      writeLastEndpoint({ ...endpoint, [field]: "contradictory" });
      const before = fs.readFileSync(endpointFile(workspace.id));
      const completed = await runStart();
      expect(completed.code).toBe(1);
      expect(completed.output).toContain("CONNECTION_BINDING_MISMATCH");
      expect(fs.readFileSync(bindingFile(workspace.id))).toEqual(original);
      expect(fs.readFileSync(endpointFile(workspace.id))).toEqual(before);
    }
  );

  it("inherits the saved connector when lastEndpoint is absent", async () => {
    saved("stable");
    fs.unlinkSync(endpointFile(workspace.id));
    expect((await runStart()).code).toBe(0);
    expect(readLastEndpoint(workspace.id)?.connectorName).toBe("saved-connector");
    expect(readLastEndpoint(workspace.id)?.endpointMode).toBe("stable");
  });

  it("keeps ephemeral mode while recalculating a legitimately changed URL", async () => {
    saved("ephemeral");
    publicUrl = "https://new-quick.example.invalid";
    expect((await runStart()).code).toBe(0);
    expect(readConnectionBinding(workspace.id)?.endpointMode).toBe("ephemeral");
    expect(readConnectionBinding(workspace.id)?.endpointFingerprint).toBe(endpointFingerprint(publicUrl + "/mcp", "ephemeral"));
  });

  it("retains an explicit authorized mode change in the binding constructor", () => {
    saved("stable");
    const explicit = makeConnectionBinding({ workspaceId: workspace.id, workspace: workspace.name, workspaceRoot: root,
      endpoint: publicUrl + "/mcp", endpointMode: "ephemeral" });
    writeConnectionBinding(explicit);
    expect(readConnectionBinding(workspace.id)?.endpointMode).toBe("ephemeral");
    expect(readConnectionBinding(workspace.id)?.endpointFingerprint).toBe(endpointFingerprint(publicUrl + "/mcp", "ephemeral"));
  });
});
