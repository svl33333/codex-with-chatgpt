# A0 — Reliable C2C Transport Core

Workstream: `a0-reliable-c2c-transport-core`
Repository: `svl33333/codex-with-chatgpt`
Branch: `a0-reliable-c2c-transport-core`
Base: `release/v0.1.3-svl.13` (`13d13f0a05bfaa102394de7145607241d9da1c48`)
Workflow: `codex-c2c-v2` 2.3.1 (`60d17218c256098522e063b5bf4731cecc9c1f12`)

This document is the Step 1 working requirements artifact. It is not an
implementation plan and does not authorize source changes or publication.

## 1. Problem statement

The active-session C2C path can already persist a basic ChatGPT conversation
pointer, a local protocol checkpoint, conversation identity, and a message
idempotency key. Those pieces are not yet one durable authority contract, and
the browser/Skill path still relies on transient conversation context for
several decisions. Live development exposed five concrete failures:

1. After Codex context compaction, an already-authorized workstream asked the
   user to type `送信` before a routine review/re-review delivery.
2. After compaction, one intended C2C REVIEW/re-review event was split into
   multiple ChatGPT user messages, including partial fragments.
3. A ChatGPT reasoning setting configured as Extra High / `極高` drifted after
   Project/chat/session/retry/reconnect transitions.
4. Browser/send timeouts left delivery ambiguous and created duplicate-send risk.
5. A substantive reviewer response could already exist after a transport
   anomaly, yet recovery could start a duplicate review instead of consuming
   the existing result.

The result is a human-dependent control plane. A future local coordinator must
be able to run independent workstreams without copying messages between
ChatGPT and Codex, while preserving real authentication, consent, and other
security boundaries.

## 2. Goal

Make active-session ChatGPT ↔ Codex control-message transport durable,
identity-bound, atomic, observable, and idempotent. After a Codex session is
compacted, recreated, reconnected, or rate-limit recovered, the runtime and
Skill must rehydrate authority from durable state and continue an allowlisted
routine control delivery automatically when all identities still match.

A0 must establish the transport foundation for later multi-workstream
coordination. It does not change the independent-review semantics: ChatGPT
continues to inspect the current workspace, source, diff, tests, execution
records, Issue/plan, and checkpoint through the read-only MCP connector.

## 3. Non-goals and preserved workstreams

The following are explicitly outside A0:

- Windows boot auto-start or automatic reboot recovery;
- Host Capability Broker production validation or its external Windows lane;
- P0-2 AC-211/reboot-zero-touch work;
- dashboard or portfolio UI;
- Akapen automation;
- resource garbage collection;
- multi-workstream scheduling/orchestration (future work after A0-A4);
- making the review payload self-contained with source, diff, logs, or file
  bodies;
- changing the canonical `codex-c2c-v2` workflow, its Human Gates, or its
  review/remediation contract;
- bypassing login, 2FA, CAPTCHA, explicit consent, ownership ambiguity,
  unexpected OAuth scopes, or destructive/security-sensitive approval.

Preservation obligations:

- `host-capability-broker-windows-user-context` remains at Step 5 `BLOCKED` /
  `REQUIRED_CAPABILITY_UNAVAILABLE`; no additional host/reboot validation is
  performed.
- `planner-c2c-restart-resilience-p0-2` keeps PR #4 open and unmerged; its
  worktree, branch, state, and AC-211 blocker are not edited.
- Full Auto M1 keeps its historical v2.2.0 pin/state in its own repository.

## 4. Current repository facts and ownership

The A0 worktree starts from the clean release branch and is independent of the
P0-2 worktree. The runtime already contains these relevant foundations:

| Area | Current evidence | A0 implication |
| --- | --- | --- |
| Protocol | `docs/protocol.md` defines `INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN/DONE/BLOCKED`, local checkpoints, `<1 KB` control messages, and MCP-fetched evidence. | Preserve protocol meanings; add durable transport authority around them. |
| Message delivery | `src/conversation/delivery.ts` has `prepared`, `sending`, `confirmed`, and `ambiguous` checkpoints keyed by task, iteration, and message ID. | Extend/reconcile it rather than creating a second unrelated delivery abstraction. |
| Conversation identity | `src/conversation/registry.ts` binds project, conversation, workspace, repository, work ID, stage, and role. | Add exact session/connector binding and durable authority checks. |
| Session recovery | `src/session/state.ts` stores Project/chat pointers and a bounded protocol checkpoint. | Rehydrate from this plus a typed authorization/receipt; prose memory is not authority. |
| Connector identity | `src/connection/identity.ts` and `src/connection/reconciler.ts` already enforce workspace/repository/installation/endpoint identity and timeout reconciliation for connector setup. | Reuse the identity conventions; do not conflate connector reconciliation with message delivery. |
| CLI/state writes | `src/config/paths.ts` provides user-local state and owner-only JSON writes. | Add atomic, durable transport writes without broad unrelated storage migration. |
| Browser boundary | `skill/SKILL.md` owns the built-in IAB rules, composer interaction, tab reuse, and reply polling. | Runtime supplies a typed transport adapter/evidence contract; Skill must consume it and stop relying on acknowledgement-only prose. |
| Shared workflow | TeamAI distributes the C2C Skill and `codex-c2c-v2`; canonical workflow is external and pinned. | Change runtime/Skill contracts only when required; never edit canonical workflow semantics here. |

The actual executable browser control is outside the TypeScript runtime. A0
therefore has two coordinated ownership surfaces:

1. runtime/session/delivery state, identity validation, payload construction,
   idempotency, reconciliation, and test doubles in this repository; and
2. the runtime-owned `skill/SKILL.md` (and its TeamAI distribution contract if
   required) for IAB composer atomicity, rehydration rules, send-time reasoning
   checks, and remote visible-bubble evidence.

No change to the canonical workflow repository is authorized by this
requirements document.

## 5. Domain model and canonical terminology

These terms are the durable model for A0:

- **Workstream identity** — stable identity of the A0 or later development
  workstream, including repository and exact workspace checkout.
- **C2C task identity** — task/checkpoint identity for one protocol loop,
  including the task ID, canonical workflow step/stage, and iteration/sequence.
- **Workspace identity** — exact workspace ID/name, canonical repository, branch
  or worktree identity, and normalized workspace root expected by the connector.
- **Project/chat/session identity** — exact ChatGPT Project ID (when used), chat
  or conversation ID/URL bound to this Codex conversation, and session identity;
  a display name is never enough.
- **Connector/binding identity** — exact connector name plus the persisted
  workspace, repository, installation, endpoint mode/fingerprint, and account /
  ownership evidence required by the existing connection contract.
- **Control-message envelope** — bounded `[C2C]` payload containing state,
  identity references, iteration, counts/hashes, and MCP review instructions;
  it never carries source, diff, log, or file-body evidence.
- **C2cDeliveryAuthorization** — durable typed permission for one specific
  allowlisted outbound logical event. It is not a generic “C2C is enabled”
  flag and cannot be reconstructed from conversation memory.
