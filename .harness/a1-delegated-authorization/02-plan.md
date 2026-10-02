# A1 Delegated Authorization — Step 3 implementation plan

Status: `FINAL — terminal C2C PASS; Step 4 plan approved`

This is the final Codex-owned Step 3 implementation plan for [Issue #8](https://github.com/svl33333/codex-with-chatgpt/issues/8).
It incorporates the approved action-specific provider-boundary redline and
the plan-only remediations through terminal C2C `PASS` at checkpoint
`c2c_2e0a`, iteration 5. The Step 4 Direct plan-approval Human Gate is
approved; implementation may proceed only within this plan and Q401–Q414
scope.

## 1. Workstream identity and evidence boundary

| Field | Verified value |
|---|---|
| Repository | `svl33333/codex-with-chatgpt` |
| Issue | `#8`, `https://github.com/svl33333/codex-with-chatgpt/issues/8` |
| Workstream | `a1-delegated-authorization` |
| Branch | `a1-delegated-authorization` |
| Worktree | `C:\Projects\ai-agent-harness-setup\work\codex-with-chatgpt-a1-delegated-authorization` |
| Base / current HEAD | `release/v0.1.3-svl.13` / `b36a38cdd613ef474460e2ebc4a62180a93e99c7` |
| Workflow contract | `codex-c2c-v2` 2.3.1, commit `60d17218c256098522e063b5bf4731cecc9c1f12` |
| Review contract | `schema/c2c-review-contract.json`, contract version `2.3.1` |
| Requirements | Q401–Q414 explicitly approved; no open Q-ID |
| Source baseline | A0 durable C2C transport is present in the release base |

The live Issue is the requirements source of truth. The approved requirements
artifact remains `.harness/a1-delegated-authorization/00-requirements-working.md`.
The local source and tests were read at the verified HEAD. No pasted source,
diff, or log is intended for the C2C reviewer; the reviewer must fetch the live
Issue and these files through the read-only connector.

## 2. Baseline verification

- `pnpm typecheck` passed at the verified HEAD.
- `pnpm test` ran 238 tests: 231 passed and 7 failed in
  `tests/cli-workspace-flag.test.ts` and `tests/record-cli.test.ts`.
  The failures occurred in child CLI processes before assertions because the
  host runtime reported `uv_os_get_passwd returned ENOMEM`; this is recorded as
  an environment limitation, not attributed to A1. The A0 authorization,
  transaction, operation, and reliability suites passed in this run.
- A clean implementation run must re-run the full suite after the A1 changes
  and separate product failures from the same host-resource failure.

## 3. Decision summary

Add a durable, typed delegation layer beside A0. The layer answers whether a
specific request is a subset of an explicitly approved grant, but it never
becomes workflow authority and never replaces A0's event authorization, receipt,
visible-evidence, operation-reconciliation, or any route-specific security
boundary.

The transaction has a common proof path and an action-specific continuation.
The common path is:

`active canonical binding → canonical workflow classification → strict
request/grant validation → action-appropriate decision proof`

The common path carries only action-independent identity, binding, state, and
grant dimensions. Provider, account, capability, and other TeamAI security
predicates are conditional extensions evaluated only by the classified
action/target that actually requires them; they are never unconditional common
proof prerequisites for a grant or action class.

Only the class-specific continuation may add the authority it needs:

- `c2c_transport`: reserve the grant, acquire the canonical A0 event lease,
  issue/reuse one A0 event authority through an owned-lease seam, consume the
  reservation, then prepare the unchanged A0 receipt and deliver/reconcile.
  The current A1 target is provider-free; a future provider predicate may be
  added only for a separately classified canonical target that actually needs
  it, never by requiring `github-cli-auth` for transport in general.
- `workspace_read`: evaluate the exact local read/search/status target and
  return the versioned proof; do not construct `GitHubOperationTarget`, call a
  GitHub operation preparer, issue an A0 delivery authority, perform remote
  GitHub I/O, require a GitHub account/provider/capability, or invoke the
  `github-cli-auth` resolver. Irrelevant provider/account/capability fields are
  rejected rather than silently consulted.
- `operation_reconcile`: inspect only a previously persisted logical operation
  and its existing evidence; it cannot create, mutate, publish, or issue an A0
  delivery authority. It evaluates provider/account/capability evidence only
  when that exact known operation and policy-derived reconciliation path depend
  on that provider/account/capability contract; local persisted-evidence
  reconciliation has no unrelated GitHub-auth dependency.

The evaluator exposes a common `evaluateDelegation` proof path and closed
class-specific continuations (`evaluateC2cTransport`, `evaluateWorkspaceRead`,
and `evaluateOperationReconcile`). The route classifier, not a caller-supplied
boolean, decides whether the delegated transport continuation is required.

The grant is an additional predicate. A successful grant decision creates no
remote effect and is not an A0 event authorization. Only the `c2c_transport`
continuation obtains a fresh A0 event authority and receipt. The
`workspace_read` and `operation_reconcile` continuations commit their finite
use at their own durable proof/result boundary and issue no A0 delivery
authority. An ambiguous remote result remains an A0 reconciliation state and
cannot spend a second grant use or trigger a blind retry. A successful proof is
evidence only; it cannot be passed to A0 as an authority and cannot be
reconstructed from a serializable caller payload.

First-version eligible actions are intentionally narrow:

1. bounded C2C continuation for an event already permitted by canonical
   workflow state;
2. exact, read-only workspace inspection; and
3. reconciliation of a previously known logical operation.

Issue/PR/review/push/merge publication, connector/Project/account mutation,
Human Gates, authentication/consent/ownership/security decisions, secrets, and
unknown or compound actions are categorically denied.

## 4. Current A0 implementation and the integration seam

The release base already supplies the following contracts:

- `src/conversation/authorization.ts` owns the branded canonical workflow
  issuer, exact binding derivation, event-scoped A0 authorization, durable
  receipt transitions, stale-auth rejection, revocation, and event leases.
- `src/conversation/transaction.ts` is the narrow runtime-owned start seam.
  `beginAndPrepare` derives the active binding, creates the canonical issuer,
  issues one A0 authority, and prepares one receipt.
- `src/conversation/delivery.ts` enforces exact binding/payload identity,
  visible-bubble evidence, operation-specific reconciliation, and no blind
  resend after ambiguity. Its legacy path remains separate from the authorized
  path.
- `src/conversation/operation.ts` owns logical GitHub operation identity,
  target conflict detection, durable operation records, and owner-checked
  operation leases/CAS.
- `src/conversation/teamai.ts` accepts only a branded result from the TeamAI
  `github-cli-auth` provider and carries classifier, capability version,
  account, correlation, and auth-attempt evidence. This is an action-specific
  provider contract, not a common authorization prerequisite. Local code must
  not infer a classification from text or an untrusted JSON object.
- `src/connection/identity.ts` derives the exact repository/worktree/branch,
  installation, and event-time commit/dirty evidence.
- `src/session/state.ts` persists bounded restart projections; `registry.ts`
  persists exact Project/chat/session conversation bindings but is not workflow
  authority.
- `src/config/paths.ts` provides the OS state root, owner-only JSON writes, and
  atomic secure replacement.

The current seam has no durable grant, policy, grant-specific approval
provenance, reservation, supersession, audit chain, or typed allow/deny proof.
It can therefore issue an A0 event without evaluating A1 delegation. A1 adds
that predicate in the transaction seam and keeps the existing A0 functions as
the sole event-authority path.

## 5. Domain contracts to add

### 5.1 Typed action vocabulary

Add a closed `DelegatedAction` enum and reject all values outside it:

- `c2c_transport` — one canonical workflow-authorized control event;
- `workspace_read` — one exact bounded read/search/status target;
- `operation_reconcile` — evidence lookup for an already persisted logical
  operation.

The request carries a class-specific structured target, not a free-form verb.
The closed policy/action classifier owns the route and derives an internal
`DelegationRoute` (`DELEGATED_TRANSPORT`, `LOCAL_WORKSPACE_READ`, or
`KNOWN_OPERATION_RECONCILE`). `delegationRequired` is therefore a derived
property of the canonical action and route, never an optional caller-controlled
flag. The delegated transport path requires an unforgeable in-process permit
returned by the evaluator; an A2 proof or JSON object cannot manufacture it.

The request carries a class-specific structured target:

- common scope: workspace ID/workstream ID, canonical repository, exact
  worktree root, branch/ref, canonical stage/action scope, and a scope digest.
  This common scope never contains or requires a GitHub account, provider, or
  capability result; binding/security predicates that are not universal remain
  action-specific.
- provider-dependent scope, only when required by the concrete canonical
  action/target: exact expected account, TeamAI source/skill/provider identity,
  and compatible capability-contract version/range. A `workspace_read` grant
  and the current `c2c_transport` grant omit these fields and reject them as
  irrelevant schema/policy fields rather than silently depending on them.
- transport target: canonical checkpoint/event key, allowlisted message type,
  and exact payload hash;
- workspace-read target: normalized path/search/status operation and bounded
  path predicate; no write-capable command or wildcard escape;
- operation-reconcile target: existing operation key/target identity and
  operation-specific bounded proof request. The untrusted request does not
  carry `evidencePath`; the evaluator loads the persisted operation plus any
  relevant A0 receipt/operation evidence and derives an internal closed
  `local_persisted` or `provider_bound` path from policy. A caller-supplied
  `evidencePath` is rejected as an unknown/irrelevant field. The local path
  forbids provider fields and TeamAI resolution; the provider-bound path
  requires only its exact compatible provider/account/capability evidence. It
  cannot create or mutate the operation.

Missing, duplicated, malformed, unknown, or compound dimensions fail closed.
The parser boundary is strict before ordinary JSON parsing: it consumes the raw
bytes, rejects duplicate object names recursively (including names that become
equivalent after decoding), and distinguishes a missing file from malformed or
corrupt content. This A1 boundary is applied to grants, reservations,
approval/proof records, and CLI JSON carrying A1 authorization data; the
existing general A0 config reader is not silently changed.

### 5.2 Durable grant record

Add a versioned `DelegationGrant` record persisted under the machine state
directory, separate from A0 authorizations and receipts. The record contains:

- `schemaVersion`, stable `grantId`, `generation`, immutable creation time,
  `notBefore`, `expiresAt`, and explicit policy version. Applicability uses the
  exact interval `notBefore <= now < expiresAt`; equality with `expiresAt` is
  expired and denied.
- the typed action class and normalized common/class-specific scope;
- a canonical `scopeDigest` over the normalized scope (never over secrets);
- grant-specific approval provenance: canonical workflow state path/checkpoint,
  decision ID, approver identity reference, approval time, and the approved
  digest. Conversation prose alone is never an approval source;
- action-specific provider/security predicate, when applicable: exact expected
  account, TeamAI source/skill/provider identity, and compatible typed
  capability-contract version/range. Do not pin an implementation hash. A
  local `workspace_read` grant has no GitHub-account/provider/capability fields;
  `operation_reconcile` includes them only when its exact known-operation path
  requires that provider/account.
- finite `maxUses` and class budget, with policy defaults of 24 hours, 64
  transport uses, 256 read/reconcile uses, and 1 for an explicitly single-use
  grant. These defaults live in policy data, not schema constants;
- explicit `supersedesGrantIds` or policy-family generation, plus revocation and
  supersession evidence; overlap or narrower scope alone does not supersede;
- sanitized lifecycle/audit references and reservation/consumption counters.

Grant records are owner-only, atomically replaced, bounded, and never contain
tokens, control-message text, raw credentials, or private endpoint material.
Unsupported or corrupt schema is preserved for diagnosis and refused rather
than silently migrated or resurrected.

### 5.3 Decision proof and denial vocabulary

Expose a serializable, versioned `DelegationDecisionProof` for current and
future A2 consumers. Every allow proof contains only the common grant
ID/generation, action/scope/binding/state digests, expiry/use reservation, and
decision digest. Provider evidence is an action-discriminated extension: it is
present only for a closed route/evidence mode whose policy requires the exact
provider/account/capability contract. `workspace_read` forbids provider,
account, and capability proof fields, as does local persisted-evidence
`operation_reconcile`; a provider-dependent reconciliation proof carries only
the exact evidence that its known operation requires. A deny proof contains a
stable typed reason (for example `HUMAN_GATE`, `SCOPE_MISMATCH`,
`GRANT_EXPIRED`, `GRANT_REVOKED`, `TEAMAI_UNAVAILABLE`,
`OPERATION_NOT_KNOWN`, `SCHEMA_UNSUPPORTED`, or `LEASE_CONFLICT`) and sanitized
evidence. Provider-specific reasons such as `TEAMAI_UNAVAILABLE` are reachable
only on a provider-dependent route. Irrelevant provider evidence is rejected,
not silently serialized or ignored. The proof is query evidence, not an
authority token and cannot be passed directly to A0 issuance.

### 5.4 Reservation and audit records

Each finite-use evaluation creates a grant-scoped reservation with its own
generation, owner lease, class-specific commit boundary, and state:

`RESERVED → CONSUMED` or `RESERVED → RELEASED`.

For `c2c_transport`, the reservation identity is stable for
`grantId + grantGeneration + logicalEvent/action/targetDigest`, and consumption
commits at first persisted A0 authority. For `workspace_read`, the evaluator
mints a non-caller-controlled `decisionInstanceId` for each new request and
atomically consumes one use when the durable allow decision/proof is committed.
For `operation_reconcile`, the same per-request identity consumes when the
bounded known-operation reconciliation result is durably committed. A retry of
an interrupted decision reuses its persisted `decisionInstanceId`; a new
identical read/reconciliation request receives a new one and spends a new use.
The caller-controlled target digest alone is never a retry identity.

Failures before the class-specific commit boundary may release a reservation;
after that boundary recovery rehydrates the same reservation and is idempotent.
Reservation revalidation, expiry, and revocation checks occur while the
reservation lease/CAS is held, not only in a stale pre-lock decision. An
append-only sanitized audit stream records grant generation, scope/action
digests, decision, reservation transition, class-specific commit reference,
A0 authority/receipt references where applicable, remote reconciliation
reference, and revocation or supersession evidence until terminal workflow
state. No automatic garbage collection is introduced in A1.

## 6. Trust boundary and evaluation rules

1. The active runtime supplies the workspace root and workspace ID. A binding
   file cannot choose another workstream, stage, checkpoint, or repository.
2. `deriveActiveCanonicalBinding` refreshes event-time commit and dirty state.
   A grant binds to one exact worktree root and branch/ref; commit and dirty
   state are evidence for the event, not durable grant identity.
3. The canonical issuer confirms the workflow action and that a genuine Human
   Gate is complete where the workflow requires it. A grant cannot create or
   approve that gate.
4. Provider/security predicates are not part of the common grant check. For a
   concrete provider-dependent action/target only, TeamAI supplies the branded
   `github-cli-auth` capability result and the evaluator requires a supported
   classification, exact expected account, and compatible source/skill/
   capability contract; missing, incompatible, human-boundary, or unavailable
   evidence fails closed before that action's continuation (and before any A0
   issuance when applicable). A bounded `workspace_read` must not require a
   TeamAI result, must not invoke the GitHub-auth resolver, and rejects
   irrelevant provider fields. The current `c2c_transport` target is likewise
   provider-free and must not require `github-cli-auth` unconditionally. An
   `operation_reconcile` uses provider/account/capability evidence only when
   the exact known operation and policy-derived path require it; local
   persisted-evidence reconciliation does not manufacture that dependency.
