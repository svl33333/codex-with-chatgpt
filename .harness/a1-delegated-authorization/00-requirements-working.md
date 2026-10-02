# A1 Delegated Authorization — approved requirements (with retained discovery history)

Status: `APPROVED / Q401-Q414 resolved; no new unresolved requirement question`

This is the Step 1 Requirements Discovery artifact for roadmap A1, based on
the merged A0 transport implementation in the release baseline. It defines the
problem, boundaries, decision questions, and acceptance contract only. It does
not implement source code, create a GitHub Issue, publish a branch, or authorize
any GitHub/C2C write.

## 1. Problem statement

A0 establishes durable, exactly-once C2C transport for one canonical
workstream: a workflow-issued event is bound to the exact workspace, Project,
chat, connector/session, stage, event key, operation target, and payload; the
delivery receipt is reconciled from visible evidence; ambiguous outcomes never
blindly resend; and TeamAI `github-cli-auth` remains the sole authentication
and credential-context classifier.

A0 deliberately treats a concrete delivery authorization as the final event
authority. That is safe but too narrow for a future headless runner that needs
to perform a small set of pre-approved, routine actions without turning every
routine action into an interactive prompt. A1 must add a durable delegated
authorization layer while preserving the canonical workflow and security
boundaries. The design must make it impossible for a delegation to mint a
workflow authority, approve a Human Gate, widen an operation target, or convert
an authentication observation into authorization.

## 2. Goals

1. Define a typed, durable delegation contract that a human can approve for a
   narrow allowlisted class of routine operations.
2. Bind every delegation to the exact workstream and repository/worktree
   identity that the human reviewed; reject a different workspace, branch,
   account, provider, or target.
3. Make scope, expiry, revocation, supersession, usage limits, and concurrency
   semantics deterministic across process restart, compaction, and rehydration.
4. Compose delegation verification with A0's canonical state-derived issuer and
   durable event authorization without replacing either one.
5. Preserve all canonical Human Gates and authentication/security boundaries.
6. Define serializable contracts that a later A2 headless runner can consume
   without relying on chat memory, while leaving A2/A3/A4 implementation out of
   this workstream.
7. Provide an implementation-ready acceptance and failure contract for a
   later approved plan.

## 3. Non-goals and explicit prohibitions

- No source implementation, schema migration, CLI command, or runtime change in
  Step 1.
- No GitHub Issue creation or update, push, PR, merge, review publication, or
  external write.
- No bypass of the canonical workflow, requirements/plan/push/merge Human
  Gates, or any future security gate.
- No delegation of login, OAuth consent, account recovery, CAPTCHA, 2FA, SSO,
  organization-policy acceptance, secret entry, permission escalation, or
  ownership/security changes.
- No general-purpose `allow=true` flag, singleton approval boolean, ambient
  account authority, or delegation inferred from ordinary chat prose.
- No grant of broader rights to a child process, transport adapter, plugin, or
  provider than the human-approved record contains.
- No storage of tokens, cookies, pairing codes, public tunnel addresses,
  secrets, file bodies, diffs, or raw authentication output in workflow state.
- No redesign of A0 receipt/reconciliation semantics and no implementation of
  A2 headless execution, A3 observability, or A4 rollout policy.

## 4. Evidence from the merged A0 baseline

The A1 base is the live `release/v0.1.3-svl.13` commit
`b36a38cdd613ef474460e2ebc4a62180a93e99c7`, with the merged A0 implementation
present. The following seams are requirements evidence, not permission to
change them during Step 1:

| A0 seam | Observed invariant that A1 must preserve |
| --- | --- |
| `createDurableTransportTransaction().beginAndPrepare` | Derives the active canonical binding, creates the workflow issuer, issues one event authorization, and prepares one receipt. |
| `deriveActiveCanonicalBinding` / `createWorkflowAuthorizationIssuer` | The live harness state, active worktree, stage, checkpoint, action, and approval—not caller prose—define workflow authority. |
| durable authorizations, receipts, locks | Atomic secure JSON, owner-only state, lease/CAS generation, monotonic receipt transitions, and crash-safe rehydration. |
| `issueDeliveryAuthorization` | Exact event key, payload hash, message type, source checkpoint/stage, binding, and operation target are checked before a concrete authority is persisted. |
| `prepareAuthorizedDelivery` / `reconcileDelivery` | An authority is not a remote operation result; visible response proof and operation-specific reconciliation are required, and ambiguity never causes an unverified resend. |
| `TeamAiAuthResult` and `github-cli-auth` provider | TeamAI owns auth/credential-context classification. Local code consumes a branded typed result and cannot self-grant from text or an untrusted result file. |
| operation identity and leases | GitHub operation keys are logical-operation scoped, target conflicts fail closed, and competing live owners are protected by generation/CAS. |
| registry, identity, session state | Project/chat/connector/session/repository/worktree identity is exact and bounded; rehydration reconstructs identity rather than trusting stale chat memory. |

