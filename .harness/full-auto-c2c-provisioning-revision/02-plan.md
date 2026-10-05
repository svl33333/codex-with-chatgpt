# Implementation Plan Draft — Full Auto C2C Provisioning Compatibility Revision

## Plan scope and authority

- Repository: `svl33333/codex-with-chatgpt`
- Workstream: `full-auto-c2c-provisioning-revision`
- Branch: `requirements/full-auto-c2c-provisioning-revision`
- Requirements Issue: https://github.com/svl33333/codex-with-chatgpt/issues/13
- Baseline: `c8e5a2b2ed7b56330983ecf2f5f629dea3f337db`
- Canonical workflow: `codex-c2c-v2` 2.4.0 at `0069229049099c076a74ebb0c1797328ea8f8d3a`
- Historical candidate `4843366ff9dc969d778aa54eb3e4e0d9fe8b925a` remains reference evidence only.

This is a plan draft only. It does not implement source changes, mutate ChatGPT
connectors or Projects, publish a branch, or alter the historical candidate.
The approved GitHub Issue is the requirements source of truth.

The exact read-only C2C connector can read the workspace, files, git state, and
tests, but it does not expose a GitHub-Issue fetch operation. The Issue URL and
the approved local requirements artifact are recorded above; Issue-body parity
therefore remains an evidence prerequisite for the later implementation/review
gate, not an assumption made by this draft. No other connector or app is used
to fill that gap.

## Current implementation and affected modules

The current fork baseline already provides the secure compatibility primitives:

- `src/pairing/manager.ts` generates an eight-character formatted code, stores
  only a hash, enforces a five-minute default TTL, bounded attempts/IP limits,
  and destroys a session after one successful verification.
- `src/auth/oauth.ts` implements discovery, dynamic registration, PKCE S256,
  the pairing authorization form, one-use authorization codes, token binding,
  refresh rotation, and resource/audience checks. The authorization form is
  currently the published automatic compatibility surface.
- `src/bridge/server.ts` exposes loopback/admin lifecycle operations and the
  read-only MCP endpoint. Pairing is created through the guarded admin route.
- `src/connection/identity.ts` and `src/connection/reconciler.ts` provide
  durable installation/workspace/repository/endpoint identity and checkpointed
  exact connector reconciliation with `workspace_info` verification.
- `src/config/endpoint.ts` already separates durable workstream identity from a
  deterministic, bounded Project display label and retains connector naming.
  Its existing normalization algorithm is the Q408 decision for this plan:
  trim the label; preserve labels already within 50 Unicode code points; for
  an overlong label append `-` plus the first eight lowercase hex characters of
  SHA-256(`${durableWorkstreamIdentity}\0${workspaceId}`), truncating the
  original with `Array.from` to the remaining code-point budget and removing
  trailing spaces/hyphens before joining. The durable identity remains separate
  from this presentation label.
- `src/provisioning/chatgpt-surface.ts`, `src/provisioning/state.ts`,
  `src/session/state.ts`, and `src/conversation/app-selection.ts` provide the
  semantic surface, machine state, Project/chat mode, and current-message app
  selection seams needed by the product contract.
- `skill/SKILL.md` describes automatic in-app-browser setup, connector reuse,
  pairing, Project mode, semantic controls, and the canonical two-failure
  guided-manual boundary.
- Existing tests cover OAuth/PKCE, pairing lifecycle, surface routing,
  connector identity, Project label behavior, session state, and skill
  contracts. The preserved candidate's `handoff.ts` and Project modules are
  design evidence, not code to cherry-pick wholesale.
- The current `PairingManager` session is workspace-bound, while the OAuth
  pending request is checked separately. The revised design must add an
  explicit request-bound contract before implementation; preserving the two
  existing checks independently is not sufficient.
- The package contains semantic surface/state seams, but no production IAB
  browser driver. The Skill/built-in-browser adapter is the production control
  plane; TypeScript owns pure reconciliation, checkpoint, and proof logic.

## Concrete architecture and changes

### 1. Pairing strategy with compatibility-first safety

Introduce a small strategy/orchestration seam around the existing
`PairingManager` and OAuth authorization request rather than changing the
baseline code path in place.

