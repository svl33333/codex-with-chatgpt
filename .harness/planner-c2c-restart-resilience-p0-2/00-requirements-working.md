# P0-2 — Planner / C2C Restart & Zero-Touch Recovery Foundation

Workstream: `planner-c2c-restart-resilience-p0-2`
Repository: `svl33333/codex-with-chatgpt`
Branch: `planner-c2c-restart-resilience-p0-2`
Workflow: `codex-c2c-v2` 2.3.1 (`60d17218c256098522e063b5bf4731cecc9c1f12`)

## 1. Problem statement

The existing AI開発環境 Planner path works through the local C2C bridge and
OpenAI Secure MCP Tunnel, but a Windows restart or ordinary process loss can
leave the bridge or tunnel runtime absent, bound to a different local port, or
unable to recover its protected Runtime API credential. Recovery currently
depends on manual process startup or an equivalent operator action. That breaks
the intended ChatGPT Project → Planner → Local Files path even though the
existing OAuth authorization and resources remain valid.

P0-2 establishes a restart-safe recovery foundation in
`svl33333/codex-with-chatgpt`. It must preserve the current working route,
reuse healthy resources, verify binding identity, and prepare the runtime for
later multi-project bindings without implementing the full M2 broker.

## 2. Goals

1. Recover the configured local C2C bridge after user logon, process loss, or a
   manual diagnostic invocation.
2. Recover or reuse the existing OpenAI Secure MCP Tunnel profile and bind it
   to the bridge's actual current loopback MCP endpoint.
3. Persist the Runtime API credential through a user-bound protected secret
   reference; never place the raw secret in Git, repository files, task
   arguments, ordinary logs, prompts, or durable workflow artifacts.
4. Make recovery idempotent. A healthy bridge, tunnel, authorization, ChatGPT
   MCP app, and Planner configuration are reused without duplication or fresh
   pairing.
5. Verify workspace/binding identity and fail closed on mismatch or ambiguous
   ownership.
6. Install a user-session Windows startup/supervision mechanism with bounded
   diagnostics and an idempotent uninstall path.
7. Keep configuration registry-driven: one initial AI開発環境 binding is
   acceptable, but the reusable engine consumes binding records rather than
   embedding one workspace throughout the code.
8. Provide deterministic automated coverage and a real Windows reboot
   acceptance procedure/evidence.
9. Preserve the existing Planner positive/negative routing behavior and the
   existing Full Auto M1 workstream unchanged.

## 3. Non-goals

- Full Project Context Broker or broad multi-project multiplexing (P0-3/M2).
- Full Auto M1 implementation, state migration, or workflow-pin changes.
- Legacy connector/project inventory or cleanup (P0-5).
- New write-capable Local Files tools.
- Cloudflare public C2C transport as a replacement for the OpenAI Secure MCP
  Tunnel.
- CAPTCHA, forced 2FA bypass, or provider account recovery.
- Automatic deletion/recreation of existing ChatGPT apps, Planner plugins,
  connectors, or valid OAuth authorization.

## 4. Current facts and canonical boundaries

### Existing Planner route

| Concept | Current value / boundary |
| --- | --- |
| ChatGPT Project | `AI開発環境` |
| MCP app | `AI開発環境 Local Files` |
| Planner plugin | `AI開発環境 Planner` |
| bundled skill | `local-development-artifacts` |
| fixture root | `C:\Projects\ai-agent-harness-setup` |
| workspace ID | `bc1fcc6d67dd` |
| root alias | `workspace:/` |
| fixture | `c2c-planner-connector-verification/fixture.txt` |
| expected line 1 | `safe-pagination-line-001 :: planner-fixture :: UPDATED-V2 :: no-secrets` |
| expected line 450 | `safe-pagination-line-450 :: planner-fixture :: no-secrets` |

### Runtime ownership

M0-D architecture records that `codex-with-chatgpt` owns C2C connector/runtime
provisioning and the read-only workspace-context path. The Full Auto control
plane remains architecture and acceptance context. P0-2 edits only the owning
runtime repository unless an implementation dependency is proven later.