- **C2cDeliveryReceipt** — durable typed lifecycle/evidence record for the same
  event, including prepared/sending/delivered/waiting/response state and
  observable remote evidence.
- **Remote delivery evidence** — sanitized evidence that the exact event is
  visible in the expected chat (message/bubble identity, exact payload hash or
  equivalent, count, timestamp, and/or response binding), never a secret or
  uncontrolled page dump.
- **Routine bounded transport** — allowlisted INIT/HANDOFF/PLAN/EXECUTED/REVIEW
  or re-review control-message delivery within a valid authorization.
- **Genuine Human Gate** — canonical requirements/visual/push/merge approval,
  login, 2FA, CAPTCHA, ownership ambiguity, consent, unexpected scope, or
  destructive/security-sensitive decision. Routine transport is not a Human
  Gate.

The authority order after rehydration is: canonical workflow → recorded
workstream/session state → exact workspace/repository and connector identity →
typed delivery authorization/receipt → live remote evidence. Conversation
memory, summaries, and acknowledgement-only text are evidence at most, never
authority.

## 6. Proposed durable transport contract

The names below are recommendations for implementation. If an equivalent
existing type is found, it must be extended rather than duplicated.

### 6.1 Authorization fields

`C2cDeliveryAuthorization` must bind at least:

- schema version and authorization ID;
- workstream identity;
- C2C task/checkpoint ID;
- canonical workflow step and stage;
- message type (`INIT`, `HANDOFF`, `PLAN`, `EXECUTED`, `REVIEW`, `RE_REVIEW`,
  or another explicitly allowlisted bounded type);
- iteration/sequence and logical message ID;
- exact workspace ID/name/root, repository identity, branch/worktree identity;
- exact Project ID, chat/conversation ID/URL, and Codex session identity;
- exact connector/binding ID/name and endpoint/installation fingerprint;
- allowed transport action (one complete composer fill and one submit);
- deterministic idempotency/delivery key and payload hash/size limits;
- authorization creation/expiry/revocation metadata and source checkpoint;
- required send-time model/reasoning policy (`Extra High` / `極高` for C2C
  Review/re-review) and whether correction is permitted; and
- no raw tokens, cookies, pairing codes, or message bodies beyond the bounded
  payload/hash required for reconciliation.

### 6.2 Receipt fields and lifecycle

`C2cDeliveryReceipt` must bind to the authorization and record:

- lifecycle state: `PREPARED → SENDING → DELIVERED → RESPONSE_WAITING →
  RESPONSE_RECEIVED`, with explicit `AMBIGUOUS`, `FAILED_DEFINITE`,
  `RECONCILED`, and `BLOCKED` outcomes where needed;
- send-attempt count, timestamps, and process/session identity;
- exact payload hash, bounded byte/character count, and fragmentation check;
- observed ChatGPT Project/chat/connector identity at send time;
- observed live reasoning setting immediately before submission, whether it was
  corrected, and sanitized correction/error evidence;
- remote message/bubble evidence proving one logical event produced exactly one
  visible user-message bubble;
- timeout/error classification and reconciliation attempts;
- response identity/hash/checkpoint/stage binding and a consumed-once marker;
- next action (`wait`, `inspect`, `safe retry same event`, `fail closed`, or
  `Human Gate`), never an implicit resend authorization.

Persist `PREPARED` and `SENDING` before touching the composer. Mark
`DELIVERED` only after observable remote evidence, not merely after a browser
call returns. A timeout is ambiguous, not failure. An ambiguous event must be
reconciled against the existing chat before retry; if the exact message is
visible, wait for its response; if definite failure is proven, retry the same
logical event/key at most as permitted by the durable receipt.

## 7. Required behavior and invariants

### 7.1 Rehydration

After context compaction, summarized-context restoration, Codex session
recreation, browser/tab reattachment, ChatGPT conversation rollover,
reconnect, or rate-limit recovery, the next C2C action must reload and verify:

1. the pinned canonical workflow and current TeamAI/C2C Skill;
2. recorded workstream/session/checkpoint state;
3. current repository/worktree and workspace identity;
4. exact Project/chat/session and connector/binding identity; and
5. the typed delivery authorization and receipt for the next logical event.

When all durable identities and the allowlist still match, routine delivery
continues without asking for `送信`, `OK`, `続行`, or equivalent. If any
authority is absent, stale, expired, revoked, or mismatched, fail closed into
the existing recovery/rebinding path; do not infer authorization from the
summary or mint a new task/event merely to continue.

### 7.2 Atomic message delivery

For INIT/HANDOFF/PLAN/EXECUTED/REVIEW/re-review:

- build one complete bounded payload before touching the composer;
- keep normal control messages small and direct ChatGPT to read evidence via
  MCP; never paste file contents, diffs, logs, or long file lists;
- perform exactly one logical composer fill/write and one submit;
- verify exactly one resulting visible user-message bubble bound to the expected
  chat, connector, payload hash, and event key;
- never turn an oversized event into numbered fragments or continuation
  messages. Reduce to identifiers, state, counts, checkpoint/message identity,
  and review instructions instead.

### 7.3 Fragmentation and reviewer response recovery

If a partial or multiply delivered message is observed, classify it as a
transport defect, do not send a remaining fragment, and inspect the reviewer
thread first. If one complete substantive canonical response is already bound
to the expected workspace/checkpoint/stage, consume it once and record the
transport defect separately; never run a duplicate review to repair history.
If the response is incomplete or unbound, reconcile the delivery and send one
fresh complete bounded event only after the receipt permits it.

### 7.4 Reasoning-setting pre-send guard

Every ChatGPT C2C outbound event must inspect the live selected reasoning
setting immediately before send. C2C Review/re-review requires Extra High /
`極高`; correct drift where the browser/runtime supports it, verify again
before submit, and persist sanitized observed/corrected/failed evidence. Do
not assume the setting survives retry, reconnect, Project/chat switch, rate
limit recovery, compaction, or session recreation. If inspection or correction
is unavailable, record that fact explicitly and apply the configured fail-safe
instead of claiming compliance.

### 7.5 Human boundaries

The existing canonical Human Gates and security boundaries remain unchanged.
Routine bounded transport, browser filling, verified expected C2C warning
confirmation, and waiting for a substantive reviewer reply are not new Human
Gates. Login, 2FA, CAPTCHA, unverified consent, ambiguous ownership,
unexpected OAuth scope, destructive/security-sensitive action, and canonical
requirements/visual/push/merge decisions still stop as prescribed.

## 8. Acceptance criteria (Given / When / Then)

### A0-AC-001 — Authorized routine REVIEW send

Given a valid unexpired authorization and matching workspace, Project/chat,
connector, checkpoint, and reasoning setting, when a routine REVIEW is due,
then one complete event is sent automatically without an acknowledgement-only
user prompt and one delivery receipt is recorded.

### A0-AC-002 — CODEX context compaction/session reconstruction

