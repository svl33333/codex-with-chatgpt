# P0-2 Implementation Plan Draft

## Workstream and review target

- Workstream: `planner-c2c-restart-resilience-p0-2`
- Repository: `svl33333/codex-with-chatgpt`
- Branch: `planner-c2c-restart-resilience-p0-2`
- Live Issue: [#3](https://github.com/svl33333/codex-with-chatgpt/issues/3)
- Canonical workflow: `codex-c2c-v2` 2.3.1 at
  `60d17218c256098522e063b5bf4731cecc9c1f12`
- Scope: restart-safe recovery for the configured Planner/C2C bridge and
  existing Secure MCP Tunnel, with Full Auto M1 and unrelated connectors
  outside ownership.

This is a planning draft. It does not modify runtime source, install a startup
task, mutate the existing tunnel/profile, re-pair ChatGPT, or implement the
GitHub credential broker.

## 1. Current implementation and verified seams

### Bridge and runtime state

- `src/bridge/runtime.ts` persists a user-local runtime record containing the
  service/version, workspace ID/root, PID, port, admin token, public URL, and
  start time. It probes `/health`, distinguishes healthy/stopped/unknown, and
  refuses to treat a failed probe with an uncertain PID as a dead bridge.
- `src/bridge/server.ts` binds only to loopback, prefers the configured port,
  falls back to an ephemeral port on `EADDRINUSE`, writes runtime state, and
  exposes loopback/admin endpoints for info, tunnel start/stop, revoke, and
  shutdown.
- `src/process/daemon.ts` reuses a healthy bridge, refuses an unknown
  observation, otherwise spawns a detached CLI daemon and waits for a healthy
  runtime. Logs are written under the user-local state directory with bounded
  permissions.
- The current runtime does not have a binding registry, a user-logon
  supervisor, or a recovery state machine that spans bridge and tunnel health.

### Tunnel and authorization

- `src/tunnel/provider.ts` defines the vendor-neutral start/stop/restart/status
  and doctor seam. Existing providers are Cloudflare Quick and Named Tunnel
  implementations.
- `src/tunnel/state.ts`, `src/tunnel/detect.ts`, and
  `src/tunnel/named-provision.ts` keep tunnel preference and ownership state in
  the user-local state directory and preserve named-first/HUMAN_WAITING rules.
- `src/auth/store.ts` stores hashed OAuth material in user-local state; pairing
  and token lifecycle are already separate from the project tree.
- The configured P0-2 tunnel is an existing OpenAI Secure MCP Tunnel profile.
  Its supported client commands, target update behavior, and unattended secret
  consumption must be inspected before selecting an adapter implementation.

### Identity and reconciliation

- `src/connection/identity.ts`, `src/connection/reconciler.ts`,
  `src/conversation/registry.ts`, and `src/conversation/delivery.ts` provide
  installation identity, endpoint fingerprints, exact binding checks,
  checkpointed connector reconciliation, and message idempotency.
- `docs/custom-stability-patches.md` requires exact workspace/repository/
  installation/endpoint ownership checks, foreign-resource protection,
  authoritative absence verification, and fail-closed ambiguity handling.
- `docs/protocol.md` and the existing stability rules prohibit re-pairing or
  connector recreation merely to resume after a restart.
- `ConnectionBinding` remains the authoritative installation/workspace/
  repository/endpoint identity, while the recovery registry supplies the
  approved canonical allowed-root policy that the current binding lacks. The
  v1 locator is `workspaceId`, matching the existing binding filename; a
  missing or malformed locator is a bounded identity failure, never a guessed
  binding.

### CLI and storage

- `src/cli/index.ts` already exposes `start`, `stop`, `restart`, `status`,
  `doctor`, `pair`, `unpair`, `workspace`, `identity`, `provisioning`, and
  `tunnel` commands with JSON output for the Skill.
- `src/config/paths.ts` provides the OS-convention state root and secure JSON
  writes. P0-2 should extend this user-local state boundary rather than place
  runtime state in the repository.
- Existing tests cover ports, runtime observations, tunnel providers,
  provisioning state, redaction, process hiding, connector reconciliation, and
  identity. They do not cover a P0-2 binding registry, startup task ownership,
  protected-secret selection, or an actual reboot.

## 2. Proposed architecture

### A. Binding registry

Add a versioned user-local recovery registry module (proposed
`src/recovery/bindings.ts`). The existing `ConnectionBinding` and
`connection/identity.ts` remain the single authority for installation,
workspace, repository, and endpoint identity. The recovery record references
that identity instead of defining a second competing binding model:

```text
RecoveryBindingRecord
  schemaVersion
  connectionBindingId
  projectName
  canonicalAllowedRoot
  tunnelProfileRef
  protectedSecretRef
  startupPolicy
  ownership
  observedHealth
```

The record contains only the `connectionBindingId`, identifiers resolved from
that identity, the one canonical allowed-root policy, hashes, and bounded
health. It does not contain Runtime API keys, OAuth tokens, pairing codes, or
arbitrary additional roots. The initial
record represents the approved `AI開発環境` route; the engine accepts a list so
P0-3/M2 can add bindings without hard-coded workspace constants. Any copied
identity fields are verification snapshots and must match the authoritative
`ConnectionBinding` before use.

For schema version 1, `connectionBindingId` is the existing
`ConnectionBinding.workspaceId` and therefore resolves unambiguously to
`bindingFile(workspaceId)`. It is a stable locator, not a second identity
authority. `canonicalAllowedRoot` is recovery policy keyed by that binding,
not a mutable identity field: it is seeded once from the currently verified
workspace root and cannot redirect an existing binding. On Windows, canonicalize
the seed and every observation with the native real-path API, normalized drive
letter/case, separator rules, and a directory-boundary check; reject missing,
malformed, junction-escaping, or non-contained paths. Recovery requires the
canonicalized `/admin/info.workspaceRoot` to equal this stored policy root.

Use schema-versioned atomic writes under the existing user-local state root.
Reject malformed records, non-contained roots, duplicate binding IDs, and
conflicting ownership before recovery starts.

### B. Protected secret boundary

Add an interface (proposed `src/recovery/secret-store.ts`) that resolves an
opaque `protectedSecretRef` to a secret only inside the recovery process. The
concrete Windows implementation is selected during capability inspection,
preferring a user-bound OS-integrated store (Credential Manager or user-scoped
DPAPI-backed state) that the installed runtime can read unattended.

The interface must:

- accept only a binding-scoped opaque reference;
- never place the raw value in command-line arguments, registry files, YAML,
  JSON artifacts, ordinary logs, prompts, or error messages;
- return a distinct `protected-secret-unavailable` classification;
- support one-time enrollment only when an existing authorized secret cannot be
  reused; and
- expose only redacted status to the recovery state and Full Auto control path.

Capability inspection is a hard prerequisite to selecting the concrete store
and tunnel adapter. It must document a supported in-process consumption path
(for example a vendor client API, protected stdin/IPC, or an OS credential
handle). Passing a secret through a shell command, process argument, registry
value, YAML/JSON field, an environment inherited by an unrelated child,
prompt, or log is unsupported and must return `protected-secret-unavailable`
without starting or mutating the tunnel. The inspection result records the
selected store, client version, and consumption mechanism as redacted metadata
only.

### C. Recovery state machine

Add a recovery coordinator (proposed `src/recovery/reconciler.ts`) with explicit
bounded phases:

1. `LOAD_BINDING` — load and validate one registry record.
2. `OBSERVE_BRIDGE` — read runtime state and `/health`, then use the
   authenticated loopback `/admin/info` endpoint when ownership-sensitive data
   is needed. `/health` alone is only a liveness signal. Compare the persisted
   runtime record and authenticated admin response for workspace ID, canonical
   root, service/version, endpoint/port, PID, and tunnel state. If admin info is
   unavailable, unauthenticated, or contradictory, return
   `ambiguous_ownership` and leave the process untouched.
3. `START_BRIDGE` — call the existing `ensureBridge` seam only when observation
   is definitively stopped; refuse duplicate start for unknown/ambiguous state.
   A persisted PID is never sufficient evidence that a process is owned by this
   binding.
4. `RESOLVE_SECRET` — resolve the protected secret reference without exposing
   it to the caller.
5. `RECONCILE_TUNNEL` — pass the actual bridge endpoint to a supported tunnel
   adapter; preserve profile identity and refuse undocumented mutation.
6. `VERIFY` — re-probe bridge, tunnel, workspace binding, and health.
7. `COMMIT_STATE` — write only sanitized observed state and an idempotency
   checkpoint.

Each phase returns a bounded status code such as `healthy`, `reused`,
`started`, `tunnel_reconciled`, `identity_mismatch`, `ambiguous_ownership`,
`protected_secret_unavailable`, `unsupported_tunnel_capability`, or
`recovery_waiting`. Unknown state is never converted into a start/kill/delete
operation.

### D. Startup/supervision entry

Add a per-user Task Scheduler installer/remover (proposed
`src/recovery/supervisor.ts` plus a narrowly scoped PowerShell wrapper under
`scripts/`). The task should:

- have a P0-2-specific name and ownership marker;
- trigger after the user logon session is ready;
- run hidden/non-interactive under the normal user context;
- invoke the recovery CLI with only a binding ID or registry reference;
- apply bounded retry/restart-on-failure settings supported by Windows;
- write redacted diagnostics to the user-local state directory; and
- remove only the task and state owned by P0-2.

Install, repeated install, status, and uninstall must be idempotent and should
not require elevation unless a later capability inspection proves it necessary.

### E. CLI surface

Add JSON-first commands or subcommands for `recover`, `supervisor install`,
`supervisor status`, and `supervisor uninstall`. Keep existing `start`,
`restart`, `doctor`, and `tunnel` behavior compatible. All new output must use
the bounded status vocabulary and secret-redacting logger.

### F. Tunnel adapter seam

Do not assume the current Cloudflare providers implement the configured OpenAI
Secure MCP Tunnel. First inspect the installed client version/help/profile
contract and the protected-secret consumption path. If a supported local
client operation exists, add a recovery-specific adapter (or a narrowly
extended `TunnelProvider`) that receives the actual loopback endpoint, a
profile reference, and an in-process credential handle. It must preserve the
existing Cloudflare provider contract and profile identity. If no supported
operation exists, return `unsupported_tunnel_capability` (or
`protected-secret-unavailable` when that is the failing boundary) and preserve
the existing profile rather than mutating it with an undocumented flag.

## 3. Data flow and trust boundaries

```text
User-logon Task Scheduler (normal user, binding ID only)
        |
        v
P0-2 recovery CLI -> binding registry (user-local, versioned)
        |
        +--> bridge observation / loopback /health
        |
        +--> protected secret store (raw value remains in-process)
        |
        +--> supported Secure MCP Tunnel adapter (actual bridge endpoint)
        |
        v
Sanitized recovery status + bounded state checkpoint
```

The repository, ChatGPT Project, MCP app, Planner plugin, OAuth state, tunnel
profile, and Full Auto M1 artifacts remain outside P0-2 rollback ownership.
The deferred GitHub broker is a separate host-side trust boundary and is not
called by this recovery path.

## 4. State, concurrency, and idempotency

- Serialize registry/recovery writes with a dedicated atomic secure writer and
  an OS/process-safe per-binding lock. The lock is acquired with an exclusive
  same-directory lock file (`CREATE_NEW`/equivalent), stores only redacted
  owner metadata (binding ID, PID, process start marker, and acquisition time),
  and has a bounded wait. A live owner or an owner whose identity cannot be
  established is never broken automatically. A stale lock may be removed only
  after the owner is positively absent and the lock metadata is valid; malformed
  or contradictory metadata returns `ambiguous_ownership`. After acquisition,
  re-read the registry and authoritative connection identity before acting.
- Use a narrowly scoped `writeSecureAtomicJson` helper for new recovery
  registry/checkpoint data: create a same-directory temp file with restrictive
  permissions, write and flush the complete bytes, close it, atomically replace
  the destination, and clean up only owned stale temp files. Preserve the
  existing `writeSecureJson()` behavior for unrelated state; do not perform a
  broad storage migration in P0-2.
- Derive an idempotency key from `connectionBindingId`, recovery operation, and observed
  endpoint fingerprint. Persist `prepared`, `reconciling`, `verified`, and
  `ambiguous` checkpoints without secrets.
- A healthy exact match is a no-op/reuse result.
- A stopped bridge may be started once; concurrent callers wait on the same
  binding lock and re-read authoritative state.
- A tunnel mutation is allowed only after profile ownership and supported
  capability are verified. Unknown create/update results are reconciled before
  retry; no blind duplicate operation is allowed.
- Startup install/uninstall uses the same ownership marker and never deletes a
  same-name task without matching ownership metadata.
- Recovery and rollback never terminate a process from a persisted PID alone.
  A stop or shutdown is allowed only after the authenticated admin identity
  matches the current binding; otherwise leave the process and return
  `ambiguous_ownership`. This protects against PID reuse and stale runtime
  records.

## 5. Compatibility and migration

- Keep existing runtime, endpoint, tunnel, OAuth, and provisioning files
  readable. Seed the first registry record from verified current state only
  after exact workspace/profile ownership checks. The seed captures the
  canonical allowed root from the verified workspace root using the Windows
  native real-path/case normalization rules above and binds it to the existing
  `ConnectionBinding.workspaceId` locator. An existing binding with no root
  policy is not silently broadened: if the root cannot be verified, recovery
  returns `identity_mismatch` or `ambiguous_ownership` and leaves resources
  untouched.
- Do not migrate explicit existing quick/named choices or replace existing
  connector/app/plugin resources.
- Preserve Node.js >=20, the current CLI JSON contract, loopback-only bridge
  binding, and Full Auto M1's v2.2.0 pin/state.
- A malformed or ambiguous legacy state, absent root policy, or root mismatch
  produces a bounded recovery status and requires a later explicit repair
  decision; it does not trigger deletion, path redirection, or re-pairing.

## 6. Security and privacy

- Keep all raw credentials in the user-bound protected store and process memory
  only; never include them in repository files, task arguments, logs, prompts,
  issue comments, or C2C messages.
- Enforce the stored `canonicalAllowedRoot` policy with Windows native
  canonicalization, directory-boundary/junction checks, and the
  one-bridge/one-workspace boundary. A recovery record cannot replace that
  root for an existing `ConnectionBinding`.
- Require exact service, workspace, endpoint, profile, repository, and
  installation identity before reuse.
- Keep admin endpoints loopback-only and preserve existing bearer/admin token
  protections.
- Return sanitized status and hashes/identifiers only to Full Auto and C2C.
- Treat GitHub credential-visible transport as a separate read/write/auth-
  refresh/scope-expansion boundary with canonical Human Gates; no broker work
  is in this plan's implementation stage.

## 7. Verification and test plan

Planned additions (not run in Step 3):

- Registry schema, duplicate binding, root containment, atomic write, and
  redaction unit tests, including a second process racing for the same binding
  lock, interrupted writes, restrictive permissions, stale-lock recovery, and
  malformed owner metadata.
- Recovery state-machine tests for healthy reuse, missing bridge, changed port,
  tunnel loss, protected-secret-unavailable, identity mismatch, and ambiguity.
- Trust-boundary tests proving `/health` cannot establish ownership by itself,
  authenticated `/admin/info` must agree with the runtime record, stale-PID/
  PID-reuse records are never killed, and an unavailable or contradictory
  admin endpoint leaves the process untouched.
- Process/task construction tests proving hidden execution, binding-ID-only
  arguments, idempotent install/remove, and ownership isolation.
- Tunnel adapter tests using a fake supported client contract; explicit tests
  that undocumented target mutation and historical-port assumptions fail closed.
- Protected-secret tests proving supported in-process consumption, no command
  line/environment/log/config leakage, pre-existing-secret preservation, and
  owned-secret cleanup only on uninstall.
- Existing connector/OAuth continuity tests asserting no pair/recreate mutation
  during normal recovery.
- Migration/coexistence tests proving the authoritative `ConnectionBinding`
  remains the single identity source and copied recovery snapshots cannot
  override it.
- Planner routing regression tests for the positive local fixture and negative
  unrelated request.
- A real Windows reboot acceptance record proving the startup task ran, the
  bridge/tunnel binding was reused/reconciled, no credential or pairing input
  was requested, and fixture sentinel lines 1 and 450 were retrieved.

## 8. Rollback and observability

- Uninstall removes only the P0-2 task, registry records, recovery checkpoints,
  and task-owned wrapper/runtime state. Each protected secret reference carries
  non-secret provenance (`createdBy: p0-2` versus `preExisting`) and ownership
  is checked before cleanup. Uninstall may delete a P0-2-created secret only
  when the ownership record is intact; it only detaches a pre-existing secret
  reference and never deletes the shared credential.
- Existing OAuth, MCP app, Planner plugin, tunnel profile, unrelated connector
  state, and Full Auto M1 files are never rollback targets.
- Emit structured redacted events for each phase and failure classification;
  avoid raw command output in durable state.
- Preserve enough identifiers to reconcile uncertain operations without
  exposing secrets or copying credentials into the repository.

## 9. Implementation order and known limitations

1. Inspect the installed Secure MCP Tunnel client/profile capabilities and the
   available Windows protected-secret APIs; record the chosen supported seam,
   the in-process credential-consumption mechanism, and the client version. If
   no supported mechanism exists, stop the implementation at the bounded
   capability result without creating a fallback shell transport.
2. Add the recovery registry schema as a reference to the existing
   `ConnectionBinding`, plus redacted state types, validation, process-safe
   binding locks, and the narrowly scoped atomic secure writer.
3. Add bridge observation/recovery coordinator and sanitized CLI output,
   including authenticated `/admin/info` ownership checks and fail-closed
   stale-PID handling.
4. Add the supported tunnel adapter and actual-endpoint reconciliation only
   after steps 1–3 validate the trust and secret boundaries.
5. Add Task Scheduler install/status/uninstall with ownership markers and
   protected-secret provenance cleanup rules.
6. Add deterministic tests and run the required project checks in the later
   implementation stage.
7. Perform the actual Windows reboot acceptance and record evidence.

Known limitations before implementation:

- The installed Secure MCP Tunnel client's supported target-update contract is
  not yet verified.
- The concrete Windows protected-secret store is intentionally deferred to
  capability inspection.
- The existing bridge runtime state includes an admin token in protected
  user-local state; the new recovery status must never expose it.
- A supported host-side GitHub credential broker remains a separate deferred
  capability and is not implemented by P0-2 planning.

## 10. Step 3 remediation acceptance criteria

The following constraints are part of this plan before implementation begins:

1. `ConnectionBinding` is the only identity authority. Recovery records may
   cache verification snapshots, but a snapshot mismatch is a fail-closed
   `identity_mismatch`; it cannot create a second binding identity. In schema
   v1, `connectionBindingId` resolves to the existing `workspaceId` binding
   file, while `canonicalAllowedRoot` is a separate immutable recovery-policy
   field. It is seeded only from a verified workspace root, canonicalized with
   Windows native real-path/case and boundary rules, compared exactly with
   authenticated `/admin/info.workspaceRoot`, and never silently inferred,
   redirected, or widened for a legacy binding.
2. Binding serialization is cross-process and fail-closed: exclusive lock
   acquisition, bounded wait, validated owner metadata, stale-owner proof, and
   authoritative state re-read are required. A process-local promise map is not
   sufficient.
3. New registry/checkpoint writes use the scoped atomic secure writer with
   same-directory temp files, flush/close, atomic replacement, restrictive
   permissions, and owned-temp cleanup. Existing unrelated secure JSON writes
   are not globally migrated.
4. `/health` establishes liveness only. Ownership-sensitive reuse, shutdown,
   and rollback require authenticated `/admin/info` agreement with the runtime
   record. Missing or contradictory evidence leaves the process untouched.
5. A PID from persisted state, by itself, can never authorize termination.
   PID reuse and stale-record cases must return `ambiguous_ownership`.
6. The protected-secret and tunnel capability inspection must prove an
   in-process, bounded credential-consumption mechanism before any secret or
   endpoint mutation. Shell, argument, broad environment, config, prompt, and
   log transports are explicitly rejected.
7. Tunnel recovery is a compatibility-preserving adapter for the installed
   Secure MCP Tunnel contract. Existing Cloudflare providers and profile
   identity remain unchanged when the capability is absent.
8. Secret cleanup uses explicit non-secret provenance so uninstall can remove
   only P0-2-owned protected material and can never delete a pre-existing or
   shared secret.
9. The verification plan includes cross-process races, interrupted writes,
   stale locks, PID reuse, admin disagreement, secret leakage, ownership
   migration, and reboot acceptance evidence.
10. Capability inspection precedes implementation integration; an unsupported
    capability produces a bounded result rather than an invented fallback.