5. The evaluator loads the grant by stable ID, validates schema and policy,
   checks time window, revocation, explicit supersession, budget, approval
   provenance/digest, and exact structured subset predicates.
6. Only the `c2c_transport` continuation then issues one concrete A0 event
   authority and prepares the unchanged A0 receipt. `workspace_read` and
   `operation_reconcile` stop at their typed proof/result commit boundary and
   consume their reservation there; a grant ID or proof never substitutes for
   an A0 authority.

The evaluator/store and lease helper receive an injectable internal `Clock`
(`now(): number`) and default it to the system clock. All expiry and lease
tests advance this clock without sleeps. The same clock is used for the
pre-check and the in-lock reservation recheck; callers cannot supply a time in
the request. Existing A0 callers that do not pass a clock retain their current
system-clock behavior.

Delegated transport uses one concrete coordinator, not two independent calls:
it owns the event lease first, then the grant reservation lease/CAS, and every
normal and recovery path follows that same lock order. The coordinator derives
the stable reservation identity, rehydrates an existing reservation for a
retry, and calls an internal A0 `issueOrReuseDeliveryAuthorizationOwnedLease`
seam while the event lease is already owned. The existing public A0 wrapper
still acquires its lease and preserves its current transitions. The initial
persisted A0 authority carries the grant generation, reservation ID, and
decision digest so a crash after authority persistence can recover the same
authority rather than release or spend a second use. A reservation is released
only after authoritative absence of that A0 authority is established under the
same protection; once an authority exists, consumption and receipt recovery are
idempotent. Grant applicability governs new issuance only. If an exact
persisted A0 authority already carries matching reservation/generation
references, recovery finalizes that reservation idempotently and follows A0's
own receipt/reconciliation rules even if the grant later expires, is revoked,
or is superseded. If no authority exists, current grant applicability is
rechecked under the grant lease and the reservation is denied or released.

