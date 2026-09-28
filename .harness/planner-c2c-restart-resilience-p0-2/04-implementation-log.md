# P0-2 implementation log

## Workstream

- Workstream: `planner-c2c-restart-resilience-p0-2`
- Repository: `svl33333/codex-with-chatgpt`
- Branch: `planner-c2c-restart-resilience-p0-2`
- Issue: #3
- Workflow: `codex-c2c-v2` 2.3.1 at
  `60d17218c256098522e063b5bf4731cecc9c1f12`
- Full Auto M1: untouched; historical v2.2.0 Step 4 `HUMAN_WAITING` state
  remains outside this workstream.

## Implemented scope

- Added recovery-owned, versioned user-local binding records keyed by the
  existing `ConnectionBinding.workspaceId`; copied identity fields are
  verification snapshots only.
- Added native real-path root canonicalization and exact allowed-root checks,
  including junction/symlink resolution and directory identity validation.
- Added a scoped secure atomic JSON writer for new recovery state and
  checkpoint files; unrelated state writers remain unchanged.
- Added exclusive same-directory binding locks with validated redacted owner
  metadata, bounded waiting, stale-owner proof, and fail-closed malformed or
  unverifiable ownership handling.
- Added authenticated `/admin/info` bridge ownership verification. `/health`
  is used only as liveness evidence; runtime/admin workspace, root, version,
  port, PID, start time, and public endpoint identity must agree before reuse
  or shutdown.
- Added a recovery coordinator with explicit phases, idempotency checkpoints,
  one-start-only behavior for definitively stopped bridges, protected-secret
  resolution, actual loopback endpoint handoff, verification, and sanitized
  bounded statuses.
- Added protected-secret and Secure MCP Tunnel adapter interfaces. The default
  adapters fail closed until a supported OS-backed in-process capability is
  verified; no shell argument, broad environment, config, log, or prompt
  transport is used.
- Added `c2c recover` and P0-2 owned `c2c supervisor install/status/uninstall`
  commands. Supervisor actions carry only a binding ID and use an owned
  Windows user-logon Task Scheduler name/action.

## Capability and execution limitations

- The installed runtime has no verified Windows protected-secret integration
  or Secure MCP Tunnel in-process adapter available to this implementation.
  Recovery therefore returns `unsupported_tunnel_capability` (or the
  protected-secret equivalent) without mutating the existing profile.
- Codex's requested GPT-5.6 Luna Max/Fast execution setting is not observable
  from repository execution; this limitation is recorded and does not change
  the source behavior.
- The full test-suite subprocess failures were host `uv_os_get_passwd`
  `ENOMEM` errors from `tsx`; targeted recovery tests, typecheck, and build
  passed. See `04-test-summary.md`.

## Remediation after post-implementation C2C review

The first Step 5 post-implementation review returned `FIX_REQUIRED`. The
following in-scope corrections were applied before re-review:

1. Recovery state replacement now uses a same-directory temporary file and the
   Windows `File.Replace` operation with a unique backup path. The destination
   is never deleted before replacement.
2. Binding-only supervisor recovery resolves and validates the canonical root
   from the user-local recovery record, so logon startup does not depend on its
   working directory.
3. Task Scheduler ownership is checked from structured task metadata using the
   P0-2 description marker, exact action arguments, executable, and working
   directory. Creation does not use `/F`; a create race is reconciled before
   reporting failure.
4. The owned task definition uses delayed logon, hidden least-privilege
   interactive-user execution, bounded restart-on-failure, and start-when-
   available settings. Absence is detected from the structured scheduler
   query result rather than localized text.
5. Supervisor uninstall now coordinates ownership-validated task removal with
   recovery registry/checkpoint/log/definition cleanup. A P0-2-created secret
   is released only through an available protected-secret store; pre-existing
   material is never released.
6. Tunnel reuse compares the adapter-observed local endpoint with the current
   authenticated bridge endpoint. A stale running tunnel is reconciled and is
   reported as `tunnel_reconciled`.
7. Recovery seeding fails closed unless explicit binding-scoped profile/secret
   references and non-placeholder verified capability providers are supplied;
   the CLI seed path remains unavailable until a real supported capability is
   established.
