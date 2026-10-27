import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir, pkceVerifierAndChallenge } from "./helpers.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";

let bridge: Bridge;
let failStop = false;
let stopCalls = 0;
let directories: string[] = [];
const publicUrl = "https://restart-auth.example.invalid";

async function createBridge(candidate = false) {
  let running = false;
  const tunnel: TunnelProvider = {
    name: "cloudflare-named",
    start: async () => { running = true; return publicUrl; },
    stop: async () => { stopCalls++; if (failStop) throw new Error("synthetic stop failure"); running = false; },
    restart: async () => publicUrl,
    status: () => ({ running, provider: "cloudflare-named", url: running ? publicUrl : null }),
    getPublicUrl: () => running ? publicUrl : null,
    doctor: async () => ({ provider: "cloudflare-named", binaryFound: true, binaryPath: "synthetic", running, url: publicUrl, problems: [] }),
  };
  const root = makeTmpDir("restart-auth"); directories.push(root);
  bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel, restartCandidate: candidate, onShutdown: () => undefined });
  return bridge;
}

async function admin(route: string, method = "POST") {
  return fetch(bridge.localBaseUrl() + route, { method, headers: { Authorization: "Bearer " + bridge.adminToken } });
}
async function info() {
  const response = await admin("/admin/info", "GET");
  const value = await response.json() as { authorizationPaused: boolean; restartProtocol: number };
  return value;
}
async function authorize() {
  const client = bridge.authStore.registerClient({ redirectUris: ["https://client.example.invalid/callback"] });
  const pkce = pkceVerifierAndChallenge();
  const query = new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: "code",
    code_challenge: pkce.challenge, code_challenge_method: "S256", scope: "workspace.read offline_access",
  });
  const response = await fetch(bridge.localBaseUrl() + "/oauth/authorize?" + query);
  const page = await response.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(page)?.[1];
  if (!requestId) throw new Error("Synthetic authorization request missing");
  return { client, pkce, requestId };
}

beforeEach(() => {
  directories = [isolateStateDir()];
  failStop = false; stopCalls = 0;
});
afterEach(async () => {
  failStop = false;
  await bridge?.close();
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const directory of directories) cleanup(directory);
});

describe("restart admission protects existing OAuth flows", () => {
  it("rejects an outstanding authorization request without consuming it", async () => {
    await createBridge();
    const pending = await authorize();
    const file = path.join(getStateDir(), "auth", bridge.workspace.id + ".json");
    const before = fs.readFileSync(file);
    const rejected = await admin("/admin/shutdown?mode=restart");
    expect(rejected.status).toBe(409); await rejected.text();
    expect((await info()).authorizationPaused).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
    const pairing = await admin("/admin/pairing");
    expect(pairing.status).toBe(200);
    const paired = await pairing.json() as { code: string };
    const issued = await fetch(bridge.localBaseUrl() + "/oauth/authorize", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: pending.requestId, pairing_code: paired.code }),
    });
    expect(issued.status).toBe(302); await issued.text();
    expect(stopCalls).toBe(0);
  });

  it("rejects after successful pairing until the authorization code has been exchanged", async () => {
    await createBridge();
    const pending = await authorize();
    const pairing = await (await admin("/admin/pairing")).json() as { code: string };
    const issued = await fetch(bridge.localBaseUrl() + "/oauth/authorize", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: pending.requestId, pairing_code: pairing.code }),
    });
    const location = issued.headers.get("location");
    await issued.text();
    if (!location) throw new Error("Synthetic code redirect missing");
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    expect(bridge.authStore.hasPendingAuthorizationCode()).toBe(true);
    const rejected = await admin("/admin/shutdown?mode=restart");
    expect(rejected.status).toBe(409); await rejected.text();
    const token = await fetch(bridge.localBaseUrl() + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(location).searchParams.get("code")!,
        client_id: pending.client.clientId, redirect_uri: pending.client.redirectUris[0], code_verifier: pending.pkce.verifier }),
    });
    expect(token.status).toBe(200);
    const granted = await token.json() as { scope: string };
    expect(granted.scope).toBe("workspace.read offline_access");
    expect(bridge.authStore.hasPendingAuthorizationCode()).toBe(false);
    const accepted = await admin("/admin/shutdown?mode=restart");
    expect(accepted.status).toBe(200); await accepted.text();
  });

  it("checks the bridge state again when pairing begins after a client precheck", async () => {
    await createBridge();
    expect((await info()).restartProtocol).toBe(1);
    const pending = await authorize();
    const pairing = await admin("/admin/pairing");
    await pairing.text();
    expect(pending.requestId.length > 0).toBe(true);
    const response = await admin("/admin/shutdown?mode=restart");
    expect(response.status).toBe(409); await response.text();
    expect(stopCalls).toBe(0);
  });

  it("holds candidate registration, authorize and pairing until commit", async () => {
    await createBridge(true);
    expect((await info()).authorizationPaused).toBe(true);
    for (const [route, method] of [["/oauth/register", "POST"], ["/oauth/authorize", "GET"], ["/admin/pairing", "POST"]]) {
      const response = route.startsWith("/admin") ? await admin(route, method) :
        await fetch(bridge.localBaseUrl() + route, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status).toBe(503); await response.text();
    }
    const complete = await admin("/admin/restart/complete");
    expect(complete.status).toBe(200); await complete.text();
    expect((await info()).authorizationPaused).toBe(false);
    const response = await fetch(bridge.localBaseUrl() + "/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.invalid/callback"] }),
    });
    expect(response.status).toBe(201); await response.text();
  });

  it("reopens admission if an owned Tunnel cannot stop", async () => {
    await createBridge();
    failStop = true;
    const response = await admin("/admin/shutdown?mode=restart");
    expect(response.status).toBe(200); await response.text();
    await vi.waitFor(async () => {
      expect(stopCalls).toBe(1);
      expect((await info()).authorizationPaused).toBe(false);
    });
    expect(fs.existsSync(path.join(getStateDir(), "runtime", bridge.workspace.id + ".json"))).toBe(true);
  });

  it("returns a failed stop response while retaining bridge health and runtime metadata", async () => {
    await createBridge();
    await (await admin("/admin/tunnel/start")).text();
    const file = path.join(getStateDir(), "runtime", bridge.workspace.id + ".json");
    const before = fs.readFileSync(file);
    failStop = true;
    const response = await admin("/admin/tunnel/stop");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "tunnel_stop_failed", message: "Tunnel stop failed" });
    expect((await fetch(bridge.localBaseUrl() + "/health")).status).toBe(200);
    expect(bridge.getPublicBaseUrl()).toBe(publicUrl);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("ignores expired codes without consuming a live code or changing grants", async () => {
    await createBridge();
    const now = Date.now();
    bridge.authStore.createAuthorizationCode({
      clientId: "synthetic", redirectUri: "https://client.example.invalid/callback", codeChallenge: "synthetic",
      scopes: ["workspace.read"], pairingSessionId: "synthetic",
    });
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    expect(bridge.authStore.hasPendingAuthorizationCode()).toBe(false);
    const response = await admin("/admin/shutdown?mode=restart");
    expect(response.status).toBe(200); await response.text();
  });
});
