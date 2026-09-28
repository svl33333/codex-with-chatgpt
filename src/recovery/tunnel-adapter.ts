import type { ProtectedSecretHandle } from "./secret-store.js";

export interface SecureTunnelReconcileRequest {
  localPort: number;
  localEndpoint: string;
  profileRef: string;
  secret: ProtectedSecretHandle;
}

export interface SecureTunnelObservation {
  running: boolean;
  url: string | null;
  profileRef: string;
  provider: string;
  /** Authoritative local target observed by the supported client. */
  localEndpoint: string | null;
}

export interface SecureTunnelAdapter {
  readonly name: string;
  readonly consumption: "in_process" | "unsupported";
  inspect(): Promise<{
    available: boolean;
    provider: string;
    clientVersion: string | null;
    mechanism: string;
    reason?: string;
  }>;
  /** Verify that this profile reference belongs to this exact adapter/account. */
  verifyProfile?(profileRef: string): Promise<boolean>;
  reconcile(request: SecureTunnelReconcileRequest): Promise<SecureTunnelObservation>;
  observe(profileRef: string): Promise<SecureTunnelObservation>;
}

export class SecureTunnelCapabilityError extends Error {
  constructor(
    public readonly status: "unsupported_tunnel_capability" | "protected_secret_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SecureTunnelCapabilityError";
  }
}

/**
 * Deliberately fail-closed adapter used until the installed Secure MCP Tunnel
 * client exposes a supported in-process target update contract.
 */
export class UnsupportedSecureTunnelAdapter implements SecureTunnelAdapter {
  readonly name = "unavailable";
  readonly consumption = "unsupported" as const;

  async inspect(): Promise<{
    available: false;
    provider: string;
    clientVersion: null;
    mechanism: string;
    reason: string;
  }> {
    return {
      available: false,
      provider: this.name,
      clientVersion: null,
      mechanism: "none",
      reason: "installed Secure MCP Tunnel client has no verified in-process adapter",
    };
  }

  async reconcile(_request: SecureTunnelReconcileRequest): Promise<SecureTunnelObservation> {
    throw new SecureTunnelCapabilityError(
      "unsupported_tunnel_capability",
      "Secure MCP Tunnel recovery adapter is unavailable",
    );
  }

  async verifyProfile(_profileRef: string): Promise<boolean> {
    return false;
  }

  async observe(profileRef: string): Promise<SecureTunnelObservation> {
    return { running: false, url: null, profileRef, provider: this.name, localEndpoint: null };
  }
}

/** Small injected adapter for deterministic recovery tests. */
export class InProcessTestTunnelAdapter implements SecureTunnelAdapter {
  readonly name = "in-process-test";
  readonly consumption = "in_process" as const;
  private current: SecureTunnelObservation;

  constructor(
    private readonly expectedProfile: string,
    url: string | null = null,
    localEndpoint: string | null = null,
  ) {
    this.current = { running: url !== null, url, profileRef: expectedProfile, provider: this.name, localEndpoint };
  }

  async inspect(): Promise<{ available: true; provider: string; clientVersion: string; mechanism: string }> {
    return { available: true, provider: this.name, clientVersion: "test", mechanism: "in-process handle" };
  }

  async reconcile(request: SecureTunnelReconcileRequest): Promise<SecureTunnelObservation> {
    if (request.profileRef !== this.expectedProfile) {
      throw new SecureTunnelCapabilityError("unsupported_tunnel_capability", "tunnel profile ownership mismatch");
    }
    // Consume only inside this adapter; the caller never receives the value.
    const secret = await request.secret.consume();
    if (!secret) throw new SecureTunnelCapabilityError("protected_secret_unavailable", "empty protected secret");
    this.current = {
      running: true,
      url: this.current.url ?? `https://test.invalid/${request.localPort}`,
      profileRef: request.profileRef,
      provider: this.name,
      localEndpoint: request.localEndpoint,
    };
    return this.current;
  }

  async verifyProfile(profileRef: string): Promise<boolean> {
    return profileRef === this.expectedProfile;
  }

  async observe(profileRef: string): Promise<SecureTunnelObservation> {
    if (profileRef !== this.expectedProfile) {
      return { running: false, url: null, profileRef, provider: this.name, localEndpoint: null };
    }
    return this.current;
  }
}