Material durable changes (repository, worktree root, branch/ref, canonical
stage/action, action class, structured target, or any provider/security
predicate present for a provider-dependent route) invalidate applicability
immediately. Restart, compaction, supported session or
browser replacement, and verified ephemeral transport replacement do not alone
invalidate a grant; every resumed event still requires a fresh exact A0 binding.

## 7. File-by-file implementation plan

### New contracts and persistence

- `src/conversation/delegation.ts`
  - Define the closed action enum, common and class-specific targets, grant,
    reservation, audit, denial, and proof types.
  - Normalize and hash scope deterministically; reject duplicate/unknown fields,
    writes, Human Gates, wildcard targets, and missing required dimensions.
  - Expose one common `evaluateDelegation` proof path plus closed
    `evaluateC2cTransport`, `evaluateWorkspaceRead`, and
    `evaluateOperationReconcile` continuations. Only the transport continuation
    returns the internal, non-serializable permit required by the delegated A0
    route.
  - Apply provider/account/capability predicates only when the classified
    action/target requires them. `evaluateWorkspaceRead` and the current
    `evaluateC2cTransport` path reject irrelevant GitHub-account/provider/
    capability fields and never call `resolveTeamAiAuthResult`;
    `evaluateOperationReconcile` consults provider evidence only for a known
    operation whose policy-derived reconciliation path requires it.
  - Implement load/validate/create-from-authoritative-approval, applicability
    evaluation, explicit revoke/supersede, reserve/consume/release, rehydrate,
    and proof-only query APIs.
  - Store grants/reservations/audit below a new delegation state root using
    `writeAtomicSecureJson`, bounded records, and owner-only permissions.
  - Treat schema/policy mismatch, malformed records, expired/revoked/superseded
    grants, and missing approval as typed denials.