## 5. Domain model and vocabulary

The following distinctions are normative for this draft.

1. **Authentication** answers who/which account or credential context is
   currently available. It is classified only by TeamAI's branded
   `github-cli-auth` capability result.
2. **Workflow authority** answers which canonical stage/action the active
   workstream permits. It comes from the canonical harness state and its Human
   Gates, never from a delegation record.
3. **Delegated authorization** is a durable, human-approved, least-authority
   policy that may permit a bounded routine operation after the workflow
   authority has independently allowed that operation. It is provisional as a
  product term; the approved Q401–Q402 decisions confirm the final contract
  direction for planning.
4. **Concrete event authorization** is A0's event-scoped authority for one C2C
   delivery. A delegation may satisfy an applicability check, but it cannot
   mint or replace this authority.
5. **Execution/reconciliation evidence** proves what was attempted and what the
   remote system visibly did. Evidence is not permission and cannot be replayed
   as a grant.
6. **Human Gate** is a canonical workflow decision that must remain explicit,
   even if the underlying transport or operation looks routine.

## 6. Proposed authorization boundary

The intended decision path is:

```text
TeamAI auth result
        + exact active workstream/binding
        + canonical workflow action and gate status
        + applicable human-approved delegation
        + exact operation target/payload
        -> A0 concrete event authorization
        -> A0 receipt / delivery / visible proof / reconciliation
```

Any missing, stale, ambiguous, wider, or untrusted input fails closed. A
delegation is an additional predicate; it is never a substitute for canonical
state, TeamAI auth, A0 binding, or operation evidence.

### 6.1 Action classification inventory

The implementation plan must use an explicit enum/allowlist, not free-form
verbs. The following is the starting classification for human review:

| Class | Examples | Delegation posture |
| --- | --- | --- |
| Canonical workflow gate | Requirements approval, plan approval, visual/review approval, push/PR publication approval, merge approval | Never delegated. A grant must be rejected even if a caller requests it. |
| Authentication/security boundary | Login, OAuth consent, pairing, CAPTCHA, 2FA, password/recovery, account/SSO/organization choice, unexpected scope, role/ownership/secret change | Never delegated. Human-only and TeamAI-owned classification. |
| Bounded transport continuation | Sending a previously canonical, exact C2C HANDOFF/PLAN/EXECUTED/REVIEW/re-review event whose action is already allowed | Candidate for delegation, but cannot advance a workflow stage or create a new approval. |
| Read/reconcile | Exact workspace identity, status, bounded file/search read, git-status/diff read, operation reconciliation for a known logical operation | Candidate for delegation with read-only targets and finite budget. |
| External write/publication | Create/update Issue, push, create/update PR, publish review, merge, change connector/project/account state | Excluded by default because canonical gates or security boundaries apply; any future exception needs a separate explicit decision and grant class. |
| Unknown/compound | A new verb, mixed read/write, target wildcard, provider change, or action whose gate status is unclear | Reject closed; never infer from a similar class. |

The approved first-version vocabulary is only bounded transport continuation
plus exact read/reconcile. GitHub writes, external writes, and all workflow
transitions remain excluded until a separately approved requirements amendment
says otherwise.

### 6.2 Proposed durable grant shape (provisional)

The following is a design contract to refine, not an implementation request.
The provisional record name is `DelegationGrant`.

- `schemaVersion`, stable `grantId`, immutable `createdAt`, and a normalized
  canonical digest.
- Human approval provenance: decision source, approver identity reference,
  approval timestamp, and canonical workflow checkpoint. Store references and
  hashes, never credentials or raw chat transcripts.
- Exact workstream binding: workspace ID/name, canonical repository, exact
  worktree root identity, branch/ref, expected account/provider, and the
  canonical workflow profile/spec identity. Project/chat/connector/session
  identity is included when it is a material target of the action; a
  recoverable ephemeral runtime identity is not silently promoted to permanent
  grant scope.