The supported C2C entry is the repository runtime/CLI (`bin/c2c.js` and its
compiled/runtime implementation). The OpenAI tunnel client is
`C:\Tools\OpenAI\tunnel-client\tunnel-client.exe`, observed version
`0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0`. The existing profile is
`C:\Users\yuyab\AppData\Roaming\tunnel-client\ai-development-local-files.yaml`
with profile name `ai-development-local-files`.

The reusable recovery engine must distinguish machine/runtime configuration,
project binding identity, allowed roots, tunnel/profile identity, startup and
recovery policy, protected secret reference, and health/observed state. It must
not grant unrestricted access to `C:\Projects`.

## 5. Design tree and stable Q-IDs

The following questions are the Step 1 frontier. The recommendation records
the default direction for planning; an answer can accept it, qualify it, or
replace it. The IDs remain stable for later workflow steps.

### Q201 — Binding registry contract

**Question:** What record identifies one recoverable Planner binding?

**Recommendation:** Use a versioned user-local registry record with
`bindingId`, logical project name, expected workspace ID, canonical allowed
root, tunnel profile name/path reference, protected secret reference, startup
policy, and observed health. Keep the current AI開発環境 entry as the only
initial record; keep the recovery engine generic over a list of records.

**Impact:** This allows P0-3/M2 to add bindings without scattering the current
workspace ID or root through the engine, while retaining least privilege.

### Q202 — Protected Runtime API secret mechanism

**Question:** Which Windows user-bound protected storage should P0-2 select?

**Recommendation:** Prefer a user-scoped OS-integrated store (Windows
Credential Manager or DPAPI-protected data under the user runtime state), with
ACLs limited to the interactive user and a stable opaque `secretRef` in the
registry. Choose the concrete mechanism after checking what the installed
tunnel client and runtime can consume unattended; record the choice and
rollback behavior in the implementation plan.

**Unresolved constraint:** No mechanism may expose the raw API key to model
output, repository files, Task Scheduler arguments, YAML, ordinary logs, or
workflow artifacts. A one-time enrollment may be required only if no existing
authorized secret can be reused.

### Q203 — User-logon supervision policy

**Question:** What startup/supervision policy should own the recovery entry?

**Recommendation:** Use a per-user Windows Task Scheduler task, delayed until
the user session is ready, hidden/non-interactive, with bounded diagnostic
logging and restart-on-failure where supported. Installation and removal must
be idempotent and must not require elevation unless the selected supported
mechanism proves it necessary.

### Q204 — Dynamic endpoint reconciliation

**Question:** How should the existing tunnel profile receive the recovered
bridge endpoint when the bridge's port changes?

**Recommendation:** First verify the installed tunnel-client version, local
`--help`, supported profile/config commands, and official documentation. Use a
supported dynamic target or deterministic reconciliation step that preserves
the existing profile identity. A literal historical port such as `52096` must
never become the restart assumption.

**Unresolved constraint:** Do not mutate or replace the existing managed
profile unless the supported client requires a safe, deterministic target
update and ownership is proven.

### Q205 — Bridge identity and duplicate prevention

**Question:** What evidence is sufficient to reuse a bridge or classify an
occupant as foreign?

**Recommendation:** Query the supported runtime health/status interface and
verify binding workspace ID, canonical root, endpoint, and ownership metadata.
Reuse only an exact match; fail closed on mismatch or ambiguity; never kill an
unknown process. Start the supported bridge only when the expected instance is
missing.

### Q206 — Tunnel reuse and authorization continuity

**Question:** What should normal recovery do when the tunnel or OAuth path is
already healthy?

**Recommendation:** Reuse the existing tunnel/profile and durable OAuth state.
Normal health checks must not issue a pairing code, recreate the MCP app,
reinstall the Planner plugin, or initiate a new OAuth session. Replacement is
allowed only when the managed resource is proven destroyed and the recovery
checkpoint makes ownership unambiguous.

### Q207 — Narrow GitHub credential-visible helper

**Question:** How can later canonical workflow Issue/push/PR operations use the
normal user's GitHub credentials from the Codex sandbox?

