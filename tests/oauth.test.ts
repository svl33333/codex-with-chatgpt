import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { filterScopes } from "../src/auth/store.js";
import type { TunnelProvider, TunnelStatus, TunnelDoctorReport } from "../src/tunnel/provider.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

class FakePublicTunnel implements TunnelProvider {
  readonly name = "fake-public";
  private url: string | null = null;

  async start(_localPort: number): Promise<string> {
    this.url = "https://runtime-handoff.example.test";
    return this.url;
  }

  async stop(): Promise<void> {
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return { provider: this.name, binaryFound: true, binaryPath: "test", running: this.url !== null, url: this.url, problems: [] };
  }
}

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string | undefined,
  state = "st-123",
  scope: string | null = "workspace.read workspace.search git.read execution.read offline_access"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (scope !== null) authorizeUrl.searchParams.set("scope", scope);

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  // Test the production request-bound flow: the pairing session is minted only
  // after the OAuth request is visible and carries the exact request binding.
  const effectiveScopes = filterScopes(scope === null ? undefined : scope);
  const boundPairing = bridge.pairing.create({
    workspaceId: bridge.workspace.id,
    connectorId: bridge.workspace.id,
    installationId: bridge.workspace.id,
    endpointOrigin: base,
    requestId,
    clientId,
    redirectUri: REDIRECT_URI,
    resource: `${base}/mcp`,
    codeChallenge: challenge,
    scopes: effectiveScopes,
  });

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode ?? boundPairing.code }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const { code, location } = await authorizeWithPairing(clientId, challenge, undefined);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");
    expect(bridge.authStore.verifyAccessToken(token.body.access_token, `${base}/mcp`).ok).toBe(true);
    expect(bridge.authStore.verifyAccessToken(token.body.access_token, "https://wrong.example/mcp").ok).toBe(false);

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("binds the automatic pairing mint to the pending OAuth request", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read git.read offline_access");
    const page = await fetch(authorizeUrl, { redirect: "manual" });
    expect(page.status).toBe(200);
    const pairingResponse = await fetch(`${base}/admin/pairing`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(pairingResponse.status).toBe(200);
    const pairing = (await pairingResponse.json()) as { code: string };
    const requestId = (await page.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();
    const post = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }),
      redirect: "manual",
    });
    expect(post.status).toBe(302);
    const code = new URL(post.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    expect((await exchangeToken(clientId, code!, verifier)).status).toBe(200);
  });

  it("claims the exact request before consuming a runtime-only handoff", async () => {
    const runtimeRoot = makeTmpDir("oauth-runtime-handoff");
    const runtimeBridge = await startBridge({
      workspaceRoot: runtimeRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-runtime-handoff"), "store.json"),
      tunnelProvider: new FakePublicTunnel(),
      connectorBinding: { connectorId: "connector-runtime", installationId: "installation-runtime" },
      pairingStrategy: "runtime_handoff",
    });

    try {
      const runtimeBase = runtimeBridge.localBaseUrl();
      const tunnelStart = await fetch(`${runtimeBase}/admin/tunnel/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeBridge.adminToken}` },
      });
      expect(tunnelStart.status).toBe(200);
      const registration = await fetch(`${runtimeBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Runtime-Handoff-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const clientId = ((await registration.json()) as { client_id: string }).client_id;
      const { challenge } = pkceVerifierAndChallenge();
      const authorizeUrl = new URL(`${runtimeBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("scope", "workspace.read git.read offline_access");
      const page = await fetch(authorizeUrl, { redirect: "manual" });
      expect(page.status).toBe(200);
      const requestId = (await page.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
      expect(requestId).toBeTruthy();

      const pairingResponse = await fetch(`${runtimeBase}/admin/pairing`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeBridge.adminToken}` },
      });
      expect(pairingResponse.status).toBe(200);
      expect((await pairingResponse.json()) as { code: string | null }).toMatchObject({ code: null, pairingStrategy: "runtime_handoff" });

      const post = await fetch(`${runtimeBase}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId! }),
        redirect: "manual",
      });
      expect(post.status).toBe(302);
      expect(new URL(post.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    } finally {
      await runtimeBridge.close();
      cleanup(runtimeRoot);
    }
  });

  it("rejects an explicitly unsupported scope instead of expanding it", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "scope-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read write.access");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_scope");
  });

  it("rejects a resource target that is not this MCP server", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "resource-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", "https://wrong.example/mcp");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_target");
  });

  it("does not implicitly grant offline access when scope is omitted", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const { code } = await authorizeWithPairing(clientId, challenge, undefined, "no-offline", null);
    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.scope).not.toContain("offline_access");
    expect(token.body.refresh_token).toBeUndefined();
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoot: xssWorkspaceRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const { code } = await authorizeWithPairing(clientId, challenge, undefined);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const { code } = await authorizeWithPairing(clientId, challenge, undefined);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
      resource: `${base}/mcp`,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("401 for a legacy token without an audience/resource binding", async () => {
    const legacy = bridge.authStore.issueTokens({ clientId: "legacy", scopes: ["workspace.read"] });
    expect((await mcpCall(legacy.accessToken)).status).toBe(401);
  });

  it("403 with a token bound to another workspace", async () => {
    const foreign = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      workspaceId: "deadbeef0000",
      resource: `${base}/mcp`,
    });
    const response = await mcpCall(foreign.accessToken);
    expect(response.status).toBe(403);
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"], resource: `${base}/mcp` });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const { code } = await authorizeWithPairing(clientId, challenge, undefined);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });

  it("rejects a legacy unbound refresh token and requires reauthorization", async () => {
    const legacy = bridge.authStore.issueTokens({ clientId: "legacy-refresh", scopes: ["workspace.read", "offline_access"] });
    const response = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: legacy.refreshToken!,
        client_id: "legacy-refresh",
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
  });
});