- `setupMode: auto` first attempts the stronger runtime-only handoff only when
  the machine has a verified capability and an exact binding for workspace,
  connector, HTTPS origin, OAuth client, redirect URI, request, and scopes.
- If that capability is absent, incompatible, or fails within the bounded retry
  contract, automatically use the published compatibility flow equivalent to
  `c2c pair --json` and immediate submission to the verified OAuth pairing form.
- Keep pairing values short-lived, one-use, origin/request-bound, and in-memory
  or bounded tool custody only. Never put them in state files, logs, fixtures,
  screenshots, Project memory, ordinary chat, or review artifacts.
- Define a `PairingRequestBinding` carried by every pending session containing
  the workspace ID, exact connector identity/installation and endpoint origin,
  OAuth request ID, client ID, redirect URI, resource/audience, PKCE challenge,
  and normalized granted scopes. Connector identity and endpoint must be
  machine-observed and verified before a code is minted. The authorization POST
  must atomically compare the submitted request and code against that complete
  binding; a request/client/origin/redirect/scope mismatch must not consume an
  unrelated active session. Only the matching session is destroyed after a
  successful one-use verification.
- Preserve the existing OAuth/PKCE and `PairingManager` security checks. A
  strategy failure must not broaden scopes, change connector ownership, or
  silently switch auto mode to routine manual setup.
- The canonical Skill's guided-manual transition remains only for its genuine
  named boundary (for example, two explicit failures of the same setup step
  after repair when no safe automatic path is available). It is not the normal
  fallback for a missing stronger handoff.

Potential modules: `src/pairing/strategy.ts` (new), focused additions to
`src/pairing/manager.ts`, `src/auth/oauth.ts`, `src/bridge/server.ts`, and the
CLI/admin seam used by `skill/SKILL.md`.

### 2. Exact connector binding and idempotent reconciliation

Use `ConnectionBinding` as the only durable identity input. Extend the existing
reconciler seam only where necessary to persist a checkpoint for the pairing
strategy and surface verification.

- Compare repository, workspace root, branch/HEAD evidence, installation,
  endpoint fingerprint, connector name, account proof, and read-only proof.
- Keep durable `ConnectionBinding` identity distinct from a later reviewer
  proof: a connector binding identifies the intended resource, while a review
  proof records the current checked-out tree that was actually observed.
- Reuse one exact owned connector with zero mutations when the binding and
  endpoint are unchanged.
- On a changed endpoint, verify ownership, delete only the owned connector,
  prove absence, recreate once, and verify `workspace_info` before retrying.
- Treat ambiguous names, foreign connectors, missing identity evidence,
  `WORKSPACE_MISMATCH`, and unknown mutation outcomes as fail-closed states.
- Same-name foreign connectors, multiple candidates, or any ownership/identity
  ambiguity map to the named `HUMAN_BOUNDARY` outcome (not recoverable retry).
  Transient listing/read failures remain bounded `RECOVERABLE_FAILURE` cases.
- Preserve idempotency keys/checkpoints so timeouts cannot cause duplicate
  connectors or blind retries.

### 3. Automated Project reconciliation and semantic settings routing

Create a production-facing Project adapter/orchestrator using the existing
identity and semantic-surface types; the adapter must be product-surface based,
not coordinate based. Split it into (a) pure TypeScript reconciliation and
checkpoint logic, which consumes typed observations and emits semantic actions,
and (b) a Skill/built-in-browser production adapter that discovers and performs
those actions on ChatGPT's Project/connector/OAuth surfaces. The adapter
contract must carry the target Project durable ID, observed surface kind,
control ID/role, and post-action observation; coordinates, screenshots, and
display labels are never control contracts.

- Reconcile by durable Project identity (owner account, workspace binding,
  connector binding, and Project ID), never by display label alone.
- Create exactly one Project when no valid exact identity exists; repair settings
  drift in place and refuse ambiguous candidates.
- Normalize generated display names with the existing `endpoint.ts` algorithm
  recorded above: trim; preserve valid labels; otherwise use an
  identity/workspace-derived eight-hex SHA-256 suffix and Unicode-code-point
  truncation to produce at most 50 characters. This resolves Q408 without
  changing durable identity or relying on a user to shorten the label.