**Recommendation:** Treat this as a separate bounded capability: a host-side
helper or equivalent supported broker executes in the normal user's credential-
visible context, returns only sanitized operation/status evidence, and never
returns bearer tokens. It must distinguish read, write, auth-refresh, and
scope-expansion operations and preserve canonical Human Gates for writes.

**Unresolved capability requirement:** Codex must be able to perform
authorized GitHub operations through that narrow broker without copying
credentials into repository-readable paths or broadly weakening the sandbox.
No broker implementation is authorized in Step 1.

### Q208 — Acceptance and failure evidence

**Question:** What must constitute P0-2 acceptance?

**Recommendation:** Require deterministic lower-level tests plus an actual
Windows reboot. Before reboot the current Local Files route is healthy and no
raw secret remains in project/log/task arguments. After reboot, without manual
PowerShell startup, verify the task ran, bridge identity and dynamic endpoint
are healthy, the existing tunnel/OAuth/app/plugin were reused, no pairing code
was generated, and a new ordinary AI開発環境 conversation retrieves fixture
lines 1 and 450 without manually selecting the Planner.

## 6. Acceptance criteria (Given / When / Then)

- **AC-201 Binding-driven recovery** — Given a registry containing the current
  AI開発環境 binding, when recovery runs, then it resolves the binding record,
  validates the exact workspace ID/root, and never depends on a global fixed
  project/root constant.
- **AC-202 Idempotent healthy rerun** — Given a healthy bridge and tunnel, when
  recovery runs repeatedly, then it returns a no-op/reused result and creates
  no duplicate process, tunnel, connector, app, plugin, or OAuth pairing.
- **AC-203 Bridge loss** — Given the configured bridge process is absent, when
  recovery runs, then the supported C2C runtime starts one instance, verifies
  its workspace identity, obtains its actual MCP endpoint/port, and records
  sanitized health state.
- **AC-204 Port propagation** — Given the bridge chooses a different available
  loopback port, when recovery reconciles the tunnel, then the tunnel target
  uses that actual endpoint and no historical port assumption is required.
- **AC-205 Fail closed** — Given a wrong workspace ID, root, profile identity,
  or ambiguous process ownership, when recovery runs, then it refuses reuse or
  replacement and emits a bounded redacted diagnostic state.
- **AC-206 Tunnel loss** — Given the bridge is healthy but the tunnel runtime is
  absent, when recovery runs, then the existing profile is reused or safely
  reconciled and one tunnel runtime is restored.
- **AC-207 Secret protection** — Given normal recovery, when logs and state are
  inspected, then no Runtime API key, OAuth token, pairing code, bearer header,
  or token-like secret is present; protected-secret-unavailable is a distinct
  bounded failure.
- **AC-208 Startup lifecycle** — Given an installed startup task, when install,
  repeated install, and uninstall are run, then exactly one P0-2 task exists,
  repeated install is idempotent, and uninstall removes only P0-2 resources.
- **AC-209 Authorization continuity** — Given valid durable authorization, when
  Windows restarts, then recovery does not create a pairing code or new OAuth
  session and ChatGPT can resume the existing MCP app.
- **AC-210 Planner behavior** — Given the existing Planner plugin/skill, when a
  local fixture request and unrelated generic TypeScript request are made,
  then positive local routing and negative non-local routing remain unchanged.
- **AC-211 Reboot proof** — Given the startup mechanism is installed, when the
  machine is actually rebooted, then the current fixture returns line 1
  `safe-pagination-line-001 :: planner-fixture :: UPDATED-V2 :: no-secrets` and
  line 450 `safe-pagination-line-450 :: planner-fixture :: no-secrets` without
  manual startup, re-pairing, credential re-entry, or resource recreation.
- **AC-212 Rollback isolation** — Given P0-2 uninstall/rollback, when it runs,
  then it removes only P0-2-created startup/recovery resources and preserves
  the existing Local Files app, Planner plugin, valid OAuth authorization,
  managed tunnel, unrelated connectors/projects, and Full Auto M1 state.
- **AC-213 GitHub capability boundary** — Given a later canonical workflow GitHub
  operation, when the sandbox lacks normal-user credentials, then a narrow
  credential-visible helper is the only permitted bridge; it returns sanitized
  evidence, never tokens, and preserves the applicable Issue/push/PR Human Gate.

