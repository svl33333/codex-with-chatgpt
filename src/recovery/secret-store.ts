export type ProtectedSecretFailure = "protected_secret_unavailable" | "ambiguous_ownership";

export interface ProtectedSecretHandle {
  /** Opaque in-process handle; callers must not serialize or log it. */
  readonly ref: string;
  readonly consume: () => Promise<string>;
}

export interface ProtectedSecretStore {
  readonly name: string;
  readonly consumption: "in_process" | "unsupported";
  resolve(ref: string): Promise<ProtectedSecretHandle>;
  inspect(): Promise<{ available: boolean; provider: string; mechanism: string; reason?: string }>;
  /** Verify that this opaque reference belongs to this exact store. */
  verifyReference?(ref: string): Promise<boolean>;
  /** Release P0-2-owned material; implementations must treat an already
   * absent reference as successful so uninstall can safely retry. */
  releaseOwned?(ref: string): Promise<void>;
}

export class ProtectedSecretError extends Error {
  constructor(
    public readonly status: ProtectedSecretFailure,
    message: string,
  ) {
    super(message);
    this.name = "ProtectedSecretError";
  }
}

/** A safe default on hosts where no supported OS credential API is wired. */
export class UnsupportedProtectedSecretStore implements ProtectedSecretStore {
  readonly name = "unavailable";
  readonly consumption = "unsupported" as const;

  async resolve(_ref: string): Promise<ProtectedSecretHandle> {
    throw new ProtectedSecretError(
      "protected_secret_unavailable",
      "No supported in-process protected-secret store is available",
    );
  }

  async inspect(): Promise<{ available: false; provider: string; mechanism: string; reason: string }> {
    return {
      available: false,
      provider: this.name,
      mechanism: "none",
      reason: "Windows Credential Manager/DPAPI integration is not installed for this runtime",
    };
  }

  async verifyReference(_ref: string): Promise<boolean> {
    return false;
  }
}

/**
 * Test/injected store. The value never leaves the supplied handle and is not
 * serializable by the recovery APIs. Production callers must use an OS-backed
 * implementation instead.
 */
export class InMemoryProtectedSecretStore implements ProtectedSecretStore {
  readonly name = "in-memory-test";
  readonly consumption = "in_process" as const;
  readonly releasedRefs = new Set<string>();

  constructor(private readonly values: ReadonlyMap<string, string>) {}

  async resolve(ref: string): Promise<ProtectedSecretHandle> {
    if (this.releasedRefs.has(ref)) {
      throw new ProtectedSecretError("protected_secret_unavailable", "protected secret reference was released");
    }
    const value = this.values.get(ref);
    if (typeof value !== "string" || value.length === 0) {
      throw new ProtectedSecretError("protected_secret_unavailable", "protected secret reference is unavailable");
    }
    return {
      ref,
      consume: async () => value,
    };
  }

  async inspect(): Promise<{ available: true; provider: string; mechanism: string }> {
    return { available: true, provider: this.name, mechanism: "in-process test handle" };
  }

  async verifyReference(ref: string): Promise<boolean> {
    return this.values.has(ref) && !this.releasedRefs.has(ref);
  }

  async releaseOwned(ref: string): Promise<void> {
    if (!this.values.has(ref)) throw new ProtectedSecretError("protected_secret_unavailable", "owned protected secret reference is unavailable");
    this.releasedRefs.add(ref);
  }
}

export function assertOpaqueSecretRef(ref: string): void {
  // References are deliberately constrained so a caller cannot smuggle a
  // path, command line, or bearer value into the protected store boundary.
  if (!/^binding:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(ref)) {
    throw new ProtectedSecretError("ambiguous_ownership", "protected secret reference is not binding-scoped");
  }
}