Given a valid receipt and authorization before CODEX context compaction,
summarized-context restoration, or Codex session reconstruction, when the next
re-review is requested after Codex-side rehydration, then durable authority is
reconstructed and the bounded re-review auto-sends atomically without asking
the user to type `送信`/`OK`/`続行`. This is a Codex-side transport criterion;
ChatGPT-side review-chat recreation is a separate reviewer-resilience test.

### A0-AC-003 — Missing or stale receipt

Given a missing, expired, revoked, or identity-mismatched receipt, when a C2C
event is requested, then no implicit authorization is created and the existing
recovery/fail-closed path is selected.

### A0-AC-004 — Atomic event

Given any allowlisted control event, when it is delivered, then exactly one
logical event creates exactly one ChatGPT user-message bubble; no continuation
fragment is emitted.

### A0-AC-005 — Oversized event

Given a proposed payload over the bounded limit, when it is prepared, then it is
reduced to identifiers/state/counts/checkpoint/review instructions and ChatGPT
is directed to MCP-fetched evidence; source/diff/log bodies are not pasted.

### A0-AC-006 — Timeout after remote arrival

Given a submit timeout and a remote bubble that actually arrived, when recovery
inspects the existing thread, then the receipt is reconciled as delivered or
response-waiting and no duplicate event is sent.

### A0-AC-007 — Definite submit failure

Given a submit failure proven before remote acceptance, when retry is permitted,
then the same logical event/idempotency key is retried safely and one final
visible message exists.

### A0-AC-008 — Existing reviewer response

Given ambiguous or fragmented transport followed by one substantive canonical
review response for the expected checkpoint/stage, when recovery runs, then
that response is consumed once, the transport defect is recorded separately,
and no duplicate review is triggered.

### A0-AC-009 — Reasoning drift

Given reasoning has drifted from Extra High / `極高`, when a Review/re-review is
about to send, then the guard detects it, corrects it where supported, verifies
again, and records sanitized evidence (or records inability and fails safely).

### A0-AC-010 — Identity mismatch

Given a different Project/chat/connector/workspace/repository/session or
worktree, when a saved authorization is encountered, then it is not reused and
the transport fails closed into recovery/rebinding.

### A0-AC-011 — Genuine Human Gate

Given login, 2FA, CAPTCHA, unverified consent, ownership ambiguity, unexpected
scope, or a canonical requirements/visual/push/merge decision, when the event
reaches that boundary, then the existing Human Gate stops correctly and A0
does not auto-approve it.

### A0-AC-012 — Ten-send CODEX compaction reconstruction regression

Given one workstream with at least ten consecutive valid C2C control sends,
when CODEX context compaction and Codex session reconstruction are forced, then
the next bounded REVIEW/re-review still sends automatically and atomically with
correct identity and no duplicate or acknowledgement-only prompt. This test
does not stand in for ChatGPT-side review-chat recreation.

### A0-AC-013 — Rollover/restart compatibility

Given a session/checkpoint rollover or Codex process restart without a Windows
reboot, when the durable state is reloaded, then valid in-flight delivery is
reconciled and the next event continues without re-pairing or connector
recreation.

### A0-AC-019 — Shared reviewer Skill activation

Given the shared C2C Reviewer Skill is available, when ChatGPT receives a
bounded `[C2C]` review or re-review event, then the reviewer follows the
expected MCP-first procedure and structured output contract without requiring
previous reviewer instructions to remain in chat context.

### A0-AC-020 — Reviewer procedure reconstruction

Given the ChatGPT review conversation is recreated or its previous prose is
unavailable, when a new bounded C2C event arrives and the Reviewer Skill is
available, then reviewer procedure is reconstructed from the shared Skill plus
current workspace/workflow evidence. This is separate from Codex-side context
compaction/session reconstruction.

### A0-AC-021 — Skill does not grant authority

Given the Reviewer Skill is present but the task, checkpoint, workspace,
Project/chat, MCP-app, or review-stage identity is stale or mismatched, then
Skill presence does not authorize transport, workspace reuse, review against
the wrong target, or workflow mutation.

### A0-AC-022 — Skill-unavailable fallback

Given ChatGPT Skills are unavailable or cannot be verified, when an otherwise
valid C2C review is due, then the explicit bounded reviewer-instruction
fallback performs the same MCP-first review procedure without a new Human Gate
solely for Skill absence, and the system does not falsely claim Skill
activation.

### A0-AC-023 — Shared Skill workstream isolation

Given multiple independent workstreams use the same shared Reviewer Skill,
when each review runs, then exact MCP-app + Project/chat +
workspace/task/checkpoint binding prevents cross-workstream evidence or state
leakage.

## 9. Deterministic test coverage

The implementation stage must add deterministic coverage for each acceptance
criterion and, at minimum, the following cases:

1. authorized routine REVIEW without confirmation;
2. CODEX context compaction/session reconstruction rehydrates authority and
   auto-sends re-review;
3. missing/stale receipt fails closed;
4. one event produces one message and no fragment;
5. oversized payload is reduced and evidence remains MCP-fetched;
6. timeout with actual remote arrival reconciles without duplicate;
7. definite failure retries safely to one final message;
8. existing reviewer result is consumed once without duplicate review;
9. reasoning drift is detected/corrected where possible;
10. wrong Project/chat/connector/workspace does not carry authority;
11. genuine Human Gate still stops;
12. ten-send sequence plus forced CODEX context compaction/session
    reconstruction succeeds;
13. a shared Reviewer Skill-backed bounded review follows the MCP-first
    procedure and structured response contract;
14. the bounded explicit reviewer-instruction fallback behaves equivalently
    when the Skill is unavailable or unverifiable;
15. Skill-backed and fallback paths produce equivalent review/output-contract
    dispositions for the same evidence;
16. wrong-workspace rejection occurs despite Skill availability;
17. stale or mismatched checkpoint/review-stage identity is rejected despite
    Skill availability;
18. two independent workstreams can share one Reviewer Skill without
    cross-binding, evidence, or state leakage;
19. ChatGPT review-chat recreation restores reviewer procedure as a separate
    reviewer-resilience case; and
20. CODEX context compaction/session reconstruction separately verifies durable
    authority rehydration and atomic outbound delivery.

Tests must include payload hashes, exact identity mismatches, response binding,
remote visible-bubble evidence, and sanitized reasoning-setting evidence. Live
browser acceptance remains separate from deterministic adapter tests and must
not be falsely claimed from fixtures alone. A0-AC-002 and A0-AC-012 must
explicitly exercise CODEX context compaction/session reconstruction; ChatGPT
review-chat recreation must not be used as a substitute for those tests.

## 10. Failure behavior, observability, and rollback

Transport outcomes must distinguish at least:

- authorization missing/stale/revoked;
- identity mismatch or ownership ambiguity;
- browser/tab/session unavailable;
- reasoning inspection/correction unavailable or wrong;
- payload oversized or malformed;
- composer fill/submit definite failure;
- submit timeout / ambiguous remote result;
- partial or multiply delivered event;
- remote response pending, substantive, incomplete, mismatched, or failed;
- genuine Human Gate required.