- Enforce Project-only memory, Chat mode, zero Library/source additions, and
  machine-verifiable post-save confirmation.
- Treat Project creation, Project collection, Project settings, Project
  Instructions, reviewer composer, connector configuration, and OAuth/pairing
  as distinct semantic destinations.
- Write instructions only after the Project settings/Instructions control is
  observed for the intended Project. A visible reviewer composer is never a
  fallback. A navigation failure is a bounded recoverable failure.
- Existing polluted/partial chats are not reinterpreted; reconcile the same
  Project and create one fresh reviewer chat.
- In `setupMode: auto`, Project creation and settings reconciliation are
  automatic; a missing Project is created exactly once and drift is repaired
  in place. A visible composer, navigation failure, or ambiguous Project is
  never a fallback destination for settings content. Only the named genuine
  Human Boundaries can stop that automation.

Potential modules: `src/provisioning/project.ts`,
`src/provisioning/project-runtime.ts`, `src/config/endpoint.ts`,
`src/session/state.ts`, and the browser/surface adapter boundary described by
`skill/SKILL.md`.

### 4. Fresh reviewer binding and current-message verification

After connector and Project readiness:

1. Resolve the exact Project by durable identity.
2. Create/reconcile one fresh reviewer chat in that Project in Chat mode.
3. On the first MCP-dependent message, record the exact app selection and
   message idempotency key before sending.
4. Construct one structured `ReviewerProof` keyed by that message. It must
   contain the exact app/connector identity and workspace ID, read-only
   capability, repository URL/name, canonical workspace root, branch, full
   current HEAD, `workspace_info` result, `git_status` result, and required
   `git_diff` result (including an explicit empty-diff result when applicable).
   A boolean such as `workspaceVerified` or a hash alone is insufficient.
5. Require every field to match the durable `ConnectionBinding` and expected
   workstream. Wrong app, repository, root, branch, HEAD, missing diff, or
   non-read-only capability yields `WORKSPACE_MISMATCH`/fail-closed.
6. Persist reviewer/session readiness only after the message-keyed proof is
   complete; preserve the previous valid session on failure. Branch and HEAD
   are freshness evidence in this proof, not durable connector identity.

### 5. Runtime state, recovery, and observability

- Extend machine-local provisioning state with explicit pairing strategy,
  compatibility fallback, Project settings confirmation, and reviewer proof
  phases without storing secrets.
- Persist the selected pairing strategy and proof schema version, but never
  pairing material. A proof record is message-keyed and non-secret; it is not
  replaced by caller-supplied booleans or only `workspaceInfoHash`/
  `gitStatusHash` fields.
- Record bounded non-secret outcomes (`REUSED`, `CREATED`, `RECOVERED`,
  `RECOVERABLE_FAILURE`, `HUMAN_BOUNDARY`, or capability unavailable) and the
  exact next action.
- Keep retry counts and operation checkpoints bounded; never loop on expired,
  replayed, or `no_active_session` values.
- Redact pairing-shaped strings and bearer material in execution output and
  logs. No browser cookies, OAuth tokens, or private endpoints enter artifacts.
- Preserve the old candidate and diagnostics as read-only recovery evidence.

## Data flow and trust boundaries

1. Codex derives the canonical workspace/repository identity and a read-only
   connector binding from local Git and machine state.
2. The bridge creates the named/ephemeral endpoint and pairing session; only a
   hash is persisted by the existing pairing manager.
3. The verified ChatGPT OAuth surface supplies the request/client/redirect and
   is the only surface allowed to consume pairing authorization.
4. The strategy selects runtime-only handoff when fully bound, otherwise the
   baseline compatibility pairing submission; both paths terminate in the same
   OAuth/PKCE and MCP token audience checks.
5. Browser semantic adapters reconcile the exact Project and settings, then
   create a fresh reviewer chat.
6. The first MCP message proves exact read-only workspace identity before any
   review result is accepted.