## 7. Failure behavior and observability

Diagnostics must distinguish at least: bridge healthy/missing/identity mismatch;
tunnel healthy/missing/control-plane auth failure; local MCP unreachable;
expected pre-authorization OAuth 401; ChatGPT authorization present or
expired/unrecoverable; startup task missing/misconfigured; protected secret
unavailable; project binding mismatch; and ambiguous ownership.

Every normal status/recovery result is bounded and redacted. Logs contain no
Runtime API key, OAuth access/refresh token, pairing code, admin token, bearer
header, or other token-like secret. Recovery does not broaden
`HARPOON_ALLOW_PLAINTEXT_HTTP=true`; it is scoped only to the trusted loopback
MCP target process/runtime.

## 8. Dependencies and verification plan

- Existing `codex-with-chatgpt` bridge/process/configuration modules and CLI.
- Installed OpenAI tunnel-client `0.0.15...` and its existing profile.
- Windows user-session Task Scheduler and user-bound protected secret store.
- Existing ChatGPT OAuth/MCP app and Planner plugin; no replacement path.
- Canonical C2C review provider for Steps 3, 5, and 7; local review is only
  supplemental evidence.
- Deterministic unit/integration tests for state, identity, idempotency,
  dynamic endpoint propagation, redaction, startup install/remove, and failure
  classification.
- Real-machine reboot acceptance with sanitized evidence.

## 9. Rollback concerns

All P0-2-created state must be namespaced and ownership-tagged so uninstall can
remove its startup task, wrapper, registry entries, diagnostics, and any task-
owned replacement runtime without deleting pre-existing resources. Existing
OAuth state, ChatGPT app, Planner plugin, managed tunnel/profile, unrelated
connectors, and Full Auto M1 artifacts are outside rollback ownership.

## 10. Assumptions and impact

| Assumption | Impact if false |
| --- | --- |
| The current bridge runtime exposes a supported health/status and actual MCP endpoint after startup. | Plan must add a narrow supported status probe before recovery can be trusted. |
| Tunnel-client `0.0.15...` supports a safe profile/target reconciliation path. | P0-2 may be blocked or require a vendor-supported upgrade decision; no undocumented flag will be assumed. |
| Existing OAuth refresh state remains valid across ordinary Windows restart. | Record provider invalidation separately; do not classify it as a restart defect or auto-pair. |
| The user logon session can read the selected protected secret store unattended. | Emit `protected-secret-unavailable` and require one explicitly bounded enrollment action. |
| A host-side credential-visible GitHub helper can be exposed without token return. | GitHub write stages remain at the exact credential-visible boundary; P0-2 runtime implementation can continue independently. |
| The existing Planner routing contract is stable. | Make only a minimal compatibility change if a P0-2 defect is demonstrated; general hardening remains P0-4. |

## 11. Q201-Q208 frontier classification

Each existing stable Q-ID is classified exactly once. A settled item remains
visible here; it is not silently removed from the design tree.

| Q-ID | Classification | Basis |
| --- | --- | --- |
| Q201 | `OPEN_USER_DECISION` | No prior instruction selects the binding-registry shape. The verified current workspace/project values establish the initial entry data, not the reusable record contract. |
| Q202 | `OPEN_USER_DECISION` | Prior instructions require protected, non-exported secrets, but neither the instructions nor verified runtime capability evidence selects Credential Manager versus DPAPI or another store. |
| Q203 | `OPEN_USER_DECISION` | Prior instructions establish automatic Windows restart recovery as the goal, but do not choose Task Scheduler, another user-session startup mechanism, delay, or supervision policy. |
| Q204 | `OPEN_USER_DECISION` | The installed tunnel-client version and existing profile are verified, but supported dynamic-target/config reconciliation has not been verified. The historical port cannot decide this question. |
| Q205 | `SETTLED_BY_VERIFIED_FACT` | `docs/custom-stability-patches.md` and the architecture records require exact workspace/repository/installation/endpoint identity, foreign-resource protection, ambiguity blocking, and no blind recreation. These settle the fail-closed reuse invariant; the later implementation still needs a supported probe. |
| Q206 | `SETTLED_BY_VERIFIED_FACT` | `docs/protocol.md` says not to re-pair or recreate a connector merely to resume, and `docs/custom-stability-patches.md` requires healthy-resource reuse with zero normal-startup mutations. Existing OAuth/app/plugin/profile continuity is therefore the normal recovery behavior. |
| Q207 | `SETTLED_BY_EXISTING_USER_INSTRUCTION` | The prior user instruction explicitly requires carrying the narrow credential-visible host-side GitHub helper capability, forbids token return/repository credential copies, requires bounded operation classes and sanitized evidence, preserves write Human Gates, and defers implementation until the authorized implementation stage. |
| Q208 | `OPEN_USER_DECISION` | The fixture values are verified, but no prior instruction fixes whether deterministic tests alone suffice or an actual reboot plus fixture-line proof is mandatory final evidence. |

