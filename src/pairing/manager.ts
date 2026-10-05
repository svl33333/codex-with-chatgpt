import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PairingCode: a short-lived, one-time, local verification credential shown
 * on the authorization page. This is NOT an OAuth Authorization Code.
 */
export interface PairingSession {
  id: string;
  codeHash: Buffer;
  workspaceId: string;
  binding?: PairingRequestBinding;
  createdAt: number;
  expiresAt: number;
  attemptsLeft: number;
  used: boolean;
}

/** Exact OAuth and connector context allowed to consume a pairing session. */
export interface PairingRequestBinding {
  workspaceId: string;
  connectorId: string;
  installationId: string;
  endpointOrigin: string;
  requestId: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  scopes: readonly string[];
}

export interface PairingVerifyOk {
  ok: true;
  sessionId: string;
}

export interface PairingVerifyFail {
  ok: false;
  reason:
    | "invalid"
    | "expired"
    | "too_many_attempts"
    | "rate_limited"
    | "no_active_session"
    | "binding_mismatch";
  attemptsLeft?: number;
}

export type PairingVerifyResult = PairingVerifyOk | PairingVerifyFail;

// No ambiguous characters (I, L, O, 0, 1).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(length = 8): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // rejection sampling for uniformity
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
        chars.push(ALPHABET[byte % ALPHABET.length]);
        if (chars.length === length) break;
      }
    }
  }
  return chars.join("");
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

function normalizeBinding(binding: PairingRequestBinding): PairingRequestBinding {
  return {
    workspaceId: binding.workspaceId.trim(),
    connectorId: binding.connectorId.trim(),
    installationId: binding.installationId.trim(),
    endpointOrigin: binding.endpointOrigin.trim().replace(/\/+$/u, "").toLowerCase(),
    requestId: binding.requestId.trim(),
    clientId: binding.clientId.trim(),
    redirectUri: binding.redirectUri.trim(),
    resource: binding.resource.trim().replace(/\/+$/u, "").toLowerCase(),
    codeChallenge: binding.codeChallenge.trim(),
    scopes: [...new Set(binding.scopes.map((scope) => scope.trim()).filter(Boolean))].sort(),
  };
}

function bindingsMatch(left: PairingRequestBinding, right: PairingRequestBinding): boolean {
  const normalizedLeft = normalizeBinding(left);
  const normalizedRight = normalizeBinding(right);
  return (
    normalizedLeft.workspaceId === normalizedRight.workspaceId &&
    normalizedLeft.connectorId === normalizedRight.connectorId &&
    normalizedLeft.installationId === normalizedRight.installationId &&
    normalizedLeft.endpointOrigin === normalizedRight.endpointOrigin &&
    normalizedLeft.requestId === normalizedRight.requestId &&
    normalizedLeft.clientId === normalizedRight.clientId &&
    normalizedLeft.redirectUri === normalizedRight.redirectUri &&
    normalizedLeft.resource === normalizedRight.resource &&
    normalizedLeft.codeChallenge === normalizedRight.codeChallenge &&
    normalizedLeft.scopes.length === normalizedRight.scopes.length &&
    normalizedLeft.scopes.every((scope, index) => scope === normalizedRight.scopes[index])
  );
}

export function isPairingRequestBinding(value: unknown): value is PairingRequestBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    [
      "workspaceId",
      "connectorId",
      "installationId",
      "endpointOrigin",
      "requestId",
      "clientId",
      "redirectUri",
      "resource",
      "codeChallenge",
    ].every((key) => typeof candidate[key] === "string" && Boolean((candidate[key] as string).trim())) &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string" && Boolean(scope.trim()))
  );
}

export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  ipRateLimit?: number;
  ipRateWindowMs?: number;
}

export class PairingManager {
  private sessions = new Map<string, PairingSession>();
  private ipHits = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly ipRateLimit: number;
  private readonly ipRateWindowMs: number;

  constructor(
    private readonly workspaceId: string,
    opts: PairingManagerOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.ipRateLimit = opts.ipRateLimit ?? 10;
    this.ipRateWindowMs = opts.ipRateWindowMs ?? 60_000;
  }

  /** Create a new pairing session. Invalidates previous sessions (one active at a time). */
  create(binding?: PairingRequestBinding): { sessionId: string; code: string; expiresAt: number } {
    this.sessions.clear();
    const normalizedBinding = binding ? normalizeBinding(binding) : undefined;
    if (normalizedBinding && normalizedBinding.workspaceId !== this.workspaceId) {
      throw new Error("pairing binding workspace mismatch");
    }
    const raw = generateCode();
    const session: PairingSession = {
      id: randomBytes(16).toString("hex"),
      codeHash: hashCode(raw),
      workspaceId: this.workspaceId,
      ...(normalizedBinding ? { binding: normalizedBinding } : {}),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      attemptsLeft: this.maxAttempts,
      used: false,
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, code: formatPairingCode(raw), expiresAt: session.expiresAt };
  }

  private checkIpRate(ip: string | undefined): boolean {
    if (!ip) return true;
    const now = Date.now();
    const entry = this.ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      this.ipHits.set(ip, { count: 1, resetAt: now + this.ipRateWindowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.ipRateLimit;
  }

  verify(codeInput: string, ip?: string, expectedBinding?: PairingRequestBinding): PairingVerifyResult {
    if (!this.checkIpRate(ip)) {
      return { ok: false, reason: "rate_limited" };
    }
    const normalized = normalizePairingCode(codeInput);
    const inputHash = hashCode(normalized);
    const now = Date.now();

    const active = [...this.sessions.values()].filter((s) => !s.used);
    if (active.length === 0) return { ok: false, reason: "no_active_session" };
    // A request-bound verification may inspect only its exact session. A
    // different request must not spend attempts on another session, and a
    // legacy/unbound session is never sufficient for an exact request.
    const candidates = expectedBinding
      ? active.filter((session) => session.binding && bindingsMatch(session.binding, expectedBinding))
      : active;
    if (expectedBinding && candidates.length === 0) return { ok: false, reason: "binding_mismatch" };

    for (const session of candidates) {
      if (now > session.expiresAt) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "expired" };
      }
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "too_many_attempts" };
      }
      const match = timingSafeEqual(inputHash, session.codeHash);
      if (match) {
        // Legacy compatibility sessions were minted before the OAuth request
        // was visible. Bound sessions must match every request/connector field;
        // a mismatch is fail-closed and deliberately does not consume or
        // decrement the unrelated session.
        if (session.binding && (!expectedBinding || !bindingsMatch(session.binding, expectedBinding))) {
          return { ok: false, reason: "binding_mismatch" };
        }
        // one-time use: destroy immediately
        session.used = true;
        this.sessions.delete(session.id);
        return { ok: true, sessionId: session.id };
      }
      session.attemptsLeft--;
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "invalid", attemptsLeft: session.attemptsLeft };
    }
    return { ok: false, reason: "no_active_session" };
  }

  /** Verify against one exact pending OAuth request without consuming on mismatch. */
  verifyForRequest(
    codeInput: string,
    binding: PairingRequestBinding,
    ip?: string
  ): PairingVerifyResult {
    return this.verify(codeInput, ip, binding);
  }

  hasActiveSession(): boolean {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.used && now <= session.expiresAt) return true;
    }
    return false;
  }

  invalidateAll(): void {
    this.sessions.clear();
  }
}