The bridge remains read-only toward the workspace. Browser control is limited
to the approved same-site ChatGPT/IAB surfaces; UI labels and screenshots are
observations, not identity or control contracts.

## Compatibility, migration, and failure handling

- Existing long-chat/project session state and healthy connectors remain the
  reuse path; no connector churn is caused by a missing stronger handoff.
- Existing A0 compatibility behavior remains independent and is not repointed.
- Existing published pairing/PKCE clients continue to work unchanged.
- If the stronger handoff is disabled or fails E2E, auto mode keeps the
  compatibility path; a later implementation must be able to disable only the
  stronger path without deleting compatibility code or recreating connectors/
  Projects. Define a machine-level `pairingStrategyOverride` setting with
  `auto` (capability-gated stronger handoff, then automatic compatibility
  fallback) and `compatibility` (force the published automatic compatibility
  path). The override is local configuration/checkpoint state, does not change
  `setupMode`, and must not be silently changed to `manual`.
- If a candidate cleanup or reconstruction changes source semantics, return to
  the applicable canonical review stage; do not reuse old C2C evidence.
- A login wall, CAPTCHA, unsupported 2FA, password/recovery, wrong account,
  unexpected SSO/organization approval, ownership ambiguity, or scope
  expansion remains a narrow Human Boundary.

## Security and privacy

- Read-only scopes and exact workspace/connector binding are mandatory.
- OAuth request/client/redirect/resource and pairing values are bound and
  one-use; refresh/token material remains outside repository/state/logs.
- Request-bound verification is atomic: mismatches do not consume a session
  belonging to another OAuth request, and a successful match consumes exactly
  one session.
- Runtime-only handoff material is destroyed after use or expiry.
- Project memory remains project-only and sources remain absent.
- No unrelated connector, A0 binding, parent/root connector, Local Files
  connector, A2 workstream, or merged A/B work is modified.

## Tests and evidence

### Deterministic tests before E2E

- pairing strategy chooses the stronger path only with complete capability and
  exact binding; otherwise chooses automatic compatibility;
- compatibility path remains one-use, bounded, redacted, and OAuth/PKCE-safe;
- handoff rejects workspace/connector/origin/scope/request/client/redirect
  mismatches, replay, expiry, generic untrusted clients, and a wrong pending
  OAuth request without consuming the matching session;
- a pairing value minted for OAuth request A cannot authorize request B, and
  mismatched request/client/redirect submissions leave the intended session
  available for its matching request;
- Project reconciliation is idempotent, durable-identity based, and refuses
  ambiguity or display-name-only matches;
- `setupMode:auto` creates/reconciles a Project and its settings with zero
  routine user actions; a missing Project is not delegated to the user;
- Project Instructions cannot route to the reviewer composer and saved settings
  require machine-verifiable confirmation;
- `<=50` display labels are deterministic and collision-resistant;
- fresh reviewer binding requires a structured message-keyed proof and fails
  closed on `WORKSPACE_MISMATCH`, wrong HEAD, wrong repository/root/branch,
  missing `git_diff`, wrong app, or non-read-only capability;
- same-name foreign/multiple connector candidates map to a Human Boundary,
  while transient read failures remain recoverable;
- compatibility-only rollback forces the baseline automatic pairing path and
  leaves the stronger handoff, connector, Project, and compatibility code in
  place;
- schema/state migration preserves existing valid bindings and rejects stale
  or incomplete reviewer proofs;
- Skill/CLI contract tests preserve auto fallback, narrow Human Boundaries,
  no secret persistence, and no acknowledgement-only stops;
- existing OAuth, pairing, MCP, tunnel, workspace, session, and redaction
  tests remain green.

### Real product E2E gate

Before claiming C completion, exercise the actual production path against one
fresh workspace and dedicated read-only connector. Record only non-secret
evidence: exact binding, automatic pairing with no routine user action,
authorization success, Project-only settings, no Library/source, settings-only
Instructions, fresh reviewer chat, current-message app selection,
`workspace_info`, `git_status`, required `git_diff`, and exact repository/root/
branch/HEAD with no `WORKSPACE_MISMATCH`. Q409 (the fresh fixture/account and
Project session) is selected at the setup/E2E execution point.

