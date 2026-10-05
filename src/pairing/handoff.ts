import { createHash, randomBytes } from "node:crypto";

export interface PairingHandoffBinding {
  workspaceId: string;
  connectorName: string;
  origin: string;
  scopes: readonly string[];
  installationId?: string;
  resource?: string;
  codeChallenge?: string;
}

export interface PairingAuthorizationBinding {
  requestId: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
  codeChallenge?: string;
}

export interface PairingHandoffIssue {
  expiresAt: number;
}

export type PairingHandoffFailureReason =
  | "not_found"
  | "expired"
  | "already_used"
  | "workspace_mismatch"
  | "connector_mismatch"
  | "installation_mismatch"
  | "origin_mismatch"
  | "scope_mismatch"
  | "resource_mismatch"
  | "code_challenge_mismatch"
  | "authorization_mismatch";

export type PairingHandoffConsumeResult =
  | { ok: true; pairingCode: string }
  | { ok: false; reason: PairingHandoffFailureReason };

interface PendingHandoff {
  tokenHash: string;
  pairingCode: string;
  binding: PairingHandoffBinding;
  authorization?: PairingAuthorizationBinding;
  expiresAt: number;
  used: boolean;
}

interface ConsumeInput extends PairingHandoffBinding {
  token?: string;
  now?: number;
  authorization?: PairingAuthorizationBinding;
}

interface ClaimInput extends PairingHandoffBinding {
  authorization: PairingAuthorizationBinding;
  token?: string;
  now?: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].map((scope) => scope.trim()).filter(Boolean).sort();
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeScopes(left);
  const b = normalizeScopes(right);
  return a.length === b.length && a.every((scope, index) => scope === b[index]);
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

/** Runtime-only handoff. Secret material is memory-only and never exposed by diagnostics. */
export class EphemeralPairingHandoff {
  private readonly pending = new Map<string, PendingHandoff>();

  constructor(private readonly ttlMs = 60_000) {}

  issue(binding: PairingHandoffBinding, pairingCode: string, now = Date.now()): PairingHandoffIssue {
    const origin = normalizeOrigin(binding.origin);
    if (!origin) throw new Error("pairing handoff requires an official HTTPS origin");
    if (!binding.workspaceId || !binding.connectorName || !pairingCode) {
      throw new Error("pairing handoff binding is incomplete");
    }
    this.prune(now);
    this.pending.clear();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = now + this.ttlMs;
    this.pending.set(tokenHash, {
      tokenHash,
      pairingCode,
      binding: {
        workspaceId: binding.workspaceId,
        connectorName: binding.connectorName,
        origin,
        scopes: normalizeScopes(binding.scopes),
        ...(binding.installationId ? { installationId: binding.installationId } : {}),
        ...(binding.resource ? { resource: binding.resource.trim().replace(/\/+$/u, "").toLowerCase() } : {}),
        ...(binding.codeChallenge ? { codeChallenge: binding.codeChallenge } : {}),
      },
      expiresAt,
      used: false,
    });
    return { expiresAt };
  }