- `src/config/strict-json.ts` (new A1-only boundary)
  - Read raw bytes and perform duplicate-key-aware recursive parsing before
    ordinary object construction; reject duplicate names, including equivalent
    decoded names, truncated/corrupt input, and unexpected trailing content.
  - Return distinct `MISSING` versus `MALFORMED`/`CORRUPT` outcomes. Use this
    boundary for A1 grants, reservations, approval/proof records, and CLI A1
    authorization JSON only; preserve the behavior of the existing A0 config
    reader for unrelated records.

- `src/conversation/delegation-policy.ts`
  - Define the versioned policy data for the first action vocabulary and finite
    defaults (24h, 64, 256, and 1), max field/budget bounds, allowed provider
    contract range, and explicit excluded classes.
  - Own the closed `deriveOperationEvidencePath` mapping from the loaded
    persisted `GitHubOperationRecord` plus relevant persisted A0 receipt/
    operation evidence to `local_persisted` or `provider_bound`. The mapping
    must use explicit typed policy inputs, not string heuristics, arbitrary
    operation-kind inference, or caller input; unknown/stale identity and a
    caller-supplied `evidencePath` fail closed.
  - Keep policy data separate from the wire schema so a policy migration is
    explicit and old grants fail closed when the runtime cannot prove safety.

- `schema/delegation-grant.schema.json` and `schema/delegation-proof.schema.json`
  - Describe the serializable v1 grant and A2 proof/denial contracts, bounded
    fields, enums, and required fields. These schemas are validation contracts,
    not a way to manufacture authority.

- `src/config/lease.ts` (new internal helper)
  - Factor only owner-checked lease ownership/recovery: lease ID, PID
    liveness, stale threshold, injected clock, and owner-only cleanup. Never
    reclaim a live owner by age alone.
  - Add a versioned compatibility reader for the legacy A0 event-lock shape
    (`at`) and current operation-lock shape (`acquiredAt`). A dead legacy owner
    may be reclaimed; a live owner may not. Do not absorb domain generation/CAS
    semantics into this helper.

### A0 seam and transport integration

- `src/conversation/transaction.ts`
  - Extend `beginAndPrepare` with an explicit delegated request/grant identity,
    action-specific target, and provider evidence only for the closed
    provider-bound `operation_reconcile` path when its persisted operation
    requires it. The current A1 `c2c_transport` target has no provider
    predicate and supplies no TeamAI result; it must reject irrelevant provider
    fields. A bounded `workspace_read` likewise supplies no TeamAI result and
    must not invoke the GitHub-auth resolver.
  - Derive the active canonical binding and closed policy route first. For
    `workspace_read`, return a local proof without GitHub target preparation or
    A0 delivery issuance; for `operation_reconcile`, inspect only the known
    operation and its policy-owned evidence path; for `c2c_transport`, use only
    the declared checkpoint/event/message/payload target and invoke the single
    coordinator and its owned-lease A0 seam. The current A1 `c2c_transport`
    vocabulary has no provider/account/capability predicate; provider evidence
    is absent and irrelevant provider fields are rejected. If a future
    canonical target becomes provider-dependent, only that target's continuation
    may add its exact provider/account/capability predicates.
  - Make the delegated route require the internal permit and persisted grant
    generation/reservation/digest references. Missing delegated references fail
    closed and never select the legacy sender; the legacy path is reachable only
    through an explicit, policy-classified non-delegated compatibility route.
  - Commit the reservation to the returned A0 authority ID; on a proven
    pre-authority failure release it, and on any ambiguity retain it for
    rehydration/reconciliation. Return the typed decision proof alongside the
    existing A0 result without making the proof an authority.

