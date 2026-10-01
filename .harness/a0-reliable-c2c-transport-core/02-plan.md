# A0 amended implementation plan — Reliable C2C Transport Core

Workstream: `a0-reliable-c2c-transport-core`
Repository: `https://github.com/svl33333/codex-with-chatgpt`
Branch: `a0-reliable-c2c-transport-core`
Approved Issue: [#6](https://github.com/svl33333/codex-with-chatgpt/issues/6)
Source workspace commit: `13d13f0a05bfaa102394de7145607241d9da1c48`

This is the amended Step 3 implementation plan after the explicit Requirements
Human Gate approval of Q311 and A0-AC-024 through A0-AC-027. It does not
implement source, change the canonical workflow, publish the branch, or change
P0-2, Host Capability Broker, or Full Auto M1. Live Issue #6 and the approved
requirements artifact remain the requirements authority; this document proposes
implementation seams and tests for a fresh independent C2C review. The prior
`c2c_b7e2 / PASS` record below is retained as historical evidence for the
pre-Q311 plan and is not a review of this amended plan.

## 1. Current implementation and gap

The repository already has useful adapter-level foundations:

- `src/conversation/delivery.ts` derives a task/iteration/message idempotency
  key, writes a checkpoint, distinguishes confirmed/waiting/blocked outcomes,
  and reconciles accepted, in-progress, failed, and unknown remote states.
- `src/conversation/registry.ts` binds a Project, conversation, repository,
  work item, stage, and role, and rejects mismatched resumes.
- `src/connection/identity.ts` canonicalizes repository remotes, persists an
  installation identity, and records endpoint/connector binding metadata.
- `src/connection/reconciler.ts` checkpoints connector create/delete operations
  and verifies ownership and `workspace_info` before mutating a connector.
- `src/session/state.ts` persists Project/chat pointers and bounded protocol
  checkpoints, but its JSON writes are not an atomic transport-authority store.
- `src/config/paths.ts` provides owner-only JSON persistence but currently uses
  direct `writeFileSync`; it has no temp-file/rename transaction helper.
- `skill/SKILL.md` defines the IAB procedure and MCP-first rule, but the
  outbound procedure must be made durable across Codex context compaction and
  must enforce the send-time reasoning guard.
- `tests/reliability.test.ts` covers connector ownership/reconciliation,
  message idempotency, timeout/reasoning waits, and conversation identity, but
  not durable authorization, exact session/worktree binding, compaction
  rehydration, bounded reduction, or the shared Reviewer Skill contract.

The central gap is that the current delivery checkpoint can prove an event's
transport history but cannot itself authorize a send. Authorization, receipt,
session/checkpoint identity, and response consumption therefore need one
versioned, user-local, serialized transport state model used by the existing
delivery abstraction.

## 2. Proposed architecture and responsibility split

1. **Codex-side durable transport state** — add typed
   `C2cDeliveryAuthorization` and `C2cDeliveryReceipt`, linked to the existing
   `DeliveryCheckpoint` rather than creating a second delivery mechanism. The
   state is user-local, versioned, owner-protected, atomically persisted, and
   serialized per logical event.
2. **Codex C2C Skill/runtime** — keep the outbound procedure, IAB interaction,
   post-compaction rehydration, and live reasoning guard in the runtime-owned
   Skill/adapter boundary. DOM selectors remain in the browser/Skill layer.
3. **Shared ChatGPT-side C2C Reviewer Skill** — one optional shared reviewer
   procedure source (TeamAI shared-skill maintenance path if changes are
   required), covering bounded envelope recognition, MCP-first evidence order,
   output contract, fallback, and identity/stage checks. Skill presence never
   creates transport/workspace authority and no per-workspace copies are
   hand-maintained.
4. **Workspace MCP app** — remain an authenticated, read-only evidence plane.
   It does not mint authorization, mutate workflow state, or choose a target.
5. **ChatGPT Project/chat** — remain isolated per workstream. Exact binding,
   not display names or conversation memory, determines the review target.

## 3. Concrete changes by file/module

### 3.1 Durable state and atomic persistence

- `src/config/paths.ts`
  - Add a narrowly scoped atomic owner-only JSON writer: create a sibling
    temporary file, flush/close it, rename atomically, and clean up a failed
    temporary file without replacing a valid prior record.
  - Add a read/ownership helper that distinguishes missing, malformed, stale,
    and foreign-owner state. Existing non-transport callers retain their
    current behavior unless migrated explicitly.
- `src/conversation/authorization.ts` (new)
  - Define versioned `C2cDeliveryAuthorization` with workstream/task,
    checkpoint/stage, exact workspace/repository/worktree/branch/commit,
    Project/chat/Codex-session/MCP-app/connector identity, account/ownership
    binding, event key and payload hash, bounded intent metadata, expiry and
    revocation state, and schema version.
  - Define `C2cDeliveryReceipt` with a typed monotonic lifecycle:
    `PREPARED -> SENDING -> DELIVERED_VISIBLE -> RESPONSE_RECEIVED`, plus
    `WAITING_RESPONSE`, `RECONCILING`, `FAILED_DEFINITE`, `AMBIGUOUS`, and
    `BLOCKED` terminal/holding states with an explicit transition matrix.
    Persist process/session identity, exact observed Project/chat/app identity,
    remote message evidence, response key/hash and consumed-once marker,
    reasoning observation/correction evidence, byte/character counts,
    fragmentation/reduction evidence, reconciliation attempts, timestamps,
    and a bounded `nextAction`. Never persist tokens, cookies, pairing codes,
    raw source/diffs/logs, or unbounded page text.
  - Implement one narrow local transaction API used by the Codex Skill/runtime:
    `prepareAuthorizedDelivery`, `markSending`, `recordBrowserObservation`,
    `reconcileDelivery`, and `consumeReviewerResponse`. Each operation
    validates the canonical checkpoint/stage, exact binding, allowlisted
    message type, existing authority, event key, and payload hash before
    persisting the next transition. Do not expose arbitrary authorization
    minting as a diagnostic command. A malformed, stale, ambiguous, or
    foreign record fails closed; it never grants implicit authorization.
- `src/conversation/delivery.ts`
  - Extend `MessageIntent` and `MessageAdapter` at the seam needed to validate
    the authorization and exact remote conversation before `sendMessage`.
  - Have `deliverMessage` persist authorization/receipt transitions before
    IAB calls, use a workspace/workstream-scoped event key (not the current
    task/iteration/message-only key), reconcile a timeout by exact
    remote evidence, consume a substantive reviewer response once, and never
    blind-resend an ambiguous event.
  - Preserve the existing `CONFIRMED`/`WAITING`/`BLOCKED` outcome semantics and
    adapt legacy checkpoints through a versioned migration that does not mint
    authority from an in-memory or incomplete record.
- `src/session/state.ts`
  - Extend the durable checkpoint/session projection with the exact Codex
    session, Project/chat, MCP-app, repository/worktree, checkpoint, and stage
    references needed to rehydrate transport state. Keep text fields bounded.
  - On reconstruction, reload canonical workflow, current Skill/runtime
    contract, session/checkpoint, workspace/repository binding, authorization,
    receipt, and pending/ambiguous delivery before allowing the next event.
- `src/conversation/registry.ts`
  - Extend the binding key/value with exact session and worktree identity and
    the MCP-app/connector binding needed to reject stale checkpoint or review
    stage. Keep Project/chat display names non-authoritative and prohibit
    silent rebinding; use the supported recovery/HANDOFF path for rebinds.
- `src/connection/identity.ts`
  - Expose a stable worktree/repository identity projection (root, canonical
    remote, branch/observed commit, installation, endpoint fingerprint,
    connector) for authorization matching. Do not store credentials in it.

### 3.2 Bounded envelope and IAB adapter

- `src/conversation/envelope.ts` (new)
  - Build the allowlisted INIT/HANDOFF/PLAN/EXECUTED/REVIEW/re-review control
    envelope under the existing `<1 KB` intent. Apply deterministic reduction
    of identifiers, state, counts, hashes, checkpoint, stage, and MCP evidence
    pointers; never fragment and never paste source/diff/log bodies.
  - Return a payload hash used by authorization and receipt reconciliation.
- `src/conversation/iab-adapter.ts` (new interface/contract)
  - Define the narrow runtime boundary for one complete composer fill, one
    submit, live reasoning inspection/correction, visible remote-bubble
    evidence, and timeout versus definite-failure classification. DOM details
    remain in the Skill/browser implementation.
- `skill/SKILL.md`
  - Add the durable procedure: validate/reload all identity and authority
    records after Codex compaction/session reconstruction; inspect reasoning at
    send time and attempt Extra High/`極高` where supported; persist/reconcile
    before and after the single submit; stop safely on capability limits.
  - Keep MCP-first evidence retrieval and the no-pasted-content rule. Do not
    infer authority from chat history, reviewer Skill availability, or an
    acknowledgement-only response.

### 3.3 Read-only MCP and shared reviewer boundary

- `src/mcp/server.ts`
  - Preserve read-only workspace/evidence tools and sanitized output. If a
    transport-status projection is needed for diagnostics, expose only bounded
    identifiers/status/hashes; never expose authority secrets or add a write
    path. The MCP app cannot authorize a send or mutate workflow state.
- Shared Reviewer Skill source (TeamAI shared-skill maintenance path)
  - Define reusable recognition of bounded `[C2C]` review/re-review envelopes,
    exact workspace identity verification, MCP-first order (Issue → plan →
    repository/tests → recorded execution evidence), canonical structured
    verdicts, missing-evidence handling, FIX_REQUIRED without invented Human
    Gates, response binding to task/checkpoint/stage, and transport/review
    defect separation.
  - Use the same explicit bounded-instruction fallback when unavailable or
    unverifiable; never claim activation. Do not duplicate the canonical
    workflow version or create per-workspace copies. Plugin packaging remains
    future-compatible architecture, not an A0 prerequisite.

### 3.4 CLI/runtime integration

- `src/cli/index.ts`
  - Add only the minimal internal plumbing required to invoke the narrow
    transaction API from the runtime, read sanitized receipt state, and revoke
    an existing authority through an explicit verified recovery path. There is
    no generic `create authorization` capability and no public authority write
    path. Preserve workspace-scoped `-w` behavior and do not alter canonical
    workflow semantics.
    Preserve workspace-scoped `-w` behavior and do not alter canonical workflow
    semantics.
- `src/bridge/runtime.ts` / `src/bridge/server.ts`
  - Keep runtime identity and health checks authoritative for the active
    workspace. Wire the adapter without moving secrets or authority into the
    public MCP endpoint.

## 4. Data flow and state transitions

1. A canonical workflow action creates an allowlisted bounded envelope and
   deterministic event/payload hash.
2. Rehydration loads the pinned workflow, current runtime Skill contract,
   recorded workstream state, checkpoint, exact workspace/repository/worktree,
   exact Project/chat/session/MCP-app binding, authorization, receipt, and
   pending/ambiguous delivery. Any mismatch fails closed.
3. A validated authorization and `prepared` receipt are atomically persisted
   under an event-level lock. In-memory state alone never authorizes a send.
4. The send-time guard inspects/corrects reasoning where supported, fills the
   composer once, submits once, and observes the exact remote visible bubble.
5. The receipt records delivered/response-waiting evidence. A timeout performs
   remote reconciliation by exact chat/session/MCP/workspace/checkpoint/stage
   and event key/payload hash before any retry.
6. A substantive response bound to the expected event is consumed once. A
   stale, duplicate, incomplete, or wrong-stage response is retained as
   evidence and does not advance the workflow.
7. After CODEX context compaction, the same sequence begins at step 2. ChatGPT
   review-chat recreation is tested separately as reviewer resilience; it is
   not the remediation for the Codex transport defect.

## 5. Compatibility, migration, and failure handling

- Read existing `DeliveryCheckpoint`, `SavedSession`, connection binding, and
  conversation registry records through a versioned compatibility layer. A
  readable legacy checkpoint may identify an event, but cannot authorize a
  send until a complete exact binding is reconstructed.
- Preserve existing connector, Project, chat, tunnel, P0-2, Host Broker, and
  Full Auto M1 resources. Reuse a verified binding with zero connector
  mutations; never silently create a replacement or rebind by display name.
- On atomic-write failure, ownership conflict, malformed state, identity
  mismatch, unsupported reasoning inspection, missing remote evidence, or
  ambiguous timeout, return the existing waiting/blocked result with sanitized
  diagnostics. Do not blind-resend or introduce a new Human Gate for ordinary
  model/reasoning drift.
- Migration/rollback is namespaced and ownership-aware. Preserve readable
  legacy files, write a new schema version beside them only after validation,
  and fail closed on ambiguous legacy data. Rollback must not delete unrelated
  connectors or workflow state.

## 6. Security, privacy, and concurrency

- Store state in the existing user-local state directory with owner-only
  permissions, atomic replacement, schema validation, and bounded fields.
- Bind authorization to exact workstream, repository/worktree, branch/commit,
  installation/endpoint/connector, Project/chat/session/MCP-app, task,
  checkpoint, stage, event key, and payload hash. Display names, memory, or
  Skill presence are not authority.
- Serialize one event key at a time and make transitions monotonic. A process
  restart or context compaction replays reconciliation, not a second send.
- Keep MCP read-only and diagnostics sanitized. Never log or expose OAuth
  tokens, cookies, pairing codes, bearer headers, raw source/diffs/logs, or
  unbounded page text.

## 7. Tests and regression coverage

### Deterministic unit/integration coverage

- Extend `tests/reliability.test.ts` or split focused suites for authorization
  lifecycle, atomic persistence/ownership, event serialization, exact identity
  mismatch, migration, idempotency, timeout reconciliation, and one-time
  response consumption.
- Add issuer tests proving that only a canonical workflow action can issue an
  event-scoped authorization: unauthorized callers, wrong stage/type,
  incomplete Human Gate, stale checkpoint, and duplicate issuance fail closed
  or reuse the same authority.
- Add a receipt-transition table test covering `SENDING -> AMBIGUOUS /
  RECONCILING`, reconciliation outcomes, guarded same-event retry only after
  proven `FAILED_DEFINITE`, and restart during `SENDING` without a second
  submit.
- Add envelope tests for the `<1 KB` deterministic reduction, payload hashes,
  no fragmentation, and MCP evidence pointers.
- Add rehydration tests that force CODEX context compaction/session
  reconstruction between repeated sends and verify authority reload plus one
  atomic outbound event. Keep this separate from ChatGPT review-chat
  recreation tests.
- Add adapter contract fixtures for reasoning inspection/correction, visible
  bubble evidence, timeout/definite-failure classification, and no DOM
  assumptions in the TypeScript seam.
- Add shared Reviewer Skill and bounded fallback fixtures with equivalent
  structured output, missing evidence, wrong workspace, wrong checkpoint/stage,
  two workstreams sharing one Skill, recreated review chat, and unavailable or
  unverifiable Skill.
- Add an AC-018 bootstrap state-machine fixture covering worktree -> local
  setup -> app create/reuse -> OAuth/pair -> Project/chat -> `workspace_info`
  -> `WORKSPACE_READY`, healthy-binding reuse, no duplicate creation/endpoint
  churn, and no acknowledgement-only relay gate. This fixture belongs to the
  existing setup/provisioning/Skill integration; it does not implement Full
  Auto M1.

### Live acceptance coverage

- Run repeated sends in the exact A0 Project/chat/MCP binding, including forced
  CODEX context compaction/session reconstruction, durable rehydration, atomic
  delivery, timeout reconciliation, response de-duplication, reasoning guard,
  and genuine Human Gate preservation.
- Verify that live Skill-backed and explicit-fallback reviews use MCP-first
  evidence and the same response contract. Record actual capability limits;
  fixtures alone do not prove live browser behavior.
- Preserve A0-AC-002 and A0-AC-012 as CODEX context-compaction/session-
  reconstruction tests and retain A0-AC-019 through A0-AC-023 as the Reviewer
  Skill criteria. Do not add Q-IDs or renumber Q301-Q310.

## 8. Implementation order

1. Add atomic state primitives and typed authorization/receipt schemas with
   focused deterministic tests.
2. Extend exact identity/session/registry projections and migration checks.
3. Integrate authorization and receipt transitions into `delivery.ts`, then
   add timeout/response reconciliation and serialization tests.
4. Add bounded envelope construction and the narrow IAB adapter contract.
5. Update the runtime-owned Codex C2C Skill for rehydration and reasoning guard;
   maintain any shared Reviewer Skill through its canonical TeamAI source.
6. Add CLI/diagnostic projections and MCP-safe evidence/status handling.
7. Run typecheck, deterministic suite, and the documented live A0 matrix;
   record results without pasting logs into C2C.

## 9. Regression risks and observability

- Risk: changing delivery checkpoints could resend old events. Mitigate with
  schema migration tests, monotonic receipt transitions, and a forced-restart
  matrix.
- Risk: an identity field is omitted during rehydration. Mitigate with a
  table-driven mismatch test for every binding dimension and exact A0 live
  verification.
- Risk: atomic replacement behaves differently on Windows. Exercise temp-file
  cleanup, concurrent writers, ownership checks, and recovery from a torn
  write on the supported Windows runtime.
- Risk: reviewer procedure is mistaken for authority. Keep Skill/fallback
  verdicts and transport authorization separate in types, logs, and tests.
- Diagnostics should expose only event key/hash, state, checkpoint/stage,
  bounded attempts, timestamps, and sanitized remote evidence; metrics should
  distinguish transport defects from review correctness.

## 10. Known limitations and non-requirements

- Live reasoning inspection/correction and visible remote-bubble evidence are
  browser/product capabilities; when unavailable, the implementation records
  the limitation and fails safely.
- ChatGPT-side shared Skill packaging may vary by account/product/workspace;
  A0 must preserve the bounded explicit fallback and must not make transport
  depend on Skill availability.
- This plan does not change the pinned `codex-c2c-v2` workflow, create a new
  Human Gate, implement source now, publish the branch, or modify unrelated
  workstreams.

## 11. C2C plan-review revision (iteration 0 findings addressed)

The independent A0 C2C review returned `STATE: PLAN` with
`PLAN_REQUIRES_REVISION_BEFORE_IMPLEMENTATION`. The following amendments are
part of this plan and are required before any source implementation begins.

### 11.1 Explicit authority issuer and Skill-to-runtime transaction

The runtime-owned Codex C2C Skill is the only caller of the local transport
transaction API. A canonical-workflow issuer in the Codex harness (the
workflow action executor, not the CLI, MCP, Project/chat, or Reviewer Skill)
accepts an allowlisted envelope, the current checkpoint/stage, and the exact
`TransportBindingIdentity`. It verifies that the pinned workflow permits that
event at the current stage, that any required genuine Human Gate is complete,
and that the event is not already issued. It then creates exactly one
event-scoped `C2cDeliveryAuthorization`, persists its source checkpoint and
creation metadata, and returns the authority reference to the runtime Skill.
Verified HANDOFF/rebinding uses this same issuer after the new exact identity
has been proven; routine retries never mint a second authority.

The Skill calls the local transaction API with that issuer-produced reference.
The API validates the current checkpoint/stage, exact binding, allowlisted
message type, authority ownership, event key, and payload hash before returning
a send-permitted `PREPARED` event. It then owns the serialized
`PREPARED -> SENDING -> observation/reconciliation` sequence.

No CLI diagnostic, MCP tool, Project/chat prose, Reviewer Skill, or arbitrary
caller can mint an authorization. Unauthorized issuers, wrong workflow
stage/type, incomplete Human Gate, stale checkpoint, or duplicate issuance
fail closed; duplicate issuance for the same logical event returns the
existing authority. Ordinary retry reuses that same logical event and
authority.

### 11.2 Workspace-scoped event identity and collision behavior

The current task/iteration/message-only idempotency key is insufficient. The
new immutable logical event key includes, at minimum, `workspaceId`,
workstream/repository identity, task/checkpoint/stage, allowlisted message
type, iteration, and logical message ID. Storage is namespaced by that key.
The payload hash is stored separately; a same-key/different-payload attempt
fails closed and cannot overwrite or create a second event. Migration keeps
legacy records readable but never treats their unscoped key as authority.

### 11.3 Receipt schema and legal transitions

`C2cDeliveryReceipt` is versioned and monotonic. The implementation plan must
define and test these transitions before storage shapes are selected:

The legal transition matrix is explicit:

`PREPARED -> SENDING -> DELIVERED_VISIBLE -> WAITING_RESPONSE ->
RESPONSE_RECEIVED`; `SENDING -> AMBIGUOUS -> RECONCILING`; and
`RECONCILING -> DELIVERED_VISIBLE | FAILED_DEFINITE | BLOCKED`.
Only a proven pre-accept failure may take the guarded
`FAILED_DEFINITE -> SENDING` edge, and only when `nextAction` is
`SAFE_RETRY_SAME_EVENT` and the bounded attempt policy permits it. An
`AMBIGUOUS` receipt never takes a retry edge; it must reconcile first. A
lease/process restart while `SENDING` enters `RECONCILING`, never a second
blind submit. `RESPONSE_RECEIVED` carries a consumed-once marker; a duplicate
substantive response is recorded as evidence and cannot advance again.
Submission success alone never means delivered: a visible remote bubble with
matching event and payload evidence is required. The receipt records
process/session identity, observed Project/chat/MCP-app identity, remote
IDs/hashes, reasoning observation/correction, reduction counts, fragmentation
result, attempts, timestamps, reconciliation history, and bounded
`nextAction`.

### 11.4 Concrete coverage for current Plugins/MCP app and readiness phases

The plan now explicitly owns the approved A0-AC-014..018 compatibility seam:

- `skill/SKILL.md` and the runtime UI adapter start from the semantic
  `Plugins -> Add/+ -> Create MCP app` surface (Japanese and English labels),
  using a verified legacy deep link only as bounded fallback.
- `tests/skill-contract.test.ts` and `tests/localization.test.ts` cover
  semantic capability discovery, aliases, missing/stale legacy routes,
  bounded recovery, healthy binding reuse, no duplicate app/endpoint churn,
  and cross-workspace mutation rejection.
- `src/provisioning/state.ts` and `tests/provisioning-state.test.ts` project
  `LOCAL_RUNTIME_READY`, `MCP_BINDING_READY`, `REVIEW_SESSION_READY`, and
  `WORKSPACE_READY` while preserving compatible legacy phase output. A paired
  app with a missing Project/chat remains MCP-ready but not session/workspace
  ready; final `WORKSPACE_READY` requires exact in-chat `workspace_info`.

The live A0 test records the current surface and exact final-chat evidence;
fixtures do not claim browser success.

### 11.5 Cross-process serialization and crash consistency

The event lock is not the existing module-local promise map. The transport
store will use a cross-process ownership/CAS primitive with owner, lease,
generation, and bounded stale-lock recovery. Atomic JSON replacement uses a
same-directory temporary file, flush/close, safe replacement, cleanup, and
platform-specific durability checks; every failure preserves the last valid
record. Deterministic tests cover two processes, concurrent response
consumption, each crash point, torn writes, stale-lock recovery, and supported
Windows behavior.

### 11.6 One complete binding projection

Define one immutable `TransportBindingIdentity` projection and comparator for
workspace ID/name/root, canonical repository/worktree/branch, observed commit
and dirty-state evidence, installation/endpoint/MCP-app identity,
Project/chat/Codex-session identity, task/checkpoint/stage, and event key.
Classify mutable commit/dirty state as event-time evidence rather than silently
making it a long-lived connection identity. The harness is the source of a
Codex-session ID; the implementation must never manufacture one. Add a
table-driven mismatch test for every dimension and reject stale checkpoint or
review-stage reuse.

### 11.7 Shared Reviewer Skill isolation

The A0 repository contains only the transport-facing contract/fixtures and
bounded fallback tests. It does not create a hand-maintained per-workspace
Reviewer Skill copy or mutate the TeamAI repository during implementation.
Any shared Skill change is a separate `shared-skill-maintainer` workstream
against the canonical TeamAI source. Skill availability remains orthogonal to
transport authorization; both Skill and explicit fallback must produce the
same structured reviewer disposition.

### 11.8 Bridge and public MCP boundary

`src/bridge/runtime.ts` remains ephemeral (including its admin token), and
`src/mcp/server.ts` remains authenticated read-only. Bridge wiring may invoke
the local transaction API only behind the existing loopback/admin boundary;
authority/receipt state is never placed in bridge runtime state or exposed as
a public MCP write capability.

### 11.9 Canonical workflow state ownership

The pre-Q311 canonical state was Step 3 / `Implementation Plan + C2C Review`
with checkpoint `c2c_b7e2`; that review is historical and superseded by the
approved amendment. The current amended plan remains Step 3 and must receive a
new independent pre-implementation C2C verdict. This plan does not edit
workflow status merely to satisfy the review. After the amended plan is
reviewed and accepted by the canonical workflow, the harness will set the
current Step 3 status/verdict/checkpoint together and select the next Human
Gate. No source implementation starts while that transition is ambiguous.

### 11.10 Upstream Skill comparison gate

Before editing `skill/SKILL.md`, compare the requirements-mandated upstream
Skill `main` for current Plugins/MCP-app terminology and UI fixes. Reuse only
compatible changes while preserving local `svl` behavior; record the compared
revision and rationale in the plan. This is a planning prerequisite, not a
request to replace the pinned local Skill wholesale.

Implementation record: the available local `upstream/main` reference was
compared at `8fdd97c188c7678d0d9c43b3769b426940de568a` (2026-09-11). A network
refresh was unavailable in the restricted credential context, so no unverified
upstream changes were imported. The local Skill keeps its pinned `svl`
terminology and adds only the approved durable transport/recovery guard:
reload exact identity and receipt state after reconstruction, require visible
remote evidence and reconciliation before retry, inspect reasoning at send
time, and delegate GitHub authentication classification/security boundaries to
the dynamically resolved TeamAI `github-cli-auth` capability.

## 12. Revised implementation and test ownership matrix

| Concern | Planned owner | Required proof |
| --- | --- | --- |
| Authority issuer and Skill transaction | `authorization.ts`, runtime-owned Skill/adapter | missing/stale/foreign/revoked authority fails before browser send |
| Workspace-scoped event key | `delivery.ts`, transport store | same logical IDs in two workspaces never collide or cross-consume |
| Receipt lifecycle | `authorization.ts` + `delivery.ts` | typed transition matrix, visible-bubble requirement, consumed-once response |
| Atomic/CAS state | `paths.ts` + transport store | concurrent writers, crash points, stale lease, Windows recovery |
| Binding projection | `identity.ts`, `registry.ts`, `session/state.ts` | one table-driven mismatch case per identity dimension |
| Plugins/MCP compatibility | `skill/SKILL.md`, provisioning state, UI-contract tests | AC-014/015 semantic discovery, aliases, bounded stale-route recovery |
| Readiness separation | `provisioning/state.ts` | AC-016/017 phase projection and exact final-chat verification |
| Future bootstrap ordering | existing setup/provisioning/Skill orchestration (not Full Auto coordinator) | AC-018 ordered worktree → local setup → app reuse/create → OAuth/pair → Project/chat → `workspace_info` → `WORKSPACE_READY`, with no relay-ack gate |
| Reviewer Skill/fallback | shared contract fixtures, explicit fallback | AC-019..023 equivalence, wrong target/stage rejection, no authority |
| Codex compaction | session/transport rehydration | repeated sends after forced compaction/session reconstruction |
| Bridge/MCP security | bridge boundary + read-only MCP | no authority/secrets in public tools or ephemeral runtime |

The revised implementation order is therefore: freeze the authority issuer and
identity/receipt contracts; specify cross-process atomicity and migration;
implement durable state; integrate delivery/reconciliation; add envelope and
IAB seams; integrate session/provisioning phases and current Plugins path;
update runtime Skill behavior after upstream comparison; then run deterministic
and live A0 matrices. Shared Skill maintenance, if any, remains separate.

The AC-018 proof is a deterministic setup/provisioning state-machine test
owned by the existing bootstrap integration. It verifies the ordered sequence,
healthy exact-app reuse, no duplicate creation or endpoint churn, and that
acknowledgement-only relay prompts are never introduced. Production Full Auto
M1 remains out of scope.

> Historical review boundary: the following C2C summary records the prior
> pre-Q311 plan only. Its checkpoint and PASS verdict are retained unchanged as
> evidence and must not be interpreted as approval of this amended plan.

## C2C Review Summary

- TASK_ID: `c2c_b7e2`
- ITERATION: 2
- CHECKPOINT: `c2c_b7e2`
- REVIEW_STAGE: `pre_implementation`
- WORKFLOW_STEP: 3
- WORKFLOW_STAGE: `Implementation Plan + C2C Review`
- WORKSPACE_ID: `f5dc2ee0d7ba`
- WORKSPACE: `codex-with-chatgpt-a0-reliable-c2c-transport-core`
- BRANCH: `a0-reliable-c2c-transport-core`
- REVIEW_VERDICT: `PASS`
- REVIEW_RESULT: The independent ChatGPT review found no remaining plan-level FIX_REQUIRED finding. It accepted the canonical-workflow authority issuer, complete receipt transition/retry matrix, AC-018 bootstrap ownership/test boundary, current Step 3 state wording, exact workspace binding, Reviewer Skill/fallback separation, and the required deterministic/live test coverage.
- SOURCE_IMPLEMENTATION: none; the tracked source diff remained empty during this review.
- NEXT_CANONICAL_ACTION: create the visual/direct plan review and await the Step 4 Human Gate. No implementation begins before that gate.

HISTORICAL_PLAN_READY_FOR_VISUAL_REVIEW

### Current amended-plan review attempt — `c2c_9d4e` iteration 1

- REVIEW_STAGE: `pre_implementation`
- REVIEW_VERDICT: `FIX_REQUIRED`
- Finding history: the rebound exact A0 MCP review confirmed the binding and
  found two plan-level defects. The credential-context classifier was placed
  in an A0 adapter instead of being returned by the dynamically resolved TeamAI
  `github-cli-auth` capability, and remote reconciliation was not specific
  enough to prove acceptance for each heterogeneous GitHub operation. Both
  findings are remediated below within the approved Q311 scope; no source
  implementation started.
- Evidence limitation retained: the exact A0 MCP surface exposes no live
  GitHub-Issue retrieval tool, so the review did not substitute another
  connector. The local Issue reconciliation record and the live Issue URL
  remain preserved as separate evidence.

### Current amended-plan review result — `c2c_9d4e` iteration 2

- REVIEW_STAGE: `pre_implementation`
- REVIEW_VERDICT: `PASS`
- CHECKPOINT: `c2c_9d4e`
- The independent review confirmed that the remediation makes TeamAI
  `github-cli-auth` the sole authentication and credential-context classifier,
  keeps A0 to bounded observations and workflow consequences, and defines
  operation-specific exactly-once evidence for Issue, push, PR, review, and
  publication writes. Ambiguous evidence remains non-retryable and
  same-key/different-payload attempts fail closed.
- The review also confirmed that the rebound exact A0 binding matches workspace
  `f5dc2ee0d7ba`, branch `a0-reliable-c2c-transport-core`, and HEAD `13d13f0`,
  that no tracked source implementation has started, and that P0-2 / PR #4,
  Host Capability Broker, Full Auto M1, unrelated TeamAI work, and the pinned
  workflow remain unchanged.
- The exact A0 MCP still exposes no live GitHub-Issue retrieval tool; this
  evidence limitation is recorded without substituting another connector. The
  live Issue URL and local reconciliation record remain preserved.
- NEXT_CANONICAL_ACTION: present `02-plan.md` for the Step 4 direct plan
  approval Human Gate. No source implementation begins before explicit
  approval.

## 13. Approved Q311 amendment — GitHub authentication interruption resilience

### 13.1 Scope and ownership contract

Q311 and A0-AC-024 through A0-AC-027 are now approved requirements from the
Requirements Human Gate and are present in live Issue #6. This section is the
amended Step 3 design contract; it does not authorize source changes before the
new Step 4 Human Gate.

- TeamAI `github-cli-auth` remains the canonical and dynamically resolved owner
  of GitHub authentication classification, device-flow and browser interaction,
  connected-mail verification, credential-context handling, and authentication
  security boundaries. A0 references the capability contract and must never
  copy the Skill body or implement a second auth procedure.
- A0 owns only the workflow dependency around that capability: detect an
  interrupted authorized operation, preserve bounded recovery state, correlate
  the existing logical operation and auth attempt, reconstruct after compaction
  or session loss, reconcile the remote result, and continue exactly once after
  credential health is verified. The original workflow authorization remains
  authoritative; successful authentication never authorizes a new unrelated
  Issue, push, PR, review, or publication operation.
- CAPTCHA, unsupported 2FA, password/account recovery, wrong or ambiguous
  account, unexpected SSO/organization approval, unexpected scope or privilege
  expansion, and ownership/security-sensitive changes remain genuine
  human/security boundaries. Supported normal device flow, verified
  `Continue as <expected account>`, and unambiguous ordinary email verification
  may be automated where the TeamAI capability and product surface support it.

### 13.2 Planned seams and durable recovery record

The implementation extends the existing delivery/session design rather than
creating a parallel transport:

| Concern | Planned seam | Contract |
| --- | --- | --- |
| Recovery substate | `src/conversation/authorization.ts` and `src/conversation/delivery.ts` | Versioned, event-scoped auth/recovery record linked to the existing receipt; no generic authority minting. |
| Capability resolution | Runtime-owned Skill/adapter boundary, with a narrow typed resolver interface | Resolve the current TeamAI `github-cli-auth` capability at recovery time; verify version/source identity and fail closed if unavailable. |
| Credential context | Runtime-owned resolver call into the dynamically resolved TeamAI `github-cli-auth` capability; A0 adapter supplies bounded observations only | TeamAI returns the authentication/credential-context classification. A0 must not classify `hosts.yml: Access is denied`, keyring visibility, or any other observation locally; it verifies health through the narrowest supported credential-visible context and then owns only workflow consequences. |
| Logical operation | Existing workflow action plus a durable operation/event key | Keep workstream, repository/worktree, Issue/PR/publication target, checkpoint/stage, payload hash, and attempt correlation stable across recovery. |
| Reconstruction | `src/session/state.ts` plus transport state | Reload pinned workflow, checkpoint, exact binding, TeamAI capability, auth substate, receipt, and remote evidence before any new flow or retry. |
| Remote reconciliation | Delivery/operation adapter | Query exact Issue/push/PR/review/publication evidence before retrying an ambiguous result; never blind-resend. |
| Persistence | `src/config/paths.ts` atomic owner-only state primitive | Bounded non-secret JSON, atomic replacement, ownership/CAS checks, and crash-safe recovery. |

The recovery record contains only bounded non-secret evidence: logical
operation/event identity; workstream, repository, worktree, host and expected
account; checkpoint/stage; safely observable auth-attempt/process/session
correlation; credential-context and recovery classification; timestamps and
bounded attempts; remote reconciliation evidence; and a bounded next safe
action. It never contains device or email codes, OAuth tokens, cookies, bearer
headers, keyring secrets, or raw authentication email/content.

The proposed local lifecycle is:

`AUTHORIZED_OPERATION_PREPARED → INTERRUPTED_AUTH_PENDING →
AUTH_CONTEXT_RECONCILING → TEAMAI_RECOVERY_ACTIVE → AUTH_HEALTHY →
REMOTE_RECONCILING → RESUME_ONCE → COMPLETED`.

Holding/terminal outcomes are `WAITING_HUMAN_SECURITY_BOUNDARY`,
`FAILED_DEFINITE`, and `BLOCKED`. `INTERRUPTED_AUTH_PENDING` and
`TEAMAI_RECOVERY_ACTIVE` are recovery substates, not new canonical workflow
stages. A restart, compaction, timeout, or lost process observation always
enters reconciliation first. `RESUME_ONCE` is guarded by the same immutable
operation/event key and a consumed-once marker; a duplicate callback or stale
auth attempt records evidence and cannot advance the operation again.

### 13.3 Credential-context classification and recovery flow

1. Before any recovery, reload the canonical workflow, A0 checkpoint, original
   operation authorization, exact repository/worktree and GitHub target, and
   the current TeamAI capability contract.
2. Pass only bounded observations (for example, the restricted-context error,
   supported credential-visible verification result, expected account, and
   capability version) to the dynamically resolved TeamAI
   `github-cli-auth` capability and require its typed classification result.
   The result contract is one of `healthy`, `credential_context_unavailable`,
   `auth_invalid_or_expired`, `human_security_boundary`, or
   `capability_unavailable`, with bounded correlation/version evidence. A
   restricted sandbox that cannot read the OS keyring or `hosts.yml` becomes a
   credential-context mismatch only when TeamAI returns that classification
   after the supported credential-visible check verifies the expected account;
   the text `hosts.yml: Access is denied` alone never causes an A0-local auth
   decision or a device-flow loop.
3. If the credential-visible check shows healthy authentication, record the
   context evidence and reconcile the original remote operation; continue only
   if the original operation is still pending and its authorization/binding
   matches.
4. If the credential is genuinely invalid or expired, delegate the supported
   recovery path to the dynamically resolved TeamAI capability. A0 persists
   only correlation and bounded progress, not the procedure, codes, or secrets.
5. Automate only the supported normal device flow, expected-account
   continuation, and unambiguous ordinary mail verification. Stop at the
   genuine security boundaries listed in 13.1.
6. After health is restored, reconcile the remote target first. Mark the
   original operation complete when evidence proves it already happened;
   otherwise resume the same operation once with the same idempotency key.

### 13.4 Exactly-once and remote reconciliation rules

- Issue creation, Issue update/publication, push, PR creation/update, review,
  and other GitHub writes use one durable operation key and payload hash. A
  same-key/different-payload attempt fails closed.
- Persist `prepared` and `sending` before the external call; on timeout or
  process loss, use `reconciling` and query the exact remote target, account,
  repository, checkpoint/stage, and idempotency evidence before any retry.
- A proven pre-accept failure may retry the same operation only under the
  bounded retry policy. An ambiguous result never takes a blind retry edge.
- Duplicate Issue, push, PR, review, publication, or authentication attempts
  are prevented across compaction, session reconstruction, browser reconnect,
  credential-context switching, and process restart. A successful auth result
  cannot be consumed by a different operation.
- Reconciliation uses an operation-specific evidence contract rather than a
  generic local idempotency key. For each operation, the adapter persists only
  bounded discriminators and the minimum remote proof needed to distinguish
  already-accepted, definitely-not-accepted, and ambiguous outcomes:
  - **Issue create:** durable target discriminator plus the resulting Issue
    number/URL and a verified title/body/labels (or deterministic marker) hash.
  - **Issue update/publication:** exact Issue identity plus the expected
    revision, body/state hash, or uniquely matchable publication marker.
  - **Push:** exact remote ref and expected commit SHA; a ref mismatch is not
    accepted as success.
  - **PR create:** repository plus head/base refs and expected head SHA,
    matched to the resulting PR number/URL; multiple candidates remain
    ambiguous.
  - **PR update:** exact PR identity plus expected mutation/revision or
    payload hash.
  - **Review/comment/publication:** exact target identity plus a durable
    operation marker or uniquely matchable remote identity/status/revision.
    If the remote surface cannot provide sufficiently unique evidence, the
    result remains ambiguous and cannot be retried blindly.
  Same-key/different-payload attempts fail closed, and every operation uses the
  same timeout-after-success, definite pre-accept failure, ambiguous-candidate,
  restart/compaction, and duplicate-continuation rules.
- Reconciliation evidence is bounded to the operation-specific remote
  discriminators, IDs, statuses, hashes, timestamps, and classification; raw
  API responses, tokens, and email bodies are excluded from durable state and
  diagnostics.

### 13.5 Required deterministic and live coverage

The deterministic adapter/transaction suites must cover the seventeen cases in
requirements Section 18.5, including healthy/no-recovery, genuine expiry and
TeamAI delegation, supported device flow, expected-account continuation,
ordinary email verification, credential-context mismatch and `hosts.yml`
denial, compaction/session reconstruction, same-attempt recovery, exactly-once
continuation, ambiguous remote reconciliation, duplicate Issue/push/PR
prevention, stale auth-attempt suppression, missing TeamAI capability,
dynamic Skill re-resolution, secret exclusion, and human-only security
boundaries. Add table-driven tests for every operation target and for every
receipt/recovery transition. In particular, prove that A0 cannot turn the
`hosts.yml: Access is denied` text into a local credential-context verdict;
the same observation is classified only through the TeamAI capability result,
and an unavailable/unverifiable capability fails closed. For every Issue,
push, PR, review, and publication operation, cover timeout-after-success,
definite pre-accept failure, same-key/different-payload, ambiguous or multiple
remote candidates, exact operation-specific evidence, restart/compaction, and
duplicate callback/continuation.

Live acceptance remains separate and uses the exact A0 Project/chat/MCP
binding. It must verify credential-visible classification, supported TeamAI
recovery where available, remote reconciliation, one continuation after
reconstruction, and preserved human/security boundaries. A fixture or a
successful authentication alone does not prove a live GitHub write.

### 13.6 Implementation order, migration, and rollback

1. Freeze the typed recovery/operation contract and atomic owner-only storage;
   add non-secret schema, ownership, crash, and migration tests.
2. Add the narrow TeamAI capability resolver and pass-through observation
   contract; test dynamic source/version re-resolution without copying the
   Skill or reproducing its credential-context classification logic.
3. Integrate interruption and reconciliation substates with `delivery.ts`,
   session reconstruction, and the existing receipt/idempotency machinery.
4. Add GitHub-operation adapters for Issue/push/PR/review/publication evidence
   and exact-once continuation; keep external interaction behind injected
   interfaces.
5. Add deterministic and live coverage, sanitized diagnostics, and rollback
   checks. Preserve readable legacy records but never mint authority from an
   incomplete legacy record; rollback never deletes unrelated resources.

P0-2 / PR #4, Host Capability Broker, Full Auto M1, the pinned
`codex-c2c-v2` workflow, and unrelated TeamAI work remain out of scope. Any
future TeamAI Skill change is a separate canonical TeamAI workstream, not an
A0 source edit.

### 13.7 Current review handoff

The live Issue #6 reconciliation and this amended `02-plan.md` were the only
requirements/plan inputs for the completed independent pre-implementation C2C
review. The historical `c2c_b7e2 / PASS` summary above remains superseded
evidence; `c2c_9d4e` iteration 1 is retained as `FIX_REQUIRED`, and iteration
2 is recorded as `PASS` in this plan and in state. The Step 4 direct-plan Human
Gate was explicitly approved at `2026-10-01T08:51:47Z`, after which Step 5
implementation began.

### 13.8 Post-implementation review status

The approved implementation is complete locally and remains unpublished. The
bounded post-implementation C2C review uses logical checkpoint `c2c_bc5c`.
Iteration 0 returned `FIX_REQUIRED`. Iteration 1 also returned `FIX_REQUIRED`
for canonical-state issuer binding, TeamAI capability provenance,
logical-operation-only keys and operation serialization, distinct
non-confirmed waiting, executable runtime wiring, target identity proof, and
integration coverage. Autonomous remediation is limited to the source,
durable transport records, session/registry identity projection, CLI recovery
surface, Skill seam documentation, and deterministic tests. The remediation
preserves the same operation/event keys, verifies the actual Step 5 state and
authorized action, accepts only branded TeamAI capability results, serializes
operation records under an owner-checked lease with generation, requires exact
visible-bubble evidence before response consumption, and exposes bounded
prepare/deliver/observe/auth-observe/reconcile/response phases. The same
logical checkpoint's iteration 2 returned `FIX_REQUIRED` for active-workspace
authority derivation, TeamAI provider provenance, and stale-owner operation
lease/CAS protection. The bounded third remediation derives workstream,
checkpoint, and stage from the active workspace's harness state, binds a
GitHub operation identity to the canonical action event, requires a branded
provider module resolved from the TeamAI `github-cli-auth` Skill boundary,
and refuses to reclaim a live owner's old operation lease while using a
generation compare-and-swap on rehydration. Focused validation is rerun before
the same logical checkpoint's iteration-3 review through the exact A0
Project/chat. No commit, push, PR, publication, or GitHub reauthentication is
authorized in Step 5.

Iteration 3 returned `FIX_REQUIRED` for the remaining caller-controlled
action/event identity and optional exact-binding dimensions, missing exact
repository proof for push and authoritative-absence reconciliation, and the
absence of live-owner/competing-process and CLI provenance regression tests.
The bounded fourth remediation now derives the complete binding and
deterministic action/event identity from the active harness, rejects
caller-selected Step 5 actions, requires repository evidence for push and
definite absence, and adds the required lease/concurrency coverage. Typecheck
and build pass; the focused six-file suite passes 51 tests and the broader
suite records 230/237 with the same seven host-limited `uv_os_get_passwd:
ENOMEM` CLI subprocess cases. The same logical checkpoint's iteration-4 review
returned `PASS` through the exact A0 Project/chat. No commit, push, PR,
publication, or GitHub reauthentication occurred.

The implementation is complete locally and remains unpublished. The user
explicitly approved the Step 6 Push/PR publication Human Gate at
2026-10-01T11:14:48Z. Commit, push, and one A0 pull-request publication are
authorized; merge approval is not included.

PUSH_PR_PUBLICATION_AUTHORIZED