- An allowlisted `actionClass` plus structured target predicates (repository,
  branch/ref, worktree, operation kind, logical operation ID/event family,
  message type, and read/write mode). Unknown dimensions are denied rather than
  ignored.
- Explicit exclusions, such as Human Gates, auth/security, secrets, account
  changes, connector/project mutation, and privilege expansion.
- `notBefore`, finite `expiresAt`, finite `maxUses`/budget, and an explicit
  revocation/supersession record. The approved policy defaults are 24 hours,
  64 uses for bounded transport continuation, 256 uses for read/reconcile, and
  1 use for explicitly single-use grants. These are policy defaults, not
  hard-coded schema constants.
- Provider/capability requirement, including the exact expected account, stable
  verified TeamAI capability/provider provenance, and a compatible typed
  capability contract version. The grant is not pinned to an implementation
  commit/hash of the Skill.
- An explicit approved supersession relationship such as
  `supersedesGrantIds` or an equivalent policy-family generation. Overlap or a
  narrower scope alone never infers supersession.
- Audit fields containing sanitized outcome references, grant generation, and
  use reservation/consumption state. Do not duplicate A0 receipt payloads or
  persist file bodies.

An applicable grant may be stable across several bounded events, but every
event still receives a new A0 concrete authorization and receipt. Grant use
reservation, A0 event issuance, and remote reconciliation must not be conflated.

## 7. Least-authority and comparison rules

- Compare structured fields exactly after one canonical normalization defined by
  the contract. Do not normalize away meaningful branch, repository, account,
  provider, or operation differences.
- A requested action must be a subset of the approved action class and target;
  no caller may widen a path, repository, branch, account, provider, message
  type, or operation kind.
- Missing, unknown, duplicated, malformed, expired, revoked, superseded, or
  version-incompatible grant fields fail closed.
- Read permission never implies write, publication, approval, account change,
  or secret access. Transport permission never implies workflow progression.
- A grant cannot suppress TeamAI `auth`, `auth_required`, `wrong_account`,
  `security_boundary`, or equivalent non-routine classifications.
- Conversely, a normal authentication continuation that TeamAI already
  classifies as supported and non-Human-Gate must not become a new
  acknowledgement stop merely because A1 exists; it still does not create or
  widen a delegation grant.
- A material authorization-scope change—canonical repository, exact worktree,
  branch/ref, canonical action/stage scope, expected account, incompatible
  capability/provider contract, action class, structured operation target, or
  another approved predicate—immediately invalidates applicability until a new
  human decision is recorded.
- A supported Codex process restart, session reconstruction, browser reconnect,
  compaction, or verified replacement of an ephemeral endpoint does not by
  itself require a new grant when durable scope is unchanged. The A0
  event-authorization path must freshly re-establish exact current identity and
  fail closed if it cannot. Project/chat/connector identity is bound when it is
  a material target of the class, not as a blanket permanent app-instance
  dimension.
- Operation keys, grant IDs, event keys, and receipt IDs remain distinct. A
  successful remote observation cannot be reused as a grant or as a new event
  authority.

## 8. Integration seam and lifecycle

The recommended seam is inside the A0 transaction path, immediately after the
active canonical binding and TeamAI issuer are derived and before
`issueDeliveryAuthorization` persists the concrete event authority:

1. Reconstruct exact active binding and canonical workflow action from harness
   state.
2. Resolve the TeamAI-branded auth/capability result for the exact operation.
3. Load the durable grant by stable identity, verify schema/version, expiry,
   revocation/supersession, use budget, and exact subset match.
4. Reserve the grant use under its own lease/CAS if the class requires a finite
   budget.
5. Ask the canonical issuer to issue the A0 event authority with the original
   binding, event key, payload hash, and operation target.
6. Prepare/send/reconcile through unchanged A0 receipt rules. On any failure,
   release or record the reservation deterministically according to the
   approved contract; never create a replacement event key silently.

The plan must decide whether the verifier is a transaction-level decorator or a
typed proof input to `issueDeliveryAuthorization`; either way, the canonical
issuer remains the source of workflow authority and the verifier cannot mint an
issuer or mutate a Human Gate.

### 8.1 Lifecycle and rehydration

- Creation records an explicit grant-specific human decision, normalized scope
  and scope digest, approval provenance, and immutable durable scope in
  authoritative harness state before any delegated event is attempted. An
  existing canonical Human Gate may record that exact grant decision; no
  standalone UI/CLI ceremony is required, but ordinary conversation prose is
  not authority.