- `src/conversation/authorization.ts`
  - Keep the canonical issuer, event identity, receipt transition graph, and
    revocation semantics authoritative.
  - Add optional bounded delegation references to A0 authorization/receipt
    records (grant ID/generation, decision digest, reservation ID, audit
    reference) and validate them during rehydration.
  - Add the internal owned-event-lease issue/reuse seam used by the A1
    coordinator. The public A0 wrapper remains behaviorally identical, while
    the coordinator can issue/reuse an authority without recursively acquiring
    the same event lock.
  - Add a recovery seam that detects an existing A0 authority after a crash
    between reservation and consumption, consumes the same grant use, and never
    mints a second event. Preserve existing expiry/revocation and generation
    checks, and require the same event-first lock order during recovery.

- `src/conversation/delivery.ts`
  - Carry the delegation proof/reference through the authorized path only.
  - Keep `AMBIGUOUS`, operation-specific evidence, visible-bubble proof, and
    no-blind-resend behavior unchanged; a valid grant must not authorize a
    second event after an ambiguous result.
  - Derive route classification internally and reject any delegated transport
    call that lacks the evaluator's runtime permit, reservation ID, grant
    generation, and decision digest. Do not accept a caller-controlled optional
    `delegationRequired` flag, and do not let omission fall back to legacy
    delivery.

- `src/conversation/operation.ts`
  - Expose a read-only “known logical operation” lookup/identity projection for
    `operation_reconcile`; preserve the current write-operation target conflict
    and generation/CAS behavior.
  - Reject a delegation request that would create, update, publish, push, review,
    or merge an operation. Reconciliation may only inspect a persisted operation
    and use its existing operation-specific evidence rules. Derive a closed
    policy-owned evidence-path discriminator from that persisted operation (for
    example `local_persisted` versus `provider_bound`); do not trust a
    caller-selected provider flag. The local path supplies no provider evidence
    and never resolves TeamAI, while the provider-bound path requires only its
    exact compatible provider/account/capability evidence and fails closed when
    it is missing or incompatible.

- `src/conversation/teamai.ts`
  - Preserve the TeamAI branding boundary and add the typed provider-contract
    projection needed by provider-dependent grant comparison (source, skill,
    capability version, expected account, correlation, and auth attempt). Keep
    this module out of the `workspace_read` authorization path unless a future
    explicitly approved policy adds a different local security predicate.
  - Keep local code unable to classify arbitrary text or a structurally forged
    result; stale auth attempts remain rejected. CLI JSON may provide only
    bounded provider-selection/observation inputs; the trusted boundary must
    call `resolveTeamAiAuthResult` in-process to obtain the branded result.

### Identity, restart, and CLI projections

- `src/connection/identity.ts`
  - Add a normalized canonical branch/ref projection for detached and named
    worktrees while retaining current `branch` compatibility. Do not promote
    event-time commit or dirty state into durable grant identity.
  - Reuse existing remote normalization and installation identity; no secret or
    credential material is persisted.

- `src/session/state.ts`
  - Add bounded optional delegation references (grant ID/generation, scope and
    decision digests, reservation state, typed denial) to the transport
    projection. Rehydration must reload and revalidate the grant and canonical
    A0 state; a session dump alone cannot restore authority.
  - Keep existing caps and protocol state transitions; unsupported delegation
    data causes a safe blocked result rather than implicit legacy recovery.

- `src/conversation/registry.ts`
  - If resume lookup needs a pointer, persist only grant ID/generation and
    scope digest as non-authoritative metadata. Do not include grant scope in the
    conversation key, and never treat a Project/chat display name or registry
    record as approval.

- `src/config/paths.ts`
  - Add path helpers for the delegation root and bounded audit files, reusing
    the current atomic secure JSON primitive and owner-only state directory.

- `src/cli/index.ts`
  - Parse strict A1 request/grant references and bounded provider-selection
    observations through the runtime transaction seam; return stable JSON
    proof/denial fields. Provider-selection/account/capability input is
    accepted only for the provider-dependent reconciliation route;
    `workspace_read` and current `c2c_transport` reject it and never load or
    invoke `github-cli-auth`. Never deserialize a structural
    `TeamAiCapabilityResult` from JSON; resolve the branded result through the
    trusted TeamAI boundary only when the classified route requires it.
  - Add inspection/reconciliation commands only where they are read-only. Any
    grant creation/revocation/supersession command must consume an
    authoritative canonical grant decision and must not offer a standalone
    prose/CLI bypass, connector mutation, auth action, or external write.
  - Preserve current `transport deliver/observe/reconcile` behavior and do not
    log raw grant, credential, or control-message contents.

### Documentation and compatibility

- `CONTEXT.md`: add the vocabulary for durable grant, grant-specific approval,
  reservation, decision proof, and explicit supersession while retaining the
  A0 authority distinction.
- `docs/security.md`: document the least-authority boundary, TeamAI ownership,
  state-file privacy, owner leases, fail-closed migration, and audit retention.
- `docs/protocol.md`: document the typed allow/deny proof and the fact that A2
  receives evidence only, never execution authority.
- `docs/custom-stability-patches.md` (if the repository provenance table is
  updated): record the A1 modules and tests without copying runtime code into
  TeamAI.

## 8. State machine and failure handling

### Grant lifecycle

`APPROVED_ACTIVE → RESERVED → CONSUMED` is the normal path. A grant may move to
`REVOKED`, `EXPIRED`, or explicitly `SUPERSEDED`; those terminal applicability
states survive restart. `RESERVED → RELEASED` is legal only when the process
proves that no A0 authority was persisted. A stale live-owner lease is never
reclaimed by age alone. Reservation and A0 coordination uses one event-first,
grant-second lock order, a stable reservation identity, and the injected clock;
expiry is evaluated as `notBefore <= now < expiresAt` at both the proof and
in-lock reservation boundaries. The commit boundary is class-specific:
`c2c_transport` consumes at first persisted A0 authority,
`workspace_read` consumes at durable allow-proof commit, and
`operation_reconcile` consumes at durable known-operation result commit.

### Crash/restart matrix