## Implementation order and rollback

1. Add/confirm domain types and adapter seams for pairing strategy, the
   request-bound pairing contract, Project identity/settings, and the
   message-keyed reviewer proof.
2. Implement compatibility-first pairing orchestration around the published
   OAuth/PKCE path; keep stronger handoff optional and gated.
3. Implement idempotent Project reconciliation and semantic settings routing.
4. Wire CLI/runtime/session state and Skill contract updates.
5. Add deterministic unit/integration coverage and run typecheck/full tests.
6. Obtain real ChatGPT E2E evidence using the same production path.
7. Only after the plan and C2C review gates, implement within this scope.

Rollback is a feature/configuration selection back to the published
compatibility path, with no need to delete the exact connector or Project. The
historical candidate is not a rollback target and is not cherry-picked.

## Known limitations and open choices

- Q408 is resolved by adopting the existing `src/config/endpoint.ts`
  trim/code-point truncation plus eight-hex SHA-256 identity suffix algorithm;
  implementation must preserve that behavior and its current tests.
- Q409 remains deferred to the real setup/E2E point: choose the fresh
  workspace and live ChatGPT Project/account session.
- The live ChatGPT surface can expose genuine login, CAPTCHA, 2FA, ownership,
  or scope boundaries; those stop only at the named Human Boundary.
- The exact C2C connector cannot fetch GitHub Issue #13. Until the authorized
  workflow provides a connector-readable Issue body or verified snapshot,
  requirements-source parity remains explicitly unverified; this draft does
  not substitute another app or claim parity.

## C2C Review Summary

The bounded pre-implementation C2C review at iteration 0 returned
`FIX_REQUIRED`. All seven findings were remediated within the approved plan
scope and submitted for one bounded re-review at iteration 1. The exact
read-only connector revalidated workspace identity before review:

- workspaceId: `279caac78bfd`
- workspace: `codex-with-chatgpt-full-auto-provisioning-requirements`
- branch: `requirements/full-auto-c2c-provisioning-revision`
- HEAD: `c8e5a2b2ed7b56330983ecf2f5f629dea3f337db`
- tracked tree: clean; only the expected untracked `.harness/` directory
- unstaged `git_diff`: empty
- capability: read-only

The iteration-1 verdict is `PROCEED`. Finding dispositions are:

1. `accepted`: Q408 explicitly adopts the existing `src/config/endpoint.ts`
   Unicode-aware, collision-resistant normalization contract.
2. `accepted`: `PairingRequestBinding` now binds workspace, connector, origin,
   OAuth request, client, redirect, resource, PKCE, and scopes, with atomic
   mismatch handling and no unrelated-session consumption.
3. `accepted`: Project automation is divided between pure TypeScript
   reconciliation/checkpoint logic and the Skill/built-in-browser production
   adapter; `setupMode:auto` creates/reconciles without routine user action.
4. `accepted`: the message-keyed `ReviewerProof` requires exact app/connector,
   `workspace_info`, `git_status`, required `git_diff`, repository, root,
   branch, full HEAD, and read-only evidence.
5. `accepted`: same-name foreign or multiple connector candidates are a
   `HUMAN_BOUNDARY`; transient reads remain recoverable.
6. `accepted`: `pairingStrategyOverride=compatibility` is the concrete
   stronger-handoff rollback switch and preserves the compatibility path,
   connector, and Project.
7. `accepted`: deterministic tests cover request misuse/non-consumption,
   zero-action Project setup, settings/composer separation, structured proof,
   ownership ambiguity, compatibility rollback, and state migration.

The re-review also recorded three implementation constraints: expose the
pending OAuth request to the guarded pairing-mint path, extend the exact MCP
evidence path to provide full HEAD/root evidence, and preserve the existing
shared redaction path. These are implementation constraints, not source
changes in this Step.

The exact connector has no GitHub Issue-fetch operation and no local Issue-body
snapshot. Live Issue #13 parity therefore remains unverified; no other app or
connector was used and this plan does not claim that parity. This limitation is
preserved for the canonical workflow to resolve at its required gate.

`PLAN_READY_FOR_VISUAL_REVIEW`