- Every use performs a fresh canonical-state, binding, TeamAI, expiry, and
  revocation check; cached chat memory is insufficient.
- Revocation takes effect before the next event reservation and prevents
  rehydration from resurrecting the grant.
- A replacement supersedes an older grant only when the human-approved grant
  decision explicitly identifies the superseded grant IDs or policy-family
  generation. A narrower or overlapping scope alone never infers
  supersession. Once explicitly superseded, ordering is deterministic and
  visible in audit state.
- Crash recovery can safely distinguish an unused grant reservation, an A0
  `PREPARED`/`SENDING` receipt, a visible remote result, and an ambiguous
  outcome. It must follow A0 reconciliation and never replay a grant as a new
  operation.
- Compaction/restart reconstructs only bounded identifiers and state; no token,
  browser cookie, prompt transcript, or private URL is required.

### 8.2 Concurrency

Grant reads, revocation/supersession, finite-use reservation, A0 authority
issuance, and receipt transitions require owner-checked lease/CAS or an
equivalent atomic protocol. A competing process must not consume the same
single-use grant or reclaim a live reservation. Identical logical operations
remain idempotent; same-key/different-target or same-key/different-payload
conflicts fail closed.

## 9. Security and privacy contract

- The canonical workflow repository/profile/commit is pinned in state; task
  prose has no authority to change it.
- TeamAI `github-cli-auth` is the sole authentication and credential-context
  classifier. A1 may enforce consequences of its typed result but cannot
  reproduce the Skill or let a grant self-authorize. A grant requires the
  exact expected account context, stable verified provider provenance, and a
  typed capability contract version explicitly declared compatible with the
  grant; it is not tied to one implementation commit/hash of the Skill.
- Exact expected account, connector, Project/chat, repository, worktree, and
  branch are part of the binding where the operation needs them. An ambiguous
  account or ownership surface is a human/security boundary.
- OAuth scope or privilege expansion, unexpected organization/SSO, connector
  ownership changes, secret entry, and account recovery remain human-only.
- State and audit artifacts contain non-secret identifiers, hashes, bounded
  timestamps, verdicts, and references only. They must not contain tokens,
  cookies, pairing codes, transient MCP URLs, raw GitHub auth output, or
  pasted source/log bodies.
- Project instructions name the exact connector only; they never embed a
  temporary endpoint.
- Denials and security failures are fail-closed and observable without
  disclosing credentials or sensitive remote responses.

## 10. Failure, rollback, and recovery behavior

| Condition | Required result | Recovery/rollback |
| --- | --- | --- |
| Grant missing, malformed, expired, revoked, superseded, or wrong version | Deny before A0 event issuance | Preserve canonical state; request a new human decision. |
| Requested target/action is wider or compound | Deny; record mismatch reason without secrets | Narrow request or create a separately approved grant. |
| Canonical stage/action is a Human Gate | Deny even when grant says allowed | Stop at the canonical Human Gate. |
| TeamAI reports auth/security boundary or unavailable capability | No delegated attempt | Follow TeamAI/human security path; never retry as authorization. |
| Workspace/repository/ref/account/provider/connector mismatch | Deny and invalidate applicability for this run | Rehydrate exact identity or obtain a new grant. |
| Grant reservation crashes before A0 issuance | Recover reservation by generation/lease rule | Reconcile the same logical event; do not mint a new event key blindly. |
| A0 delivery is ambiguous | Preserve A0 ambiguity and do not resend | Use operation-specific remote evidence and bounded reconciliation. |
| Revocation races with use | Deterministic CAS winner; no partially authorized event | Report whether revocation or reservation won; require a new grant if denied. |
| Remote target disappeared or changed | A0 operation reconciliation fails closed | Keep durable evidence; no target substitution. |
| Storage corruption or unsupported schema | Refuse rehydration | Preserve file for diagnosis; require explicit migration/new grant. |

Rollback is a state transition (revoke/supersede, release a reservation when
the contract permits, or preserve an ambiguous receipt), not deletion of
history. No rollback may erase audit evidence or make an already-visible remote
write appear unattempted.

## 11. Compatibility with later A2/A3/A4

- **A2 headless runner:** consumes a serializable query/decision contract and
  typed denial reasons; it does not infer scope from a prompt or inherit chat
  memory. A2 is not implemented here.