Durable diagnostics contain identifiers, hashes, bounded counts, timestamps,
state transitions, and sanitized browser/model evidence only. They never contain
OAuth tokens, cookies, pairing codes, bearer headers, raw source/diffs/logs, or
unbounded page text. Existing connector and workspace secrets remain outside
the repository.

Rollback must be namespaced and ownership-aware. Removing A0 transport state
must not delete or recreate pre-existing connectors, OAuth authorization,
Projects, chats, tunnel resources, P0-2 state, Host Broker state, or Full Auto
M1 artifacts. A receipt/authorization migration must preserve readable legacy
session/checkpoint files and fail closed on ambiguous legacy data rather than
guessing.

## 11. Assumptions and impact if false

| Assumption | Impact if false |
| --- | --- |
| The existing `src/conversation/delivery.ts` is the intended runtime seam. | Extend a different existing abstraction only after proving ownership; do not duplicate types. |
| The IAB/browser automation can expose live selected reasoning state and visible bubble evidence. | Record a capability limitation and fail closed for the affected guard; do not claim compliance or blindly send. |
| ChatGPT/MCP can expose enough remote message/thread identity to reconcile a timeout without pasting content. | Add a bounded remote-evidence adapter or remain in recovery waiting; never blind-resend. |
| Project/chat/session identifiers remain stable enough to bind exact conversations. | Treat rollover as a new binding requiring rehydration/rebinding, not as a display-name match. |
| Existing connector identity/reconciliation remains compatible. | Preserve its contract and isolate any A0 adapter change; do not churn connectors during routine transport. |
| State-directory writes can be made atomic on Windows and supported platforms. | Use a documented fail-closed storage error; do not mark PREPARED/SENDING only in memory. |
| The required ChatGPT reasoning control is available for this session. | Persist the actual observed setting and mark the limitation; no separate Human Gate is invented solely for model/mode drift. |

## 12. Stable Q-ID design tree

The user task settles the high-level goal, non-goals, single-event rule,
identity requirements, lifecycle intent, and required regression cases. The
following questions are the remaining design frontier. Recommendations are the
default for Step 3 planning; they are not silently treated as approvals.

### Q301 — Durable type boundary

**Question:** Should `C2cDeliveryAuthorization` and `C2cDeliveryReceipt` be
introduced as the canonical names, or should an equivalent existing delivery
type be extended under another repository term?

**Recommendation:** Extend `src/conversation/delivery.ts` with the canonical
typed concepts (or a clearly documented equivalent) and make the authority
record separate from the receipt while sharing one event key. This prevents a
generic session checkpoint from becoming implicit send permission.

**Risk/trade-off:** Two files/types add structure but make authority and
observed evidence auditable; collapsing both into the existing checkpoint
would preserve less information and reintroduce accidental authorization.

### Q302 — Durable identity fields and source of truth

**Question:** Which exact fields must be treated as immutable event identity
versus observed evidence, especially for branch/worktree, Project/chat/session,
and connector binding?

**Recommendation:** Use the existing `ConnectionBinding` and
`ConversationBinding` identity conventions as authoritative locators, add
exact session identity and a canonical worktree/repository fingerprint to the
authorization, and store remote bubble/reasoning data only as evidence.

**Impact:** A mismatch blocks reuse and enters recovery; no display-name or
conversation-memory fallback is allowed.

### Q303 — Storage and atomicity

**Question:** Where and how should authorization/receipt records be persisted
so PREPARED/SENDING survive process loss without corrupting existing state?

**Recommendation:** Add a versioned user-local transport directory under the
existing C2C state root, use same-directory temp files + flush/close + atomic
replace, owner-only permissions, and an event-level lock or equivalent
serialization. Keep existing unrelated `writeSecureJson` callers unchanged.

**Impact:** A storage failure is explicit `BLOCKED`/recovery waiting; in-memory
flags cannot authorize a send.

### Q304 — Browser/IAB adapter evidence

**Question:** What is the narrowest supported interface for one composer fill,
one submit, live reasoning inspection/correction, and visible bubble/thread
reconciliation?

**Recommendation:** Define a small runtime/Skill adapter contract whose inputs
are the prepared bounded envelope and exact binding, and whose outputs are
sanitized observed setting, bubble count/hash/identity, remote response
binding, and explicit timeout/definite-failure classification. Keep DOM
details in the existing IAB Skill layer.

**Impact:** The runtime can test deterministically with fakes while the Skill
retains browser ownership; no browser screenshot or page dump becomes durable
authority.

### Q305 — Reasoning-setting capability

**Question:** If the active ChatGPT UI does not expose a controllable
Extra High / `極高` selector immediately before a send, should A0 stop or send
with a recorded limitation?

**Recommendation:** Inspection is mandatory. Correction is attempted where
supported; if neither inspection nor correction is possible, record the exact
limitation and fail closed for C2C Review/re-review rather than falsely
claiming compliance. Do not add a new Human Gate solely for ordinary setting
drift.

### Q306 — Remote reconciliation and response consumption

**Question:** What observable remote evidence is sufficient to classify a
timeout/fragment as delivered and to consume a reviewer response exactly once?

**Recommendation:** Require exact chat/session/connector binding plus event
key or payload hash and one visible user bubble; bind a substantive response
to the same workspace/checkpoint/stage and persist a consumed-once receipt.
If only generic page text is available, remain waiting/recovery-bound.

**Impact:** This favors safety over cosmetic transcript repair and prevents
duplicate reviews when a valid answer already exists.

### Q307 — Payload bound and reduction policy

**Question:** What practical byte/character bound should the runtime enforce
for control messages, and which fields survive reduction?

**Recommendation:** Preserve the existing `<1 KB` protocol intent and enforce
a deterministic smaller safety budget for generated messages. Keep only state,
task/checkpoint/message IDs, iteration, changed-file/test counts, hashes or
identifiers, and MCP review instructions; reject or reduce everything else.

**Impact:** Evidence remains MCP-fetched and one-event atomicity is preserved.

### Q308 — Session/checkpoint rollover semantics

**Question:** When a Project/chat/session rolls over, when may an authorization
be rebound to the new chat versus requiring an explicit recovery/rebinding
path?

**Recommendation:** Never silently rebind. A new chat is a new exact identity;
reuse only after durable checkpoint plus verified workspace/connector identity
and a fresh allowlisted authorization or HANDOFF path. Keep the old receipt for
reconciliation until the new binding is verified.

### Q309 — Shared Skill distribution boundary

**Question:** Is a change to the TeamAI-distributed C2C Skill contract required
in addition to `codex-with-chatgpt/skill/SKILL.md`?

**Recommendation:** Implement runtime semantics in this repository and update
the runtime-owned Skill source for browser/re-hydration instructions. If the
TeamAI distribution needs a contract/hash update, record it as an explicit
follow-up artifact and review it through the shared-skill maintainer path; do
not change canonical workflow files or add project-specific knowledge to a
global skill.