8. Deterministic tests now cover atomic replacement, same-process and
   cross-process lock contention, malformed lock metadata, exact supervisor
   ownership/idempotency, stale tunnel targets, protected-secret cleanup, and
   capability fail-closed behavior.

## Remediation after post-implementation re-review (iteration 1)

The same bound C2C session returned a second `FIX_REQUIRED` verdict. The
following findings were corrected before the next re-review:

1. Lock-acquisition failure now returns an in-memory `recovery_waiting`
   result and never writes the competing process's shared checkpoint.
2. The scheduled PowerShell action captures `$LASTEXITCODE`, writes the
   bounded recovery output, and exits with the native recovery code so
   Task Scheduler retry policy remains effective.
3. Structured Task Scheduler querying distinguishes a successfully empty
   task list (`absent`) from query/service/access failures (`ambiguous`).
4. Durable recovery seeding now accepts only a capability attestation created
   after concrete protected-secret and tunnel provider inspection; arbitrary
   provider-name strings cannot claim verification.
5. Tunnel reconciliation performs a second adapter observation and commits
   only after the running profile and exact current loopback endpoint agree.
6. Recovery requires both protected-secret availability and
   `consumption: in_process` before resolving a secret.
7. Recovery result reasons and CLI error paths use the existing output
   sanitizer before serialization; supervisor output therefore receives only
   bounded redacted diagnostics.
8. Uninstall removes only binding-scoped recovery `.tmp`/`.bak` leftovers in
   the known user-local state directories, preserving foreign artifacts.
9. Deterministic coverage now includes dead-owner reclamation, checkpoint
   isolation under lock contention, scheduler query failure, native exit-code
   propagation, post-reconcile tunnel disagreement, unsupported secret
   transport, successful owned-secret release, capability-attestation
   rejection, and authenticated admin PID-reuse disagreement.

These corrections remain within the approved plan. No GitHub write, commit,
push, PR, connector mutation, or Full Auto M1 change was performed.

## Step 6 publication boundary

The explicit Step 6 commit/push/PR approval was received. The approved local
implementation commit is `8fbef9d5d80224443b31a89231d7ac1dacf7e711`
(`fix(recovery): preserve C2C bindings across restarts`). The authenticated
official GitHub browser session created the remote
`planner-c2c-restart-resilience-p0-2` branch from
`release/v0.1.3-svl.13`, but no implementation files or commit have been
published to it yet.

The sandboxed `gh auth status` and `git ls-remote` remain unusable because the
Codex process cannot use the normal user's credential context. No device flow,
token copy, credential-file copy, or sandbox weakening was attempted. The
official GitHub upload form cannot receive local files until the ChatGPT/Codex
Chrome extension's `Allow access to file URLs` setting is enabled; the in-app
browser has no usable file-chooser path. Chrome's internal settings URL is
blocked from Codex browser automation, so this is the single remaining human
action before Step 6 publication can resume.

No PR was created, no merge was attempted, and Full Auto M1 remains
unchanged. After publication, remote checks and Step 7 independent C2C review
must still run. Q208 / AC-211 real Windows reboot evidence remains pending and
must not be inferred from the Step 5 C2C `PASS`.

These changes remain within the approved `02-plan.md` scope. No GitHub write,
commit, push, PR, connector mutation, or Full Auto M1 change was performed.

## Remediation after post-implementation re-review (iteration 2)

The same bound C2C session returned a third `FIX_REQUIRED` verdict with four
in-scope findings. They were corrected before the next review:

1. Recovery operation failures now persist their checkpoint while the owning
   binding lock is still held. Lock-acquisition failures remain in-memory only,
   so a later recovery cannot be overwritten by a stale post-release write.
2. Capability attestations now carry and verify the exact binding ID, opaque
   protected-secret reference, and tunnel profile reference. Durable seeding
   rejects an attestation reused with another resource; provider adapters must
   prove ownership of the exact resources.
3. Owned uninstall removes subordinate state and binding-scoped temporary files
   before deleting the authoritative binding. An injected interruption leaves
   the binding available for provenance validation and a subsequent retry.
4. Atomic replacement has a fault-injection test proving an interrupted
   replacement leaves the prior complete document readable and cleans the
   temporary file before a later replacement.