- **A3 observability:** can expose grant IDs, action classes, verdicts, and
  sanitized lifecycle transitions, but never credentials or raw payloads. A3 is
  not implemented here.
- **A4 rollout/policy:** can select a policy version and migration strategy
  only after a separate requirements and Human Gate sequence. There is no
  rollout flag or compatibility shim in A1 Step 1.

No singleton boolean or ambient process-wide permission is acceptable because
it cannot survive multi-worktree concurrency, rehydration, revocation, or
future policy versions safely.

## 12. Acceptance criteria (implementation contract for a later approved plan)

Each criterion is intentionally testable. The criterion is not implementation
authorization in this Step 1 draft.

### Classification and canonical authority

- **A1-AC-001** — Given a request, when its action class is not in the explicit
  allowlist, then the verifier denies it with a stable unknown-action reason and
  never calls the A0 event issuer.
- **A1-AC-002** — Given a request that would cross a requirements, plan,
  publication, review, or merge Human Gate, when a grant claims it is allowed,
  then the canonical gate wins and the event is denied.
- **A1-AC-003** — Given a TeamAI `github-cli-auth` result classified as an
  authentication/security boundary or unavailable capability, when a delegated
  action is attempted, then no authorization is minted and the typed TeamAI
  provenance is retained.
- **A1-AC-004** — Given matching active harness state and a valid applicable
  grant, when A0 begins a transaction, then the grant is only an additional
  predicate and A0 still issues one concrete event authorization bound to the
  exact event, payload, checkpoint, stage, and operation target.

### Least authority and scope

- **A1-AC-005** — Given a grant for one action class and exact structured target,
  when a caller widens repository, branch, worktree, provider, account,
  message type, operation kind, or target, then the request is denied.
- **A1-AC-006** — Given a read-only grant, when a write, publication, approval,
  secret, account, or connector mutation is requested, then the request is
  denied and no write capability is inferred.
- **A1-AC-007** — Given missing, unknown, duplicated, malformed, or
  version-incompatible scope fields, when applicability is evaluated, then the
  verifier fails closed instead of ignoring the fields.
- **A1-AC-008** — Given an exact grant bound to a workstream, when a material
  durable scope dimension (worktree, canonical repository/ref, approved
  action/stage scope, account, compatible provider/capability contract, action
  class, or structured operation target) differs, then the grant is
  inapplicable. Given only a supported process restart, session reconstruction,
  browser reconnect, compaction, or verified ephemeral-endpoint replacement,
  when durable scope is unchanged, then the grant may remain applicable only
  after fresh exact A0 event-time binding verification; inability to verify
  still denies. Project/chat/connector identity is required when material to
  that class's target.
- **A1-AC-021** — Given an action class that requires delegation, when no
  applicable grant is present, then the request fails closed before any side
  effect or concrete A0 event authority is issued.
- **A1-AC-022** — Given the first-version policy defaults, when a grant is
  created without narrower human-approved values, then its policy version
  resolves to a 24-hour lifetime, 64-use bounded transport budget, 256-use
  read/reconcile budget, or 1-use explicitly single-use budget. These defaults
  are policy data and can change only through a future approved policy version;
  they are not silently hard-coded schema semantics.
- **A1-AC-023** — Given a finite-use grant, when reservation fails before a
  concrete A0 event authorization is issued and that pre-issuance failure is
  proven, then the reservation may be returned. Once concrete A0 authority
  exists, the grant use is consumed; a definite retry or reconciliation reuses
  the same logical operation/event authority and consumes no second grant use.
- **A1-AC-024** — Given a grant requiring an exact account, verified TeamAI
  provider provenance, and compatible typed capability contract version, when
  the account is ambiguous, provenance is unverified, or the capability
  version is incompatible, then authorization is denied. A change to the
  Skill's implementation commit alone does not deny a contract-compatible
  provider.
- **A1-AC-025** — Given an existing canonical Human Gate that presents the
  exact grant scope, when the human explicitly approves and the harness records
  the normalized scope/digest and provenance in authoritative state, then the
  grant may be created without a second standalone UI/CLI ceremony. Given only
  conversation prose, then no grant authority exists.
- **A1-AC-026** — Given a replacement grant, when its approved decision does
  not explicitly identify superseded grant IDs or a policy-family generation,
  then overlap or narrower scope cannot revoke the older grant implicitly.
  Given an explicit relationship, then the old grant is unusable and its
  historical evidence is retained.