### Q310 — Active-session acceptance boundary

**Question:** What evidence is sufficient for A0's live active-session
acceptance without requiring Windows reboot or external Host Broker evidence?

**Recommendation:** Demonstrate ten-plus bounded sends, forced context
compaction/session reconstruction, automatic rehydration, one-message-per-event,
timeout reconciliation, reviewer-response de-duplication, reasoning guard, and
real Human Gate stop behavior in one active machine session. Record live
browser evidence separately from deterministic tests.

## 13. Open questions and historical approval record

The material decisions above are the Step 1 frontier. The recommended defaults
are safe to carry into Step 2/3. The following historical approval record
resolves that frontier without changing the questions or recommendations above:

1. Approve the A0 scope and the explicit preservation of P0-2, Host Broker,
   and Full Auto M1.
2. Approve the two-record authority/evidence model and the identity fields in
   Sections 5–6 (Q301–Q303).
3. Approve the IAB adapter and reasoning guard boundary (Q304–Q306), including
   fail-closed behavior when live inspection/correction is unavailable.
4. Approve the `<1 KB` bounded reduction/no-fragment rule and exact response
   consumption semantics (Q307–Q308).
5. Approve the runtime-owned Skill/distribution boundary and the active-session
   acceptance boundary (Q309–Q310).

Any redline that changes scope, identity authority, security boundary, or
acceptance evidence will be recorded against the relevant Q-ID and, if needed,
will return the workstream to Requirements Discovery rather than being guessed
by the implementation stage.

### 13.1 Recorded requirements approval — Q301–Q310

Approval source: explicit user approval in the current task instruction,
recorded at `2026-09-30T04:46:50Z`. Each decision accepts the recommendation
already recorded under the corresponding Q-ID; the full questions and
recommendations above remain the historical decision record.

- **Q301 — APPROVED:** Keep `C2cDeliveryAuthorization` and
  `C2cDeliveryReceipt` as separate durable authority/evidence concepts and
  extend the existing delivery abstraction rather than creating an unrelated
  parallel mechanism.
- **Q302 — APPROVED:** Bind exact durable identity using existing
  connection/conversation conventions plus exact session and
  repository/worktree identity; display names and conversation memory are not
  authority.
- **Q303 — APPROVED:** Use versioned user-local durable transport state with
  atomic persistence, ownership protection, and event-level serialization;
  in-memory-only state cannot authorize a send.
- **Q304 — APPROVED:** Use a narrow runtime/Skill IAB adapter for one complete
  composer fill, one submit, reasoning inspection/correction, visible remote
  evidence, and timeout-versus-definite-failure classification; DOM details
  remain in the browser/Skill layer.
- **Q305 — APPROVED:** Require live reasoning inspection for C2C Review/
  re-review, attempt correction to Extra High / `極高` where supported, and
  fail safely with the actual capability limitation when compliance cannot be
  established; ordinary drift does not create a new Human Gate.
- **Q306 — APPROVED:** Reconcile remote delivery and reviewer responses using
  bound chat/session/MCP-app/workspace/checkpoint/stage and event-key/payload
  evidence; consume a valid substantive response once and reconcile ambiguous
  delivery before retry.
- **Q307 — APPROVED:** Preserve the existing `<1 KB` bounded-message intent
  and deterministic reduction policy; keep evidence MCP-fetched and reduce
  oversized messages rather than fragmenting them.
- **Q308 — APPROVED:** Do not silently rebind authorization across a new
  Project/chat/session identity; require the supported verified
  recovery/HANDOFF path and fresh matching durable authority.
- **Q309 — APPROVED:** Implement runtime semantics in `codex-with-chatgpt`
  and the runtime-owned Codex C2C Skill where required; route any
  TeamAI-distributed Skill change through shared-skill maintenance and do not
  change canonical workflow semantics as part of A0.
- **Q310 — APPROVED:** Use the recorded deterministic and live active-session
  evidence without Windows reboot or Host Capability Broker completion,
  including repeated sends, forced CODEX context compaction/session
  reconstruction, authority rehydration, atomic delivery, timeout
  reconciliation, response de-duplication, reasoning guard, and genuine Human
  Gate preservation.

The additionally directed requirements for `WORKSPACE_READY`, current MCP-app
compatibility, terminology normalization, readiness separation, Project/chat
isolation, the optional/shared Reviewer Skill, shared Skill sourcing,
Skill-unavailable fallback, and the Codex-compaction versus Reviewer Skill
distinction are also **APPROVED**. They introduce no new Q-ID.

## 14. Step 1 disposition

- Requirements artifact: this file
- Domain glossary: repository-root `CONTEXT.md`
- Workflow step: `1`
- Requirements disposition: `APPROVED` for Q301–Q310
- Workflow state: Step 1 requirements were approved; the canonical Step 2
  Issue Finalization conversion is complete.