  consume(input: ConsumeInput): PairingHandoffConsumeResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const entries = [...this.pending.values()];
    const candidate = input.token ? this.pending.get(hashToken(input.token)) : entries[0];
    if (!candidate) return { ok: false, reason: "not_found" };
    if (candidate.used) return { ok: false, reason: "already_used" };
    if (now > candidate.expiresAt) {
      this.pending.delete(candidate.tokenHash);
      return { ok: false, reason: "expired" };
    }
    if (candidate.binding.workspaceId !== input.workspaceId) return { ok: false, reason: "workspace_mismatch" };
    if (candidate.binding.connectorName !== input.connectorName) return { ok: false, reason: "connector_mismatch" };
    if (candidate.binding.installationId !== undefined && candidate.binding.installationId !== input.installationId) {
      return { ok: false, reason: "installation_mismatch" };
    }
    if (candidate.binding.origin !== normalizeOrigin(input.origin)) return { ok: false, reason: "origin_mismatch" };
    if (!sameScopes(candidate.binding.scopes, input.scopes)) return { ok: false, reason: "scope_mismatch" };
    if (!sameOptional(candidate.binding.resource, input.resource?.trim().replace(/\/+$/u, "").toLowerCase())) {
      return { ok: false, reason: "resource_mismatch" };
    }
    if (!sameOptional(candidate.binding.codeChallenge, input.codeChallenge)) {
      return { ok: false, reason: "code_challenge_mismatch" };
    }
    if (candidate.authorization && !sameAuthorization(candidate.authorization, input.authorization)) {
      return { ok: false, reason: "authorization_mismatch" };
    }
    if (input.authorization && !candidate.authorization) return { ok: false, reason: "authorization_mismatch" };
    candidate.used = true;
    this.pending.delete(candidate.tokenHash);
    const pairingCode = candidate.pairingCode;
    candidate.pairingCode = "";
    return { ok: true, pairingCode };
  }

  claim(input: ClaimInput): { ok: true } | { ok: false; reason: PairingHandoffFailureReason } {
    const now = input.now ?? Date.now();
    this.prune(now);
    const entries = [...this.pending.values()];
    const candidate = input.token ? this.pending.get(hashToken(input.token)) : entries[0];
    if (!candidate) return { ok: false, reason: "not_found" };
    if (candidate.used) return { ok: false, reason: "already_used" };
    if (now > candidate.expiresAt) {
      this.pending.delete(candidate.tokenHash);
      return { ok: false, reason: "expired" };
    }
    if (candidate.binding.workspaceId !== input.workspaceId) return { ok: false, reason: "workspace_mismatch" };
    if (candidate.binding.connectorName !== input.connectorName) return { ok: false, reason: "connector_mismatch" };
    if (candidate.binding.installationId !== undefined && candidate.binding.installationId !== input.installationId) {
      return { ok: false, reason: "installation_mismatch" };
    }
    if (candidate.binding.origin !== normalizeOrigin(input.origin)) return { ok: false, reason: "origin_mismatch" };
    if (!sameScopes(candidate.binding.scopes, input.scopes)) return { ok: false, reason: "scope_mismatch" };
    if (!sameOptional(candidate.binding.resource, input.resource?.trim().replace(/\/+$/u, "").toLowerCase())) {
      return { ok: false, reason: "resource_mismatch" };
    }
    if (!sameOptional(candidate.binding.codeChallenge, input.codeChallenge)) {
      return { ok: false, reason: "code_challenge_mismatch" };
    }
    if (candidate.authorization && !sameAuthorization(candidate.authorization, input.authorization)) {
      return { ok: false, reason: "authorization_mismatch" };
    }
    candidate.authorization = { ...input.authorization };
    return { ok: true };
  }

  hasPending(now = Date.now()): boolean {
    this.prune(now);
    return this.pending.size > 0;
  }

  inspect(now = Date.now()): { count: number; expiresAt: number | null } {
    this.prune(now);
    const first = this.pending.values().next().value as PendingHandoff | undefined;
    return { count: this.pending.size, expiresAt: first?.expiresAt ?? null };
  }

  private prune(now: number): void {
    for (const [key, item] of this.pending) {
      if (item.used || now > item.expiresAt) this.pending.delete(key);
    }
  }
}

function sameAuthorization(left: PairingAuthorizationBinding | undefined, right: PairingAuthorizationBinding | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.requestId === right.requestId &&
      left.clientId === right.clientId &&
      left.redirectUri === right.redirectUri &&
      sameOptional(left.resource, right.resource) &&
      sameOptional(left.codeChallenge, right.codeChallenge)
  );
}

export function normalizePairingHandoffOrigin(origin: string): string | null {
  return normalizeOrigin(origin);
}