- **A1-AC-027** — Given a workstream that has not reached terminal workflow
  state, when grant audit state is retained, then it includes grant
  ID/generation, approval provenance reference, binding and action/target
  digests, verdict, reservation/use transition, A0 authority reference, A0
  receipt/reconciliation reference, and revocation/supersession evidence for at
  least the workstream lifetime, without credentials, tokens, cookies, codes,
  raw auth output, source bodies, diffs, or transient MCP URLs.
- **A1-AC-028** — Given any Issue/PR/review/push/merge publication, connector,
  Project, account, or comparable external write, or any canonical Human Gate,
  when a grant requests it, then the first-version vocabulary rejects it
  categorically; no grant may silently delegate or manufacture the gate.
- **A1-AC-029** — Given an A1 grant, when it is evaluated from another
  worktree, branch/ref, or repository-level parallel checkout, then it is
  denied. Observed commit and dirty state may refresh event-time A0 evidence but
  are not treated as immutable long-lived grant identity.
- **A1-AC-030** — Given a transport, read, or reconcile request, when its
  class-specific typed predicates (event family/logical review target,
  read-only surface/resource/path, or exact operation kind/id/target) are
  missing or unknown, then the request fails closed rather than falling back to
  a free-form verb or string heuristic.

### Lifetime, revocation, and supersession

- **A1-AC-009** — Given a finite `notBefore`/`expiresAt` window, when evaluation
  occurs before or after that window, then only the in-window request can
  proceed and the denial reason is deterministic.
- **A1-AC-010** — Given a revoked grant, when a process restarts or a new event
  is attempted, then the grant cannot be resurrected from cached state.
- **A1-AC-011** — Given overlapping grants where one approved replacement is
  narrower, when the replacement explicitly identifies the superseded grant(s)
  or policy-family generation and both are rehydrated, then supersession order
  is deterministic, the broader grant is not usable, and history remains
  auditable. Given overlap without that explicit approved relationship, when
  either grant is evaluated, then neither is implicitly superseded.
- **A1-AC-012** — Given `maxUses` or a bounded budget, when two competing
  processes race, then at most the approved number of reservations succeeds by
  owner-checked lease/CAS; losers receive a stable conflict/lease reason.

### Durable transport and recovery

- **A1-AC-013** — Given a process crash between grant reservation and A0
  issuance, when the workstream is rehydrated, then recovery distinguishes the
  reservation from the A0 receipt and resumes/reconciles the same logical event
  without blind resend.
- **A1-AC-014** — Given an A0 ambiguous delivery or missing visible response,
  when a valid grant remains, then A0 reconciliation rules still apply and the
  grant cannot be used to force a second event.
- **A1-AC-015** — Given compaction/restart, when only serialized durable state
  is available, then the verifier reconstructs bounded identity and scope
  without chat transcript, token, cookie, pairing code, or transient endpoint.
- **A1-AC-016** — Given same logical operation/key with a different payload or
  target, when a delegated request arrives, then the existing A0 operation
  conflict is preserved and no second authority is issued.

### Audit, privacy, and future consumers

- **A1-AC-017** — Given a grant decision or denial, when it is persisted or
  observed, then the record contains stable grant/action/binding/verdict
  references but no secret, raw credential output, file body, diff, pairing code,
  or transient MCP URL.
- **A1-AC-018** — Given an A2-compatible consumer, when it asks whether a
  routine action is eligible, then it receives a versioned serializable result
  with typed allow/deny and does not receive ambient process authority or chat
  memory. A2 itself remains out of scope here.
- **A1-AC-019** — Given an observability consumer, when it inspects lifecycle
  history, then it can correlate grant generation, reservation, A0 event, and
  receipt/reconciliation without obtaining credentials or permission to replay
  the event.
- **A1-AC-020** — Given a policy/schema version that the runtime cannot safely
  interpret, when it rehydrates, then it blocks with a migration/new-approval
  reason and preserves the original evidence.

## 13. Edge cases and test matrix

The later plan must cover at least these cases with deterministic tests and,
where relevant, one live bounded verification:

- exact target match versus path/repository/branch/account/provider widening;
- action enum unknown, duplicate, mixed read/write, or compound request;
- grant not-yet-valid, exactly-at-expiry, expired, revoked, and superseded;
- default-policy grants at 24 hours/64 transport uses/256 read-reconcile uses,
  explicit narrower policy values, and single-use exhaustion;