| Point of failure | Required recovery |
|---|---|
| Before reservation | No grant use and no A0 effect. |
| During reservation CAS | Winner/loser is deterministic; loser receives `LEASE_CONFLICT`. |
| Reservation persisted, A0 not issued | Reacquire the event-first lock order, prove absence of the exact A0 event while protected from concurrent issuance, then release or reclaim the stable reservation by generation. |
| A0 authority persisted, grant consumption not persisted | Find the same event/authority by the persisted reservation/grant references, consume that reservation, and continue its A0 receipt; never mint a new event. |
| A0 receipt is `SENDING`/`AMBIGUOUS` | Preserve A0 reconciliation and grant consumption; no blind resend or second use. |
| Revocation races reservation | CAS winner is recorded; a denied reservation requires a new grant, while a consumed authority remains auditable. |
| Explicit supersession races use | Deterministic generation/relationship check; no overlap-based inference. |
| Restart after expiry/revocation/supersession | For a new reservation with no A0 authority, rehydration rechecks current applicability and denies/releases. For an exact persisted A0 authority with matching references, finalize the existing reservation idempotently and continue A0 receipt/reconciliation; never mint a replacement or spend a second use. |
| Unsupported/corrupt schema or policy | Fail closed, preserve the record, return a typed proof, and require explicit migration/new approval. |

The coordinator persists a reservation journal/reference before A0 issuance and
the grant generation, reservation ID, and decision digest in the initial A0
authority. A retry therefore rehydrates the same transaction rather than
spending another use. The recovery implementation must be tested with injected
failures at each persistence boundary and with two competing processes; a
sequential unit test alone is insufficient evidence of atomicity.

## 9. Tests and acceptance coverage

Add `tests/delegation.test.ts` for deterministic unit coverage:

- closed action enum, common/class-specific target subset checks, unknown or
  compound action denial, all excluded Human Gate/security/write classes;
- class-specific runtime/query routing: `workspace_read` never prepares a
  GitHub operation or A0 delivery authority, `operation_reconcile` cannot
  create/mutate an operation, and only the policy-owned delegated transport
  route receives the internal permit;
- omitted delegated references and forged optional `delegationRequired` input
  cannot select the legacy delivery branch; explicitly non-delegated A0
  compatibility traffic continues to behave as before;
- exact worktree root and branch/ref, repository, stage/action, and structured
  operation target; the untrusted `operation_reconcile` request rejects an
  `evidencePath` field, and policy derives the internal evidence path only from
  the persisted `GitHubOperationRecord` plus relevant A0 receipt/operation
  evidence. Tests cover caller attempts to force either path and changed or
  stale operation identity failing closed;
- provider/account/TeamAI source/skill/capability predicates are tested only
  for provider-bound reconciliation, while `workspace_read` and the current
  A1 `c2c_transport` explicitly succeed without them and reject irrelevant
  fields. Add a direct regression that a valid bounded `workspace_read` is
  evaluated with no TeamAI `github-cli-auth` result and with an assertion that
  the resolver is not invoked; provider-dependent actions must fail closed when
  their exact provider/account/capability evidence is missing or incompatible;
- 24-hour/64/256/1 policy data, injected-clock not-before/exact-expiry/expired
  behavior (`notBefore <= now < expiresAt`), in-lock expiry recheck, and
  finite-use exhaustion;
- raw top-level and nested duplicate-key fixtures (including decoded-equivalent
  names), malformed/truncated JSON, unknown fields, and distinct missing versus
  corrupt record outcomes before ordinary JSON parsing;
- class-specific finite-use commit and retry identity: each new identical
  workspace read/reconciliation receives a new runtime decision instance and
  spends one use, while crash recovery rehydrates the same persisted instance;
  proof/result commit consumes and pre-commit failure releases;
- canonical grant-specific approval provenance/digest versus prose-only or
  forged approval; explicit supersession versus overlap/narrower-without-link;
- revoke/expiry/supersession persistence, restart rehydration, unsupported
  schema/policy, bounded privacy, and audit retention;
- typed allow/deny proof stability and proof-not-authority separation;
- A2 query receives evidence only and cannot issue an A0 authorization.

Extend `tests/transaction.test.ts` with the seam and crash cases:

- denial occurs before `issueDeliveryAuthorization` and leaves no receipt;
- matching grant reserves, issues exactly one A0 authority, consumes once, and
  returns the proof plus the existing receipt;
- proven pre-A0 failure releases a use; post-A0 failure consumes it;
- rehydration after a crash between reservation and A0 consumption finds the
  same authority/event;
- grant expiry, revocation, and supersession after A0 persistence but before
  consumption, during `SENDING`, and during `AMBIGUOUS` preserve existing A0
  recovery; the same conditions before any A0 authority deny/release the new
  reservation;
- current-v1 `c2c_transport` issues/reuses A0 only after the existing
  canonical issuer/state, binding, checkpoint/stage, message-type, event-key,
  payload-hash, and optional-operation checks; it does so without calling
  `resolveTeamAiAuthResult` and rejects unrelated provider fields. Existing A0
  TeamAI auth-observation/recovery behavior remains tested separately and
  unchanged;
- provider-bound `operation_reconcile` fails at its reconciliation
  decision/result boundary—not at A0 issuance—when branded provider evidence
  is missing, wrong-account, stale, incompatible, or at a human/security
  boundary;
- a valid bounded `workspace_read` is evaluated without a branded TeamAI
  result and without invoking `resolveTeamAiAuthResult`; a valid current-v1
  `c2c_transport` likewise succeeds without that result or resolver and
  rejects unrelated provider fields; provider-bound reconciliation fails
  closed when required evidence is missing or incompatible;
- local persisted-evidence `operation_reconcile` succeeds without a branded
  TeamAI result and without invoking `resolveTeamAiAuthResult`, while the
  policy-owned provider-bound discriminator requires the exact compatible
  evidence and fails closed otherwise; the caller cannot flip the derived path
  or make a local durable record resolve TeamAI;