## 12. Current open questions for the Requirements Gate

The following questions remain open and are presented in full to the user
before approval. The recommendations can be accepted, qualified, or replaced.

### Q201 — Binding registry contract

**Question:** What record identifies one recoverable Planner binding?

**Context:** The current verified route is ChatGPT Project `AI開発環境` →
`AI開発環境 Planner` → `AI開発環境 Local Files`, with workspace ID
`bc1fcc6d67dd` and root `C:\Projects\ai-agent-harness-setup`. P0-2 must
support this one binding while leaving a path to later multi-project bindings.

**Recommendation:** Approve a versioned user-local registry record containing
`bindingId`, logical project, expected workspace ID, canonical allowed root,
tunnel/profile reference, protected-secret reference, startup policy, and
observed health; seed one current `AI開発環境` entry and keep the engine
generic over a list.

**Trade-off / risk:** A reusable registry avoids hard-coded workspace values and
supports P0-3/M2, but adds migration and validation surface to a one-binding
implementation.

**Answer choices:**

- **A (recommended):** Approve the versioned registry and one initial entry.
- **B:** Use a single-binding record now and defer a registry migration.
- **C:** Provide another record shape or constraints.

### Q202 — Protected Runtime API secret mechanism

**Question:** Which Windows user-bound protected storage should P0-2 select?

**Context:** Recovery must work unattended in the normal Windows user session.
The raw Runtime API key must never appear in model output, repository files,
Task Scheduler arguments, YAML, ordinary logs, or workflow artifacts. The
current tunnel profile and OAuth state are existing user-local resources.

**Recommendation:** Select the concrete store during Step 3 capability
inspection, preferring a user-scoped Windows Credential Manager or DPAPI-backed
store with a stable opaque `secretRef`, and record rollback behavior.

**Trade-off / risk:** Deferring the choice preserves compatibility with the
installed runtime; fixing one store earlier simplifies implementation but can
fail unattended access or require an unnecessary enrollment step.

**Answer choices:**

- **A (recommended):** Choose after capability inspection, constrained to a
  user-bound protected store and opaque reference.
- **B:** Require Windows Credential Manager.
- **C:** Require user-scoped DPAPI-backed state.
- **D:** Provide another protected-store rule.

### Q203 — User-logon supervision policy

**Question:** What startup/supervision policy should own the recovery entry?

**Context:** The requested behavior is automatic recovery after ordinary
Windows restart or process loss, without manual PowerShell startup. The current
repository documents bridge/tunnel restart operations but does not establish a
P0-2 user-logon supervisor.

**Recommendation:** Use one idempotent per-user Windows Task Scheduler task,
delayed until the user session is ready, hidden/non-interactive, with bounded
diagnostics and supported restart-on-failure behavior; require no elevation
unless a later capability check proves it necessary.

**Trade-off / risk:** Task Scheduler gives explicit user-session triggers and
recovery diagnostics, while another startup mechanism may be simpler but offer
weaker retry, ownership, and uninstall guarantees.

**Answer choices:**

- **A (recommended):** Approve the per-user delayed Task Scheduler policy.
- **B:** Use another supported per-user startup/supervision mechanism.
- **C:** Require a different trigger, retry, elevation, or visibility policy.