The targeted recovery suite now has 20 passing tests. No GitHub write, commit,
push, PR, connector mutation, or Full Auto M1 change was performed.

## Remediation after post-implementation re-review (iteration 3)

The next C2C re-review identified five additional in-scope defects. They were
corrected before the next review:

1. Tunnel provider/profile ownership is now revalidated before recovery decides
   whether mutation is needed. An already healthy exact tunnel is reused without
   inspecting or resolving the protected secret; secret capability and exact
   secret-reference verification are required only for reconciliation.
2. The supervisor action now uses a UTF-16LE `-EncodedCommand` payload instead
   of wrapping the complete script in PowerShell single quotes. The generated
   action creates its user-local log directory, preserves the native exit code,
   and has a Windows execution test.
3. Supervisor installation now requires a validated recovery binding with
   `startupPolicy: user_logon`; the CLI validates the record against the
   authoritative ConnectionBinding before installing the task.
4. The protected-secret release contract explicitly requires idempotent
   already-absent success. A retry test covers an interruption after a
   P0-2-owned secret release and confirms the remaining state is removable.

The targeted recovery suite now has 23 passing tests. No GitHub write, commit,
push, PR, connector mutation, or Full Auto M1 change was performed.

## Remediation after post-implementation re-review (iteration 4)

The next C2C re-review found one remaining supervisor trust-boundary defect:
the exported installer accepted caller-asserted startup authorization. The
installer now independently loads and validates the recovery binding against
the authoritative ConnectionBinding and requires `startupPolicy: user_logon`
before any scheduler query or mutation. Direct tests cover missing and manual
bindings as well as the valid installation path. The targeted recovery suite
remains green with 23 passing tests.

No GitHub write, commit, push, PR, connector mutation, or Full Auto M1 change
was performed.

## C2C post-implementation review

The first existing-session review and its iteration-1 re-review both returned
`FIX_REQUIRED`; the listed remediation is complete and the required
validation is green for the new recovery tests, typecheck, build, CLI help,
and diff hygiene. The next action is the same bound Project chat review at
`P0_2_STEP5_POST_IMPLEMENTATION_C2C_REVIEW`. Before sending the bounded
re-review intent, the live ChatGPT model/reasoning setting must be inspected
and set to Extra High / 極高 if it has drifted. No source, Issue, branch, or
GitHub write is authorized by this artifact.

## C2C post-implementation review (final re-review, iteration 5)

The existing bound C2C session returned `PASS` after the five in-scope
remediation rounds. The reviewer verified the expected workspace/repository
and branch identity, the approved-plan scope, the current implementation
diff, the targeted validation evidence, and preservation of Full Auto M1.
No remaining `FIX_REQUIRED` implementation finding was reported.

The reviewer recorded these dispositions and limitations:

- Accepted low-risk Windows implementation dependency: the supported runtime
  relies on PowerShell `File.Replace`, Task Scheduler, and UTF-16LE encoded
  actions; the real reboot acceptance validates those host behaviors.
- Non-blocking production capability limitation: no supported protected-secret
  provider or Secure MCP Tunnel in-process adapter is available in this
  runtime, so the default path remains fail-closed and cannot yet prove
  end-to-end zero-touch tunnel recovery.
- Non-blocking host limitation: the full-suite subprocess probe still reports
  seven host `uv_os_get_passwd ENOMEM` failures before `tsx`; the targeted
  recovery suite, typecheck, build, CLI help, and diff hygiene remain green.
- Non-blocking acceptance limitation: the real Windows reboot proof has not
  yet been performed.
- Read-only review evidence used the authenticated `01-issue-snapshot.md`
  because the exact connector exposes no live GitHub Issue-read operation;
  no alternate connector was used.

The canonical next stage is Step 6 `PUSH_WAITING`: obtain explicit human
approval before any commit, push, or PR publication. The later Q208 / AC-211
acceptance must perform a real Windows reboot and verify startup recovery,
binding/endpoint identity, resource reuse, no credential re-entry or
re-pairing, and fixture sentinel lines 1 and 450. No GitHub write, commit,
push, PR, connector mutation, or Full Auto M1 change was performed.