- explicit `supersedesGrantIds`/policy-family generation versus overlapping
  grants with no supersession relationship;
- one-use and finite-use grants under two competing processes;
- crash at reservation, before/after A0 concrete authorization, `SENDING`,
  visible response, and reconciliation boundaries, including reservation
  return only for proven pre-issuance failure;
- changed canonical checkpoint/action, changed commit/dirty event evidence, and
  changed worktree root after approval;
- stale connector/session/Project or wrong ChatGPT account;
- supported process/session/browser/compaction/ephemeral-endpoint recovery with
  fresh A0 exact binding versus material scope changes;
- TeamAI unavailable, wrong/incompatible capability contract version, unverified
  provider provenance, auth-required, wrong-account, security-boundary, and
  successful typed result;
- same operation key with changed payload/target and remote unknown/ambiguous
  results;
- compaction with only state files, schema upgrade/downgrade, truncated or
  corrupted durable records;
- restart after revocation or supersession and preservation of audit history;
- no grant for a canonical Human Gate, external write, login, OAuth, pairing,
  secret, ownership, or privilege change.

## 14. Decision frontier (historical wording, now resolved)

The following Q-ID wording is retained as the prior draft history. The
authoritative answers are recorded in Section 16 below. Q401–Q414 are all
resolved; no new Q-ID was required. Any future change must preserve these IDs
and append a new ID rather than renumbering them.

- **Q401 — Eligible default operation classes.** Should the first A1 grant
  allow only bounded C2C transport continuation plus exact read/reconcile
  (recommended), or should it include any GitHub Issue/PR/review write? Impact:
  a wider default crosses more canonical gates and materially increases blast
  radius.
- **Q402 — Scope vocabulary and comparison.** Is the proposed explicit action
  enum plus structured exact target predicates the contract (recommended), and
  which dimensions are mandatory for each class? Impact: this determines whether
  a later A2 runner can prove a request is a subset without string heuristics.
- **Q403 — Lifetime and usage defaults.** Should grants require a short finite
  expiry and explicit `maxUses`/budget (recommended), and what defaults are
  acceptable for transport versus read/reconcile? Impact: longer/unbounded
  grants increase stale-approval risk.
- **Q404 — Human approval provenance.** Which canonical record is the source of
  an approval: a state transition at a Human Gate plus grant ID (recommended),
  or an additional explicit UI/CLI approval ceremony? Impact: chat prose alone
  must never mint a grant.
- **Q405 — Supersession.** Should a narrower overlapping grant automatically
  revoke/supersede the broader grant in a deterministic order (recommended), or
  must the human revoke the old grant separately? Impact: overlapping policy
  ambiguity can otherwise produce privilege expansion.
- **Q406 — Account and provider binding.** Must every grant name the exact
  expected TeamAI capability/provider and account context (recommended), or may
  a trusted provider alias be used? Impact: aliases can hide wrong-account or
  organization/SSO changes.
- **Q407 — C2C continuation boundary.** May a delegated transport grant send
  only an already-canonical event (recommended), or may it request a new stage,
  approval, or task? Impact: the latter would launder workflow authority.
- **Q408 — Audit retention.** Which sanitized identifiers, hashes, and lifecycle
  transitions must be retained and for how long (recommended minimum: grant
  generation, binding digest, action/target digest, verdict, reservation, A0
  event/receipt references)? Impact: stronger retention aids recovery but must
  not become a secret store.
- **Q409 — Remote ambiguity.** Should target timeout/unknown always remain A0's
  reconciliation state with no grant-backed retry (recommended)? Impact: retry
  policy must not turn an ambiguous remote write into a duplicate.
- **Q410 — Use-count concurrency.** Is owner-checked lease/CAS reservation the
  required mechanism for finite uses (recommended), and is a reserved use
  returned only for a proven pre-issuance failure? Impact: this controls
  duplicate authorization under crash/race.
- **Q411 — Invalidation events.** Should any canonical stage/action, repository,
  worktree, account/provider, connector/session, or operation-target change
  invalidate the grant immediately (recommended)? Impact: narrower invalidation
  risks stale scope; broader invalidation costs re-approval.
- **Q412 — A2 decision contract.** Should A2 receive a typed allow/deny proof
  with grant and canonical-state references but no authority (recommended), or
  a different query/result shape? Impact: a proof-only seam keeps A2 from
  self-authorizing.