### Q204 — Dynamic endpoint reconciliation

**Question:** How should the existing tunnel profile receive the recovered
bridge endpoint when the bridge's port changes?

**Context:** The bridge may choose a different loopback port after restart. The
installed tunnel-client version and existing profile are known, but supported
profile/config commands and dynamic target behavior still require capability
inspection. The historical port `52096` is not a restart contract.

**Recommendation:** Use only documented/supported client behavior: a dynamic
target where available, otherwise deterministic reconciliation that preserves
the existing profile identity and mutates it only after ownership is proven.

**Trade-off / risk:** Dynamic reconciliation improves zero-touch recovery, but
an unsupported profile mutation could damage the existing tunnel; fail-closed
manual repair is safer but breaks the zero-touch goal.

**Answer choices:**

- **A (recommended):** Approve supported dynamic target/reconciliation while
  preserving profile identity.
- **B:** Fail closed on endpoint change and require an explicitly bounded human
  repair step.
- **C:** Provide another supported-client constraint.

### Q208 — Acceptance and failure evidence

**Question:** What must constitute P0-2 acceptance?

**Context:** The verified fixture is
`c2c-planner-connector-verification/fixture.txt`; expected line 1 is
`safe-pagination-line-001 :: planner-fixture :: UPDATED-V2 :: no-secrets`, and
expected line 450 is `safe-pagination-line-450 :: planner-fixture :: no-secrets`.
The purpose of P0-2 is restart recovery while preserving existing OAuth,
tunnel, app, plugin, and routing behavior.

**Recommendation:** Require deterministic lower-level tests plus one actual
Windows reboot. Before and after reboot, collect sanitized evidence that the
startup task ran, binding/endpoint identity is correct, healthy resources were
reused, no pairing or credential re-entry occurred, and a new ordinary
`AI開発環境` conversation retrieves fixture lines 1 and 450.

**Trade-off / risk:** Reboot evidence catches session-start and credential-store
failures that unit tests miss, but it is machine-dependent and slower than a
deterministic-only gate.

**Answer choices:**

- **A (recommended):** Make the actual reboot plus fixture-line proof mandatory.
- **B:** Require deterministic tests now and record reboot evidence separately.
- **C:** Provide another acceptance and failure-evidence boundary.

## 13. Workflow/Skill conformance defect candidate

At a Grilling-backed Requirements Human Gate, an ID-only approval request is
invalid. The user-facing response must contain the complete current question
frontier, or explicitly account for questions already settled by existing
instructions/evidence.

This P0-2 correction is local evidence only. It does not authorize a permanent
TeamAI or canonical-workflow regression fix inside this workstream.

## 14. Requirements approval record

The user explicitly approved the complete Requirements Discovery frontier:

- Q201: A
- Q202: A
- Q203: A
- Q204: A
- Q208: A
- Overall requirements: approve

Q205 and Q206 remain settled by verified repository facts, and Q207 remains
settled by the existing user instruction while its implementation is deferred
to the authorized implementation stage. No requirements-level open questions
remain.

Canonical Step 2 Issue Finalization created GitHub Issue
[#3](https://github.com/svl33333/codex-with-chatgpt/issues/3). The Issue was
verified through the authenticated GitHub transport. Machine-local identifiers,
fixture paths, and protected-resource locations were intentionally omitted from
the public Issue and remain in this local artifact.

No remote branch has been published, and no implementation has started.

## 15. Full Auto Requirements Decision Resolver regression requirement

This Q201-Q208 classification is a regression case for the future Full Auto
Requirements Decision Resolver. Before presenting a Requirements Human Gate,
the resolver must:

- settle implementation facts that can be resolved by repository/runtime
  investigation or other verified evidence;
- settle project policy already approved by an existing user instruction; and
- present only genuine `OPEN_USER_DECISION` items for a new human decision,
  without re-asking settled facts or policy as if they were open.

The settled Q205/Q206/Q207 items and the approved Q201/Q202/Q203/Q204/Q208
answers are the expected regression inputs and outputs. Every stable Q-ID must
remain accounted for in the classification record, even when it is settled.