- a valid grant cannot create or approve a canonical Human Gate.
- stable reservation identity and event-first/grant-second lock ordering under
  competing processes and injected failures at reservation, A0 persistence,
  consumption, and receipt boundaries; retries rehydrate the same authority;
- live-owner and dead-owner recovery for both the legacy A0 event-lock (`at`)
  and operation-lock (`acquiredAt`) shapes, including owner-only cleanup and
  regression coverage for unchanged public A0 behavior;
- forged JSON cannot satisfy the branded TeamAI result boundary; the CLI uses
  bounded provider observations and in-process `resolveTeamAiAuthResult`.

Extend `tests/authorization.test.ts` and `tests/reliability.test.ts` to verify
that delegation references do not weaken A0 binding, generation, revocation,
expiry, receipt transitions, visible evidence, or no-resend semantics.

Extend `tests/operation.test.ts` for known-operation reconciliation, write-class
denial, same logical operation/changed target conflicts, and operation lease/CAS
interactions.

Extend `tests/session.test.ts` and registry coverage for bounded, non-authoritative
delegation projections and safe restart/compaction behavior. Add subprocess or
injected-crash tests, following the existing operation lease tests, for two
competing reservations, live-owner stale locks, revocation races, and recovery
at every matrix point.

The acceptance matrix is:

| Requirements | Planned evidence |
|---|---|
| AC-001–004 | action classifier, Human Gate rejection, route-specific TeamAI/security predicates when applicable, canonical A0 seam tests |
| AC-005–008, AC-021–022, AC-024, AC-028–030 | target normalization/subset tests, finite policy tests, provider/account/worktree tests for provider-dependent actions, provider-free workspace-read tests, excluded-class tests |
| AC-009–012, AC-026 | time window, budget/CAS, revocation, explicit supersession and restart tests |
| AC-013–016, AC-023 | reservation/A0 crash matrix, ambiguous reconciliation, same-key conflict, release/consume tests |
| AC-017–020, AC-027 | audit/proof schema, bounded privacy, unsupported migration, retention and A2 projection tests |
| AC-025 | authoritative grant-specific approval/provenance tests; prose-only denial |

## 10. Validation, observability, and rollback

Implementation validation order is `pnpm typecheck`, targeted delegation and
transaction tests, full `pnpm test`, then a bounded live read-only verification
of the exact worktree/state identity. Any host `ENOMEM` child-process failure
must be reported separately from product regressions.

Observability is limited to sanitized grant IDs, generation, action/scope and
decision digests, typed verdicts, reservation/A0 references, and bounded remote
evidence. No control-message text, token, device code, credential, or secret is
copied into grant/audit/proof records.

Rollback is a durable state transition, not deletion: revoke or explicitly
supersede affected grants, leave audit history intact, and disable the new
delegated route so requests fail closed. Existing A0 records and legacy
non-delegated internal transport remain readable. No destructive migration,
automatic grant widening, or fallback that bypasses the canonical issuer is
allowed.

## 11. Implementation order and known limitations

1. Freeze the v1 contracts, policy data, strict raw-JSON boundary, JSON
   schemas, route classifier, and denial taxonomy.
2. Add the narrowly scoped owner-checked lease helper with legacy lock readers
   and prove both A0 lock semantics remain unchanged.
3. Implement grant persistence, normalization, evaluator, approval provenance,
   revocation/supersession, injected-clock reservation, audit, rehydration, and
   proof APIs.
4. Implement the event-first/grant-second coordinator and owned-lease A0
   issue/reuse seam; add TeamAI/provider and known-operation checks.
5. Integrate class-specific transaction/delivery routing, worktree ref
   identity, session/registry projections, and read-only CLI proof plumbing.
6. Add deterministic unit, raw-parser, subprocess, crash-recovery, lock
   compatibility, forged-TeamAI, and regression tests.
7. Update context/security/protocol documentation and migration notes.
8. Run validation, resolve C2C findings within the approved scope, and save the
   reviewed plan as `02-plan.md` only after a terminal C2C verdict.

Known limitations that remain intentional: no A2 headless execution, no A3
observability service, no A4 rollout policy, no connector/Project/account
mutation, no external GitHub write/publication, no authentication or security
boundary automation, and no new Human Gate UI. Those require separate approved
requirements and gates.

## 12. C2C review status for this draft

The dedicated A1 reviewer chat is bound to the exact read-only connector and
verified `workspace_info` before review. C2C checkpoint `c2c_2e0a` completed
six pre-implementation iterations (0 through 5). Iterations 0, 1, 3, and 4
returned `FIX_REQUIRED`; iterations 2 and 5 returned terminal `PASS` with no
remaining findings. All remediation was plan-only; source implementation
begins only after the approved Step 4 gate.

Iteration 0 identified seven design defects: the class-specific
`workspace_read` seam, policy-owned delegated routing, raw duplicate-key
parsing, injected-clock/expiry ownership, reservation/A0 atomicity and crash
recovery, lease/CAS compatibility, and the TeamAI branding/CLI boundary. The
remediation added explicit route continuations, an A1-only raw-JSON boundary,
exact clock/expiry semantics, one event-first coordinator with stable
reservation identity and an owned A0 lease seam, legacy-lock compatibility,
and in-process branded TeamAI resolution. Iteration 1 additionally required
class-specific finite-use commit/retry identity for proof-only classes,
separation of new-grant applicability from recovery of an already-issued A0
authority, and removal of generic all-actions-get-A0 wording. The amended plan
defines durable commit boundaries and runtime decision instances, separates new
issuance from existing-A0 recovery, and qualifies A0 issuance as transport-only.