- Resulting Issue: [#6](https://github.com/svl33333/codex-with-chatgpt/issues/6)
  was created as a pure semantic conversion of this approved artifact and its
  persisted body was read back with A0-AC-019–A0-AC-023 and the Reviewer Skill
  regression coverage present.
- Canonical next action: start Step 3 planning; no second approval gate was
  introduced for this pure conversion.
- No source implementation was performed; no branch was published.
- Runner preflight is complete: `LOCAL_RUNTIME_READY`,
  `MCP_BINDING_READY`, `REVIEW_SESSION_READY`, and `WORKSPACE_READY` are all
  observed for workspace `f5dc2ee0d7ba` at the exact A0 Project/chat binding.
- Q301–Q310 were the only approval frontier and are now approved. The directed
  Reviewer Skill requirements add no new Q-ID and do not authorize source
  implementation.
- The actual app-configured Codex model is `GPT-6`; the desired
  `GPT-5.6 Luna Max / Fast mode` is recorded as policy evidence only. The
  required ChatGPT C2C Review setting remains Extra High / `極高` and is an
  A0 pre-send guard, not a new Human Gate.

## 15. Runner-local preflight regression rule

Every new workstream reaches `WORKSPACE_READY` before canonical development
activity depends on C2C review transport. `WORKSPACE_READY` is automatic runner
preflight, not a canonical Human Gate. One broken workspace binding must not
block unrelated workstreams.

This rule is runner-local infrastructure policy. It does not advance A0's
canonical Step 1, change the Requirements Human Gate, or authorize Issue
creation.

## 16. Current ChatGPT Plugins/MCP app compatibility and workspace bootstrap resilience

This directed amendment records the current ChatGPT surface and the bootstrap
contracts required for A0. It does not advance Step 1, authorize Issue
publication, authorize implementation, or change P0-2, Host Broker, or Full
Auto M1. The exact A0 MCP app is live and its binding has been independently
verified through `workspace_info` from the exact final review chat. The
dedicated Project/chat/session binding is complete for this A0 preflight:
`LOCAL_RUNTIME_READY`, `MCP_BINDING_READY`, `REVIEW_SESSION_READY`, and
`WORKSPACE_READY` are all observed. The earlier intermediate preflight state
that recorded the Project/chat/session phases as pending remains historical
evidence; it is superseded by the final verification below, not rewritten as
if it had never occurred.

### 16.1 UI vocabulary and durable identity

- `Connector`, `Plugin`, and `MCP app` are UI terminology aliases, not
  different authority models. The implementation must bind durable state to
  the actual workspace, canonical repository/branch or worktree,
  installation, endpoint/fingerprint, MCP app binding, Project, chat, and
  session identities.
- The persisted `connectorName` field remains backward-compatible, but its
  documentation must identify it as the registered ChatGPT MCP app/plugin
  identity. A display label alone is never sufficient for reuse.
- UI labels, menu names, or a settings-section name must not be treated as the
  durable identity or as proof that a binding is healthy.

### 16.2 Capability-based app discovery and UI drift

- The supported first-class creation path is the current UI flow
  `Plugins → Add/+ → Create MCP app` (Japanese equivalents are valid). A
  legacy Connector/deep-link route is only a bounded fallback after it has
  been verified in the current surface; a stale deep-link that lacks the form
  is not evidence of C2C failure.
- Discovery and automation must use semantic capabilities and stable identity
  (for example, create-app, OAuth, authorize, and Project actions), support
  Japanese and English labels, and avoid fixed coordinates, fixed element
  order, one obsolete URL, or one obsolete term.
- If an IAB route fails while the exact binding is healthy, inspect the current
  surface and recover within a bounded threshold. Do not delete a healthy app,
  churn the endpoint, or mint a second binding merely because a deep-link or
  browser route drifted. Persist the phase so a later run can resume; use the
  existing manual boundary after the configured threshold.

### 16.3 Readiness phase separation

The runner and runtime must distinguish these conceptual phases:

| Phase | Meaning | A0 status at amendment |
| --- | --- | --- |
| `LOCAL_RUNTIME_READY` | Pinned local runtime, exact workspace identity, and local doctor checks pass. | Observed |
| `MCP_BINDING_READY` | Exact MCP app exists, OAuth/authorization and pairing succeed, durable identity matches, and `workspace_info` returns the intended workspace. | Observed |
| `REVIEW_SESSION_READY` | Exact dedicated Project/chat/session exists with the requested memory/isolation and the app is usable from that chat. | Observed: exact Project-only A0 session and final review-chat verification |
| `WORKSPACE_READY` | All configured lower-level phases are satisfied for canonical C2C-dependent work. | Observed: final verification matched workspace ID, name, branch, and commit |

Project/session work must not be reported as an unhealthy MCP binding while it
is pending in an intermediate run. For the current A0, all four phases above
are observed after the final Project/chat/session verification.

### 16.4 Project-mode binding

- Project mode uses exactly one dedicated A0 Project named for this
  workstream, with Project-only memory/isolation. Do not reuse another
  workstream's Project.
- Persist and verify the exact Project ID/URL, then create/use a chat inside
  that Project and persist the exact chat/session identity. Before marking
  `REVIEW_SESSION_READY` or `WORKSPACE_READY`, call `workspace_info` from that
  final review chat and verify the workspace ID, canonical repository, branch,
  and expected commit/worktree identity.
- A successful app-level `workspace_info` call proves MCP binding readiness;
  it does not by itself prove Project/chat/session readiness.

### 16.5 Future automated bootstrap and upstream compatibility

- Future Full Auto bootstrap is conceptually
  `worktree → local setup → app create/reuse → OAuth/pair → Project/chat →
  workspace_info → WORKSPACE_READY → canonical development`. No human relay or
  acknowledgement is required except a genuine authentication, consent,
  ownership, unexpected-scope, or other security boundary.
- Before implementation, inspect the upstream Skill `main` for current
  Plugins/MCP-app terminology and UI fixes. Reuse compatible fixes while
  preserving local `svl` changes, test the current creation path, and do not
  silently replace the pinned local Skill or runtime with upstream content.

### 16.6 Additional acceptance criteria

#### A0-AC-014 — Current MCP app creation path

Given the current ChatGPT Plugins surface, when bootstrap creates or reuses
the A0 app, then `Plugins → Add/+ → Create MCP app` is supported as a
first-class path and no legacy deep-link is required.

#### A0-AC-015 — Terminology and deep-link drift

Given any supported Japanese/English alias or a stale legacy route, when
discovery runs, then semantic identity/capability discovery selects the
current surface, preserves a healthy binding, and records a bounded recovery
or manual boundary without endpoint churn or duplicate app creation.

#### A0-AC-016 — Phase separation

Given an authorized, paired app whose `workspace_info` matches A0, when its
Project/chat/session is absent, then the runner records
`MCP_BINDING_READY` with `REVIEW_SESSION_READY` pending and does not report a
generic MCP failure or claim `WORKSPACE_READY`; this is a hypothetical
intermediate-state behavior, not the current A0 result.

#### A0-AC-017 — Final review-session binding

Given the exact dedicated Project and in-Project chat, when final bootstrap
calls `workspace_info` from that chat, then exact Project/chat/session and
workspace identities are persisted and `WORKSPACE_READY` is marked only after
all configured lower-level phases match.

#### A0-AC-018 — Future automated bootstrap

Given a new authorized worktree and no existing A0 binding, when Full Auto is
eventually enabled, then setup follows the ordered bootstrap sequence above,
reuses an exact healthy app where possible, and stops only at genuine
authentication/security or canonical Human Gates rather than asking for a
relay acknowledgement.

### 16.7 Deterministic and live coverage

Implementation tests must cover the current Plugins/Add/Create MCP app path,
missing legacy deep-link, semantic discovery, Japanese and English labels,
healthy-binding reuse, stale-route recovery without endpoint churn, simulated
absent/pending Project phase, exact final-chat `workspace_info` verification, cross-workspace
mutation prevention, duplicate prevention after timeout, and compatibility
with the legacy `connectorName` field. These are deterministic/mock adapter
tests only where browser behavior is not under test; the live A0 acceptance
case must use the current ChatGPT UI and must not claim success from a DOM
fixture.

Q301–Q310 were the complete open-question set and are resolved by the approval
record in Section 13.1. The directed requirements in this amendment are not
re-presented as new open questions, and no new QIDs are added unless a
genuinely new design decision appears during review.

### 16.8 Final A0 readiness evidence

The final review chat inside the dedicated A0 Project used the exact A0 MCP
app and verified the following identity through `workspace_info`:

- `workspace_id`: `f5dc2ee0d7ba`
- `workspace`: `codex-with-chatgpt-a0-reliable-c2c-transport-core`
- `branch`: `a0-reliable-c2c-transport-core`
- `commit`: `13d13f0a05bfaa102394de7145607241d9da1c48`

The resulting runner readiness is `LOCAL_RUNTIME_READY: observed`,
`MCP_BINDING_READY: observed`, `REVIEW_SESSION_READY: observed`, and
`WORKSPACE_READY: observed`. This result does not advance the canonical Step
1 Human Gate or authorize Issue publication/implementation.

## 17. Optional/shared ChatGPT-side C2C Reviewer Skill

The ChatGPT-side C2C Reviewer Skill is an optional/shared reviewer-procedure
layer. It is not the transport-authority layer and it is not the remediation
for the proven Codex context-compaction defect. Skill presence must never grant
transport authorization, workspace authorization, permission to reuse a stale
binding, or permission to mutate canonical workflow state.

### 17.1 Responsibility split

The A0 architecture keeps the following ownership boundaries:

| Layer | Responsibility | Explicit boundary |
| --- | --- | --- |
| Codex-side durable transport state | `C2cDeliveryAuthorization`, `C2cDeliveryReceipt`, checkpoint/session state, identity binding, idempotency/reconciliation, and atomic delivery. | The durable authority for outbound transport remains in Codex state; chat prose and Skill presence cannot replace it. |
| Codex C2C Skill/runtime | Outbound transport procedure, IAB interaction, post-compaction rehydration, and the send-time model/reasoning guard. | It owns delivery and rehydration behavior, including the Codex-side compaction recovery requirement. |
| ChatGPT-side shared C2C Reviewer Skill | Reviewer procedure, MCP evidence retrieval order, review/output contract, and structured verdict behavior. | It reviews evidence only; it cannot authorize transport, bind a workspace, or mutate workflow state. |
| Workspace MCP app | Authenticated, read-only workspace data plane. | It supplies evidence and exact identity; it does not authorize a send or a workflow transition. |
| ChatGPT Project/chat | Per-workstream conversation and memory isolation. | It scopes reviewer context; it is not durable transport authority. |

### 17.2 CODEX context-compaction clarification

The live regressions observed during Host Capability Broker development occurred
after CODEX context compaction and reconstruction:

- routine C2C delivery unexpectedly asked the user to approve or send again;
- one logical C2C review/re-review event was split into multiple ChatGPT user
  messages.

The primary A0 compaction requirement is therefore Codex-side. After Codex
context compaction, session reconstruction, or summarized-context restoration,
the next outbound C2C event must first reload and verify, in order:

1. the pinned canonical workflow;
2. the current Codex C2C Skill/runtime contract;
3. recorded workstream state;
4. the current checkpoint;
5. exact workspace and repository identity;
6. exact Project/chat/MCP-app binding;
7. `C2cDeliveryAuthorization`;
8. `C2cDeliveryReceipt`; and
9. pending or ambiguous delivery state.

Only after these checks match may the next outbound C2C event occur. The
shared ChatGPT Reviewer Skill must not be described as the fix for this
Codex-side defect. ChatGPT-side conversation compaction or review-chat
recreation may be tested separately as reviewer resilience, but it is a
distinct failure class.

### 17.3 Shared Reviewer Skill procedure contract

When ChatGPT Skills are available, define one reusable shared C2C Reviewer
Skill that can be used across workstreams. Its procedure must include at least:

- recognition of bounded `[C2C]` planning, review, and re-review envelopes;
- exact workspace, repository, Project/chat, connector, checkpoint, task, and
  review-stage identity verification;
- rejection of stale or mismatched task/checkpoint/review-stage identity even
  when the Skill itself is available;
- MCP-first evidence retrieval in this order: validate the bounded envelope,
  verify exact workspace identity with `workspace_info`, read only the
  task-relevant artifact/code/diff/tests/execution records through MCP, then
  bind the evidence to the checkpoint and review stage;
- no requirement for Codex or a user to paste source, diffs, logs, or file
  bodies into ChatGPT;
- a canonical structured response contract carrying the task/checkpoint/stage
  binding and the applicable verdict (`PASS`, `FIX_REQUIRED`,
  `HUMAN_DECISION_REQUIRED`, or `REQUIRED_CAPABILITY_UNAVAILABLE` as defined
  by the pinned contract);
- `FIX_REQUIRED` behavior that keeps the workstream in the owning stage and
  does not invent a Human Gate;
- explicit handling of missing or incomplete evidence: do not guess, state
  what is missing, and classify the result according to the canonical review
  contract rather than silently passing or creating a new approval frontier;
- separation of transport defects (delivery, duplication, identity, or
  reconciliation failures) from review-correctness findings;
- binding every response to the task, checkpoint, iteration, workspace, and
  review stage; and
- no inference of transport authority from chat history, prior prose,
  acknowledgement text, or the mere presence of the Skill.

The Skill must not embed or duplicate a specific canonical workflow version.
When workflow behavior matters, it resolves behavior from the current pinned
canonical workflow, the TeamAI Skill, and the recorded workstream state.

### 17.4 Skill capability fallback

- If the expected Reviewer Skill is available, use it and record observable
  Skill identity/version evidence where the product exposes it.
- If it is unavailable or cannot be verified, use a bounded explicit
  reviewer-instruction fallback that preserves the same MCP-first retrieval,
  identity checks, evidence order, and structured output contract.
- Skill absence alone must not invent a Human Gate, and the fallback must not
  falsely claim that the Skill was activated.
- A0 transport must not depend exclusively on ChatGPT Skill availability.

### 17.5 One shared source, not per-workspace copies

The Reviewer Skill has one canonical shared source of truth used by multiple
workstreams. Do not create hand-maintained reviewer Skill copies for each
workspace. Workstream isolation remains provided by the exact MCP
app/workspace binding, Project/chat/session identity, and durable Codex-side
transport identity. If future packaging requires generated copies, generate
them from the canonical shared source and retain that source as authoritative.

### 17.6 Future Plugin/MCP packaging direction

A future Plugin may package Skills and MCP-backed functionality, but unified
per-workspace Plugin packaging is not an A0 prerequisite. A0 proves the
following independently first:

`shared C2C Reviewer Skill` + `exact per-workspace MCP app` +
`exact per-workstream Project/chat` + `durable Codex-side transport authority`.

This Section 17 is a Step 1 requirements definition only. No shared Skill file,
generated copy, Plugin package, or source implementation is created by this
amendment.

## 18. Proposed material amendment — GitHub authentication interruption resilience

This was a material requirement change requested in the resumed A0 task. It
was recorded as a new Step 1 proposal and has now been **explicitly approved
at the Requirements Human Gate**. It does not rewrite or invalidate the
historical Q301–Q310 decisions. The existing Step 3 plan and
`c2c_b7e2 / PASS` review remain historical evidence; the live Issue has been
reconciled and the canonical amended plan/review sequence is now required.

### 18.1 New stable design Q-ID

#### Q311 — GitHub authentication interruption resilience

**Question:** What A0 behavior is required when an already-authorized GitHub
operation is interrupted by expired authentication, a credential-context
mismatch, compaction/session reconstruction, or an ambiguous remote result?

**Recommendation:** Add the acceptance requirements and ownership boundary in
Sections 18.2–18.5. A0 owns interruption detection, bounded durable recovery
state, dynamic resolution of the TeamAI `github-cli-auth` capability,
same-attempt correlation, remote reconciliation, exactly-once continuation,
and deterministic/live coverage. TeamAI remains the canonical owner of
authentication classification, device flow, browser/mail interaction, and
security boundaries. No TeamAI Skill body is copied into A0.

**Status:** APPROVED by explicit user instruction at the resumed Requirements
Human Gate on 2026-10-01T07:01:37Z.

### 18.2 Ownership and security boundary

TeamAI remains the canonical owner of GitHub CLI authentication-state
classification, device-flow procedure, Browser/Computer Use interaction with
GitHub authentication pages, ordinary connected-mail verification,
credential-context classification, and authentication security boundaries.

A0 owns only the workflow dependency around that capability: detecting an
interrupted authorized operation, preserving bounded recoverable state,
re-resolving the current TeamAI capability, correlating the authentication
attempt with the original logical operation, reconciling whether the remote
operation already happened, continuing exactly once after credential health is
verified, preventing duplicate Issue/push/PR/review/publication actions, and
covering those behaviors in tests. The A0 repository must not copy the
`github-cli-auth` Skill body or reimplement its authentication procedure.

Successful authentication never authorizes an unrelated GitHub write; the
original A0 workflow authorization remains authoritative. CAPTCHA, unsupported
2FA, password or password recovery, account recovery, wrong or ambiguous
account, unexpected organization/SSO approval, unexpected OAuth scope or
privilege expansion, and ownership/security-sensitive account changes remain
human/security boundaries.

### 18.3 New acceptance requirements

#### A0-AC-024 — GitHub authentication recovery

Given an already-authorized A0 GitHub operation whose GitHub CLI
authentication is invalid or expired, when authentication recovery is
required, then A0 re-resolves the current TeamAI `github-cli-auth` capability
and uses the supported recovery path.

Where Browser/Computer Use and connected mail capability are available,
normal device flow, ordinary GitHub CLI authorization, `Continue as
<expected account>`, and unambiguous ordinary email verification should
complete without an acknowledgement-only human relay.

Successful authentication does not itself authorize an unrelated GitHub
write; the original task/workflow authorization remains authoritative.

#### A0-AC-025 — Credential-context mismatch

Given that a sandboxed process cannot read the valid OS GitHub credential
context and reports symptoms such as `hosts.yml: Access is denied`, inability
to read the OS keyring, or a stale/invalid credential visible only inside the
restricted context, when a supported credential-visible context can verify the
expected GitHub account successfully, then A0 classifies the condition as a
credential-context failure rather than an authentication failure.

A0 must not repeatedly start new device flows solely because a restricted
sandbox cannot observe credentials that are valid in the credential-visible
context. Credential health is verified through the narrowest supported
context.

#### A0-AC-026 — Same-attempt and exactly-once continuation

Given an authentication interruption during an already-authorized logical A0
GitHub operation, when recovery begins, then A0 retains and correlates the
existing authentication attempt and original logical operation where still
valid. When authentication succeeds, the original logical operation resumes
exactly once.

Codex compaction, session reconstruction, Browser/Computer Use reconnection,
credential-context switching, timeout, or process observation loss must not
cause duplicate Issue creation, duplicate push, duplicate PR creation/update,
duplicate review/publication action, or blind repetition of an authentication
attempt that remains active. If the result of the original GitHub write is
ambiguous, A0 reconciles remote state before retrying.

#### A0-AC-027 — Genuine authentication security boundaries

Given CAPTCHA, unsupported 2FA, password entry or password recovery, account
recovery, an ambiguous or wrong account, unexpected organization/SSO approval,
unexpected OAuth scope or privilege expansion, or an ownership/security-
sensitive account change, the existing human/security boundary remains in
force.

Ordinary verified device-flow interaction, `Continue as <expected account>`,
and unambiguous ordinary email verification are not new Human Gates when the
supported Browser/Computer Use and mail capabilities can safely perform them.

### 18.4 Durable recovery and reconstruction contract

Authentication interruption is an A0-local transport/recovery substate; it is
not a new canonical workflow stage. Persist only bounded non-secret evidence:
logical operation/event identity; repository/workstream identity;
checkpoint/stage; expected GitHub account/host; safely observable
authentication-attempt correlation; process/session correlation where
supported; timestamps and bounded attempt counts; recovery and
credential-context classification; remote-operation reconciliation evidence;
and the next safe action.

Never persist device codes, email verification codes, OAuth tokens, cookies,
bearer headers, keyring secrets, or raw authentication email content.

After CODEX compaction or session reconstruction, before starting another
auth flow, retrying a GitHub operation, asking for confirmation, or declaring
failure, reload and reconcile the pinned canonical workflow, A0 checkpoint,
original logical operation, current TeamAI capability, authentication
substate, credential-context evidence, and applicable remote GitHub evidence.
Conversation summaries are not durable authority.

### 18.5 Required regression coverage

The implementation must keep deterministic adapter coverage distinct from live
Browser/Computer Use acceptance and cover at least:

1. healthy credential requires no recovery;
2. actually expired credential selects TeamAI recovery;
3. supported device flow succeeds through Browser/Computer Use;
4. verified `Continue as <expected account>` is automatic;
5. unambiguous ordinary connected-mail verification succeeds automatically;
6. credential-context mismatch is distinguished from invalid authentication;
7. valid keyring credential plus sandbox `hosts.yml: Access is denied` does
   not create an authentication loop;
8. compaction/session reconstruction rehydrates the same auth attempt;
9. successful recovery resumes the original logical operation exactly once;
10. ambiguous writes reconcile remotely before retry;
11. duplicate Issue creation is prevented;
12. duplicate push/PR operations are prevented;
13. stale/duplicate auth attempts are not started while one remains valid;
14. missing TeamAI capability fails safely without claiming recovery;
15. TeamAI Skill changes are dynamically re-resolved rather than copied;
16. codes and credentials never enter durable A0 state; and
17. CAPTCHA/unsupported 2FA/unexpected scope remains human-only.

### 18.6 Canonical disposition

Because this amendment added requirements after the Step 3 C2C PASS and before
the Step 4 plan gate, the canonical workflow returned to **Step 1 —
Requirements Discovery**. The Requirements Human Gate has now been explicitly
approved. Step 2 Issue Finalization has reconciled the same Issue #6 as the
requirements authority; Step 3 must now update and independently re-review the
implementation plan before a fresh Step 4 plan-approval gate. No source
implementation is authorized before that new gate.

### 18.7 Recorded requirements approval — Q311

Approval source: explicit user instruction in the resumed A0 task, recorded at
`2026-10-01T07:01:37Z`. The approval accepts the recommendation in Q311 and
the complete A0-AC-024 through A0-AC-027 contract, preserves Q301–Q310 and
their prior approval history unchanged, and authorizes the canonical Step 2
Issue reconciliation followed by amended Step 3 planning and C2C review.