- **Q413 — Worktree binding strictness.** Must a grant bind to one exact worktree
  root and branch/ref (recommended), or can a human-approved repository-level
  scope span worktrees? Impact: repository-level scope is easier to reuse but
  weakens isolation between parallel workstreams.
- **Q414 — External write classes.** Should Issue updates, PR publication,
  review publication, and merge remain categorically excluded from A1's first
  grant vocabulary (recommended), with each reconsidered in a separate
  requirements amendment? Impact: including them now would overlap canonical
  publication/merge gates.

## 15. Assumptions and dependencies

- A0's durable state and transport APIs are the starting contract and remain
  backward compatible unless a later approved plan states a versioned change.
- The canonical workflow repository is pinned to profile `codex-c2c-v2`,
  version `2.3.1`, commit `60d17218c256098522e063b5bf4731cecc9c1f12`, with the
  v2.3 review contract.
- TeamAI remains the shared authority for GitHub authentication classification;
  its current capability name is `github-cli-auth`.
- The exact A1 connector/Project/chat binding is not yet ready. No C2C review
  is required for this Step 1 discovery, but all future C2C-dependent steps
  must verify the isolated A1 workspace before use.
- The explicit user decision in this session answers and approves Q401–Q414;
  the normalized decision record below is now the authoritative Step 1
  approval basis for Issue conversion.
- The live release-base identity and current local build are evidence only; no
  source implementation has been authorized by this artifact.

## 16. Requirements Approval Record

Approval source: explicit user answers in the A1 Requirements Approval task,
received 2026-10-02 (Asia/Tokyo). The user confirmed that the complete current
Q401–Q414 frontier is resolved and explicitly approved this resulting Step 1
requirements set. No new Q-ID was required.

| Q-ID | Authoritative decision recorded for planning |
| --- | --- |
| Q401 | First vocabulary is bounded C2C continuation, exact read-only inspection, and known-operation reconciliation only; all external writes/publication remain excluded. |
| Q402 | Use an explicit typed action enum and structured common/class-specific target predicates; unknown or missing required dimensions fail closed. |
| Q403 | Require finite lifetime/use; policy defaults are 24 hours, 64 transport uses, 256 read/reconcile uses, and 1 for explicitly single-use grants. Defaults are policy data, not schema constants. |
| Q404 | Require grant-specific human approval with normalized scope/digest in authoritative state; an existing Human Gate may record it, with no extra ceremony; prose alone is not authority. |
| Q405 | Supersession requires an explicit approved grant-ID/policy-family relationship; overlap or narrower scope alone never infers it. |
| Q406 | Bind exact expected account, verified TeamAI provider provenance, and compatible typed capability contract version; do not pin to a Skill implementation hash. |
| Q407 | A transport grant can execute only an event already permitted by canonical workflow; it cannot create/approve stages or satisfy a Human Gate. |
| Q408 | Retain sanitized grant/A0 audit evidence through terminal workflow state; no automatic GC or secrets. |
| Q409 | Timeout/unknown/ambiguous remote results remain exclusively under A0 reconciliation; a valid grant cannot authorize a retry. |
| Q410 | Use owner-checked lease/CAS reservation; return use only for proven pre-A0-authority failure; after A0 authority, reuse the same logical authority. |
| Q411 | Material durable scope changes invalidate immediately; supported restart/reconstruction/reconnect/compaction/verified ephemeral recovery do not alone require a new grant, but fresh A0 exact binding is mandatory. |
| Q412 | A2 receives only a versioned serializable typed allow/deny proof, never execution authority. |
| Q413 | Bind to one exact worktree root and branch/ref; commit/dirty state remains event-time A0 evidence. |
| Q414 | Keep all external writes/publication and connector/Project/account mutations categorically excluded; future widening requires a new requirements amendment. |

Approved Q-ID set: `Q401–Q414`  
Pending Q-ID set: none  
New Q-ID required: `false`  
Approval status: `APPROVED`

## 17. Next canonical action and gate

The Step 1 Requirements Approval Human Gate is complete. The approval-free
Step 2 Issue Finalization conversion was completed as Issue #8 and is recorded
in `01-issue-snapshot.md`; the live Issue is now the canonical Requirements
source of truth. The conversion preserved meaning and included the required
sections. The next canonical action is Step 3 planning.

REQUIREMENTS_APPROVED
REQUIREMENTS_READY_FOR_APPROVAL