Iteration 2 independently re-read the exact A1 connector inputs, requirements,
draft, relevant source/tests, and current workspace state. It confirmed that
the four lifecycle concerns are coherent, that concurrency/security/
compatibility/test/rollback/order coverage is implementation-ready, and that
`git diff HEAD` is empty apart from the untracked A1 harness directory. The
reviewer recorded terminal `PASS` and directed promotion to `02-plan.md` with
the `PLAN_READY_FOR_VISUAL_REVIEW` marker. No source implementation is
authorized before the next canonical Human Gate.

The reviewer noted that the designated A1 connector exposes workspace/source/
git inspection but no GitHub-Issue retrieval operation. The local Issue #8
conversion artifact and approved requirements were accepted as sufficient
bounded evidence for all five iterations; no other connector was substituted,
and `REQUIRED_CAPABILITY_UNAVAILABLE` was not warranted.

The Step 4 redline then identified a substantive inconsistency: provider,
account, and capability evidence was still described as common even though
`workspace_read` is intentionally GitHub-auth independent. Iteration 3 found
three localized contract/test gaps, and iteration 4 found two follow-up
boundary gaps. The remediations make proof fields action-discriminated,
declare current-v1 transport provider-free, move provider/A0 assertions to
their correct boundaries, and derive reconciliation evidence paths internally
from persisted operation/receipt evidence. Iteration 5 independently verified
those changes and returned terminal `PASS`; the existing Step 4 plan-approval
gate is now the next stop.




## C2C Review Summary

- Reviewer binding: ChatGPT planning/review layer in Project `codex-with-chatgpt-a1-delegated-authorization`, using the isolated connector `Codex with ChatGPT · codex-with-chatgpt-a1-delegated-auth · 2aa24f13` only.
- Project: `https://chatgpt.com/g/g-p-6abe8a9125b4819185ef2dd6ffba5628/project`
- Reviewer chat: `https://chatgpt.com/g/g-p-6abe8a9125b4819185ef2dd6ffba5628-codex-with-chatgpt-a1-delegated-authorization/c/6abe8bae-ec9c-83ee-af80-f087b9e18354`
- `workspace_info`: workspace ID `bc29499cac43`, name `codex-with-chatgpt-a1-delegated-authorization`, canonical repository `C:/Projects/ai-agent-harness-setup/work/codex-with-chatgpt`, linked worktree `codex-with-chatgpt-a1-delegated-authorization` under the canonical repository `.git/worktrees/`, branch `a1-delegated-authorization`, observed HEAD `b36a38cdd613ef474460e2ebc4a62180a93e99c7`. At that Step 3 review point, only the A1 harness directory was untracked and the source diff was empty.
- Checkpoint: `c2c_2e0a`, Step 3 `pre_implementation`; iterations 0, 1, 3, and 4 were `FIX_REQUIRED`, and iterations 2 and 5 were terminal `PASS` for their respective reviewed artifacts.
- Reviewed artifact hash at iteration 5: `E02D1D9276399A27660AA0E310687A1A838C30E7819AF6B6691A8E32A89EFBE9`. The promoted final artifact hash is recorded below and in canonical state.
- Findings/remediation: iteration 0 required class-specific local-read continuations, policy-owned delegated routing, pre-parse duplicate-key rejection, injected-clock/in-lock expiry checks, atomic event-first/grant-second reservation/A0 recovery, legacy lease-shape/live-owner compatibility, and an in-process branded TeamAI boundary. Iteration 1 required class-specific finite-use commit/retry identity, separation of new-grant applicability from recovery of persisted A0 authority, and removal of generic all-actions-get-A0 wording. All findings were remediated in the plan only.
- Historical terminal verdict: iteration 2 was `PASS`, with no remaining findings at that pre-redline content. Iteration 3 found three localized provider-boundary inconsistencies and iteration 4 found two follow-up boundary inconsistencies; iteration 5 found none and returned terminal `PASS`. The designated connector's lack of a live GitHub-Issue retrieval operation remains accepted as sufficient bounded evidence, and `REQUIRED_CAPABILITY_UNAVAILABLE` was not warranted.
- At the Step 3 review point, no source implementation was performed or authorized. The current canonical stop remains the Step 4 direct-plan Human Gate; this redline turn did not edit source or tests.

## Current Step 4 redline / re-review status

The preceding C2C summary records the historical terminal `PASS` for the
pre-redline artifact. That earlier Step 3 redline was within Q401–Q414 but materially changed
the reviewed provider/security predicate boundary and its acceptance
tests. Iterations 3 and 4 returned `FIX_REQUIRED`; their plan-only
remediations made proof evidence action-discriminated, current-v1 transport
provider-free, provider/A0 assertions correctly scoped, and reconciliation
evidence paths wholly policy-derived from persisted operation/receipt evidence.
Iteration 5 independently re-read the connector inputs, requirements, plan,
source/tests, and git state, found no remaining findings, and returned terminal
`PASS`. This final artifact is therefore ready for the existing Step 4 Direct
plan-approval Human Gate. No source implementation is authorized before that
gate.

## Step 4 plan-approval redline disposition

The remaining human Step 4 redline is a wording and coverage reconciliation inside
the already reviewed Q401–Q414 design. The common proof/scope contract now
contains only action-independent identity and binding dimensions; provider,
account, and capability evidence is an explicit action-specific extension.
`workspace_read` and the current `c2c_transport` target are explicitly
provider-free, while `operation_reconcile` obtains such evidence only when its
policy-derived known-operation path requires it. The affected implementation
descriptions and regression coverage state the same boundary, including the
resolver-not-invoked workspace-read regression and fail-closed provider-bound
cases.

Under the pinned `codex-c2c-v2` workflow, a Step 4 Human redline that preserves
the approved requirements, architecture, action vocabulary, and scope is
handled by updating `02-plan.md` and returning to the same Step 4 Human Gate;
the canonical Step 3 C2C review/remediation loop is not re-opened for this
non-semantic reconciliation. Step 4 approval remains pending, and source
implementation is not authorized.

PLAN_READY_FOR_VISUAL_REVIEW
