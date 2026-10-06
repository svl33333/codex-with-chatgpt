# Step 3 Plan Draft — immutable custom runtime release

## Workstream and current evidence

- Repository: `svl33333/codex-with-chatgpt`
- Issue: [#15](https://github.com/svl33333/codex-with-chatgpt/issues/15)
- Branch: `maintenance/custom-runtime-release`
- Base: current `main` at `1623df922bc5b8209e8bd797f392f9ac29e5c930`
- Approved prior runtime: `v0.1.3-svl.13` at
  `13d13f0a05bfaa102394de7145607241d9da1c48`
- Candidate derived from current live tags: `0.1.3-svl.14` /
  `v0.1.3-svl.14`; re-resolve tag availability immediately before publication.
- Pinned workflow: `codex-c2c-v2` 2.4.0,
  `0069229049099c076a74ebb0c1797328ea8f8d3a`; review contract
  `schema/c2c-review-contract.json`.
- Step 1 approval: Q701–Q708 explicitly approved without changes. Issue #15 is
  the live requirements source; this draft does not authorize implementation or
  publication.
- Issue #15 was finalized from the amended requirements through the authorized
  GitHub connector at `2026-10-06T02:26:27Z`; its live body now includes the
  approved Q708 contract and additional acceptance criteria 9–18. The local
  `01-issue-snapshot.md` was refreshed to match.

## Current implementation and affected surfaces

The current C-merged tree is authoritative for the product behavior that must
not regress. `src/provisioning/project.ts` and `project-runtime.ts` implement
durable Project identity reconciliation, project-only memory/settings checks,
semantic surface separation, deterministic display-name limits, and
fail-closed ambiguity. `src/connection/identity.ts` and `reconciler.ts` bind
workspace, canonical repository, installation, endpoint mode/fingerprint, and
connector name, and checkpoint create/delete/reuse without duplicate mutation.
`src/pairing/*` owns request-bound pairing/OAuth identity and exact scopes.
`src/provisioning/reviewer-proof.ts`, `app-selection.ts`, and their CLI path
enforce message-keyed current-HEAD, complete-diff, repository/root/branch,
connector, workspace, and read-only evidence. These modules are preservation
anchors, not candidates for replacement with the older `.13` tree.

The `.13`-only reviewed behavior is isolated in the consent policy:

- `src/connection/consent.ts` (new) will provide a pure, runtime-owned
  decision helper over the existing `ConnectionBinding` and
  `SUPPORTED_SCOPES` types.
- `tests/consent.test.ts` (new) will cover the exact positive decision and all
  fail-closed identity, surface, ownership/account, blocker, setup-mode,
  explicit-intent, duplicate/extra/write-scope cases.
- `skill/SKILL.md` will describe the structured expected ChatGPT
  unreviewed-MCP surface and the guarded automatic decision while retaining the
  current C Project, pairing compatibility, and ReviewerProof procedures.
- `skill/SKILL.md` and `docs/troubleshooting.md` will use the app-shell
  plugin/customize -> `/plugins` -> Add -> Create custom MCP server route;
  `Settings -> Plugins` remains management/recovery only, and the historical
  deep link is bounded route-drift evidence.
- `src/config/endpoint.ts` and the `src/cli/index.ts` doctor/page metadata will
  expose no misleading authoritative creation API; any retained
  `CHATGPT_CREATE_CONNECTOR_URL` is explicitly compatibility/navigation-only.
- First-time automatic setup, reconnect/recovery, guided manual setup, and
  their Skill/surface-routing/CLI metadata tests will share the same semantic
  route and observable clear-search/Add/Create checks.
- `docs/custom-stability-patches.md` and `docs/security.md` will document the
  consent trust boundary, exact scope set, provenance, and no-acknowledgement
  continuation without deleting current C security/provisioning invariants.
- `package.json`, `src/version.ts`, the bootstrap and Skill-installer default
  refs, release/provenance documentation, and a release-consistency test will
  agree on `.14`. A previous `.13` tag may be recorded as history but will not
  remain an install/default runtime ref.

## Architecture and trust boundary

The consent helper is a pure policy boundary, not a browser automation layer.
The browser/surface adapter must first supply structured evidence identifying
the exact current ChatGPT warning surface, account, ownership, expected and
observed binding, and observed OAuth scopes. Warning text alone is never an
authority signal. The helper compares all six binding dimensions exactly:
workspace, canonical repository, installation ID, endpoint mode, endpoint
fingerprint, and connector name.

The policy must have a concrete production enforcement path. Add one narrow
runtime-owned decision command under the existing `src/cli/index.ts` command
family (following the current Project reconcile/verify-settings pattern; the
final subcommand name follows the repository's established naming convention).
That command derives the expected binding from `readConnectionBinding`, derives
`setupMode` from runtime preferences, imports the allowed scopes exclusively
from `SUPPORTED_SCOPES`, and accepts only observed structured evidence plus
explicit C2C intent. It returns only `AUTO_CONFIRM` or `HUMAN_REQUIRED`.
`skill/SKILL.md` must invoke this command immediately before an automatic
confirmation and must not reconstruct or widen expected binding or scopes.

The expected scope set is imported from runtime-owned `SUPPORTED_SCOPES` and
is compared as an exact set with duplicate rejection; an adapter cannot pass a
wider expected set. Any unknown, missing, mismatched, manual, stale or
reused observation, login/CAPTCHA/unsupported-2FA, destructive/security-
sensitive, or ambiguous-account guard returns `HUMAN_REQUIRED`. Only
`setupMode: auto`, explicit C2C intent, exact `chatgpt-unreviewed-mcp` surface,
resolved and expected account/ownership identity, exact binding, a fresh
one-shot observation, and exact read-only scopes return `AUTO_CONFIRM`. The
result contains no acknowledgement field and the Skill continues when the
browser/MCP makes the decision observable.

Freshness is an explicit contract: the observation carries a per-observation
nonce and `freshness: current`; `stale` or `unknown` is fail-closed. The
runtime command does not persist, cache, or mint a reusable authorization from
the result. The adapter must re-observe and invoke the command again after any
navigation, account/workspace change, connector mutation, OAuth scope change,
or other surface transition; a previous `AUTO_CONFIRM` result is never a
reusable authorization.

Automatic consent also requires authoritative expected and observed account and
ownership identities. Missing expected identity, missing observed identity,
resolved-but-wrong account, and foreign ownership all fail closed, even when
the optional `ConnectionBinding.accountFingerprint` is absent in older records.

This policy does not authorize credentials, change OAuth scopes, select an
account, mutate a foreign connector, bypass a Human Boundary, or replace the
canonical workflow. It composes with existing pairing, Project, connector,
and ReviewerProof evidence; it does not infer identity from display labels or
chat prose.

### ChatGPT creation-surface routing

Custom-MCP creation is a semantic app-shell capability, not a hard-coded
Settings URL. The route adapter must start from the visible plugin/customize
control, reach `/plugins`, clear an inherited search/filter when present, and
observe `Add`/`追加` followed by `Create a custom MCP server`/`カスタム MCP
サーバーを作成`. It fills the expected name, description, and current MCP URL,
selects OAuth, verifies the exact read-only scopes and consent warning, and
uses `Create as plugin`/`プラグインとして作成`. It then reuses the existing
account/owner, endpoint, workspace/repository, identity, pairing,
`workspace_info`, `git_status`, ReviewerProof, and fail-closed checks.

`Settings -> Plugins` and `/settings/plugins-settings` are retained for
management/recovery inspection or deletion only. If
`CHATGPT_CREATE_CONNECTOR_URL` redirects there, the adapter records route
drift and semantically recovers through the app-shell surface; the redirect
alone never becomes `REQUIRED_CAPABILITY_UNAVAILABLE`. No hidden storage edit,
undocumented/private API, or plugin-creator workaround is permitted. The same
route contract is exercised by first-time auto setup, reconnect/recovery, and
guided manual setup. The surface inventory includes `skill/SKILL.md`,
`docs/troubleshooting.md`, `src/config/endpoint.ts`, `src/cli/index.ts`, each
setup/recovery path, Skill-contract tests, surface-routing/compatibility tests,
and applicable CLI/page metadata tests.

### Stateful challenge and account authority

The pure consent helper remains side-effect free, but the production CLI
wrapper owns a real one-shot challenge lifecycle. Add a runtime-owned
`consent prepare`/`consent decide` path (using the repository's established
CLI naming pattern) backed by a bounded non-secret challenge registry under the
existing user state directory. `prepare` derives the expected binding and
account authority, registers a short-lived challenge, and exposes only its
opaque challenge id to the browser adapter. `decide` accepts that id, explicit
C2C intent, and observed structured surface/account/ownership/binding/scope
evidence; it never accepts caller-supplied expected binding, expected account,
expected owner, or expected scopes.

Challenge registration and consumption must be concurrency-safe across CLI
processes: use an OS-level exclusive lock or equivalent atomic create/replace
operation, consume the challenge before returning `AUTO_CONFIRM`, and clean up
expired records with a bounded maximum. Unknown, expired, second-use,
changed-binding, changed-account/owner, changed-surface, or changed-scope
observations return `HUMAN_REQUIRED`. Persist only the opaque id, binding
digest, account fingerprint, timestamps, and consumed state; never raw DOM,
OAuth data, credentials, pairing values, endpoint URLs, or message bodies.

The authoritative expected account is the existing machine-verified
`ConnectionBinding.accountFingerprint`. If that legacy-optional field is
absent, `prepare` cannot authorize automatic consent and the result is
`HUMAN_REQUIRED`; it must not backfill the field from browser-supplied data.
Observed account identity must be machine-verified by the current OAuth/account
surface and equal the binding fingerprint. Ownership is the structured proof
that the observed connector is owned by that account and matches the exact
workspace/repository/installation/connector binding; a foreign or unresolved
owner fails closed. Add tests separately for missing expected identity,
missing/wrong observed identity, foreign ownership, challenge replay, expiry,
unknown ids, changed bindings, and concurrent consume attempts.

## Concrete changes and interfaces

1. Add the consent module with typed `ConnectorConsentSurface`,
   `ConnectorConsentAction`, `ConnectorConsentContext`, and
   `ConnectorConsentDecision` contracts. Keep the helper deterministic and
   side-effect free. Export a `connectorConsentBinding` projection so callers
   cannot accidentally compare unrelated mutable fields. Include explicit
   observed account and ownership identity plus a per-observation
   challenge/freshness discriminator; reject stale, unknown, or reused
   observations. Expected binding/account/scopes come only from the runtime.
2. Port the reviewed `.13` semantics rather than its divergent history. Do not
   merge or cherry-pick the `.13` branch; adapt the helper to the current C
   binding/types and preserve the current `ConnectionBinding` schema and
   reconciler behavior.
3. Amend `skill/SKILL.md` at the existing confirmation/HUMAN_WAITING boundary:
   distinguish structured exact consent from generic warning text; state the
   automatic guard contract and keep actual login, CAPTCHA, unsupported 2FA,
   destructive/security, ownership, account, unexpected-scope, and guided
   manual boundaries. Preserve automatic pairing compatibility, Project
   settings/composer separation, current-message app selection, and exact
   ReviewerProof instructions. Invoke the runtime-owned consent decision
   command immediately before any automatic confirmation; do not duplicate its
   expected binding/scope policy.
4. Extend the patch inventory and security model with the consent invariant,
   runtime-owned scope list, structured-surface requirement, and sanitized
   provenance. Keep token, pairing, endpoint, Project, connector, and reviewer
   proof privacy rules intact.
5. Bump every custom-release surface to `.14`: package metadata, source
   `VERSION`, provenance documentation, bootstrap default `Ref`, and Skill
   installer default `Ref`. Keep `scripts/update-custom-c2c.ps1` manifest-driven
   and do not alter TeamAI pins or the existing `.13` tag.
6. Add a deterministic release-consistency test that reads the scoped release
  surfaces and fails on stale `.12`, an unintended runtime-default `.13`, or
  disagreement with the planned `.14` candidate. It must also assert that
  `scripts/update-custom-c2c.ps1` remains manifest-driven and does not invent a
  conflicting bootstrap/update default. Do not encode a publication claim
  before the final live tag recheck; the test verifies candidate consistency
  only.
7. Classify the existing `CONTEXT.md` modification as an intentional,
   task-scoped architecture/glossary update for the consent guard and
   immutable-release boundary. Keep it in the reviewed candidate diff and
   verify that it contains no TeamAI pin or unrelated workstream change.
8. Add a semantic ChatGPT surface-routing adapter/contract (or the repository's
   established equivalent) that drives the app-shell `/plugins` Add -> Create
   custom MCP route, clears inherited filters, exposes bounded route-drift
   recovery, and leaves Settings as management/recovery only. Update all
   first-time, reconnect, and guided-manual instructions plus endpoint/CLI page
   metadata and add deterministic route/compatibility and metadata tests.
9. Add the stateful runtime wrapper and challenge registry described above. The
   production decision path must atomically consume a registered challenge
   before `AUTO_CONFIRM`, derive expected account authority from the existing
   machine-verified binding, and expose deterministic replay/expiry/concurrency
   tests through the actual CLI path.

## Data flow and state management

1. The setup/recovery route selector resolves the semantic ChatGPT app-shell
   plugin/customize surface, clears inherited search/filter state, observes
   Add/Create, and treats a Settings redirect from the legacy deep link as
   route drift with bounded recovery. It never uses Settings as normal
   creation, hidden storage, or an undocumented API.
2. The runtime-owned decision command resolves the current machine policy and
   explicit C2C request, derives the expected binding/scopes, observes the
   semantic ChatGPT surface, and receives exact expected/observed
   ownership/account/binding/scope evidence with a fresh one-shot observation.
3. It calls the pure consent helper. `AUTO_CONFIRM` permits the already
   authorized expected warning to continue; `HUMAN_REQUIRED` preserves the
   existing Human Boundary and no safe-looking text fallback is attempted.
4. Existing pairing, connector reconciliation, Project reconciliation, and
   ReviewerProof state continue to own their separate checkpoints. The consent
   decision is transient policy evidence only; no credentials, cookies, pairing
   values, raw DOM, or private endpoints are persisted.
5. Release metadata is source-controlled and versioned; final tag identity,
   target commit, package version, and Skill digest are recorded in later
   workflow artifacts after publication. TeamAI runtime state is not edited.

## Compatibility, migration, and error handling

- Existing callers and `ConnectionBinding` records remain compatible; the new
  helper consumes a narrow projection and does not change the binding file
  schema.
- The app-shell `/plugins` route is the normal creation capability. Settings
  Plugins remains management/recovery only; a legacy deep-link redirect to
  Settings is route drift, followed by semantic app-shell recovery rather than
  a global capability-unavailable result.
- `CHATGPT_CREATE_CONNECTOR_URL`, if retained in endpoint or CLI metadata, is
  labeled compatibility/navigation-only and is covered by route-drift tests;
  it is never used as authoritative creation proof.
- Existing C behavior remains the default. The old `.13` line is a semantic
  source only, not a migration base. No runtime install is switched by this
  plan.
- Missing or unknown structured consent evidence fails closed as
  `HUMAN_REQUIRED`, not as automatic confirmation and not as an acknowledgement
  loop. Manual setup remains explicit or a genuine security boundary.
- The runtime decision command is the only production authorization path;
  leaving the helper uncalled or reimplementing it in the Skill is not an
  acceptable implementation.
- Exact duplicate, write, extra, or missing scope entries fail closed. The
  browser adapter cannot widen the expected set.
- A foreign same-name connector, wrong Project/account/workspace, endpoint
  drift, or ownership ambiguity remains untouched and human/security bounded.
- Legacy `ConnectionBinding` records without `accountFingerprint` remain
  readable and never gain an inferred account; automatic consent is simply
  `HUMAN_REQUIRED` until a separately machine-verified binding supplies the
  expected authority.
- If `.14` becomes occupied before publication, stop and recompute the next
  suffix from live tags; never move or overwrite an existing tag.
- If C2C returns `FIX_REQUIRED`, remediate in this approved scope, rerun the
  required checks, and re-review. `REQUIRED_CAPABILITY_UNAVAILABLE` is
  `BLOCKED` with one recovery action; it is not replaced by a local reviewer.

## Security, privacy, and concurrency

- The consent decision never grants credentials, write scopes, account
  selection, ownership, or destructive action. It only classifies the exact
  expected read-only warning.
- Structured surface and account/binding evidence must be current and
  machine-observable. Warning copy, a display name, prior chat success, or a
  local-only doctor result is insufficient.
- Consent evidence is one-shot through a runtime-owned bounded challenge
  registry: the production wrapper registers a challenge, binds the observed
  evidence to it, atomically consumes it before `AUTO_CONFIRM`, and rejects
  second, expired, unknown, changed-surface, or changed-binding use. The
  registry is concurrency-safe across CLI processes, cleans up bounded stale
  records, and never persists or returns a reusable authorization token. The
  caller must re-observe after every surface transition.
- Expected account authority is the existing machine-verified
  `ConnectionBinding.accountFingerprint`; absent expected identity is
  `HUMAN_REQUIRED`, not a browser-derived backfill. Observed account and
  ownership proof must match that fingerprint and the exact binding; wrong or
  foreign identity fails closed.
- No new durable record contains OAuth tokens, refresh tokens, pairing codes,
  cookies, private endpoint URLs, raw browser state, or raw message bodies.
- The pure helper has no shared mutable state. Existing connector locks,
  pairing one-use semantics, Project identity checks, and ReviewerProof
  message keys remain the concurrency/idempotency authorities.
- Release publication will use an immutable tag and an exact pre-publication
  tag-absence check; existing history is never rewritten.

## Test and validation plan

Focused policy coverage in `tests/consent.test.ts`:

- exact expected warning and exact runtime-owned scope set -> `AUTO_CONFIRM`;
- no acknowledgement field/step;
- wrong connector, installation, workspace, repository, endpoint mode, or
  endpoint fingerprint -> `HUMAN_REQUIRED`;
- unknown/non-structured surface or warning text without surface proof;
- unresolved, missing-expected, wrong, or foreign ownership/account identity;
- login, CAPTCHA, unsupported 2FA, destructive, and ambiguous-account flags;
- production `consent prepare`/`consent decide` challenge registration,
  atomic one-shot consume, second-use/expired/unknown/changing-surface
  rejection, bounded cleanup, and concurrent consume attempts;
- missing authoritative `ConnectionBinding.accountFingerprint`, missing or
  wrong observed account, foreign/unresolved ownership, and exact binding
  mismatch;
- manual/unset setup mode and missing explicit C2C intent;
- duplicate, missing, extra, and write scope entries, including an adapter
  attempt to widen expected scopes.

Regression coverage will run the existing Project/provisioning, pairing/OAuth,
app-selection, ReviewerProof, Skill-contract, workspace identity, and MCP
scope tests unchanged except for intentional contract assertions. Add the
release-consistency test for package/source/docs/default refs. Add focused
surface-routing/compatibility coverage for app-shell `/plugins`, inherited
filter clearing, observable Add/Create, Settings management-only behavior,
deep-link route drift/recovery, and all first-time/reconnect/guided-manual
paths. Add CLI/page metadata assertions for any retained or renamed
`CHATGPT_CREATE_CONNECTOR_URL`. Required
commands after implementation are frozen install if needed, `pnpm typecheck`,
`pnpm test`, `pnpm build`, and `git diff --check`; record focused and full
results in the canonical test summary artifact. No synthetic test is claimed
as live ChatGPT product E2E.

## Regression risk, observability, and rollback

Highest risks are accidental replacement of current C Skill/provisioning text
with `.13` history, accepting generic warning text, widening scopes, or leaving
one `.12`/`.13` default. Mitigate with semantic diff inspection, exact policy
tests, the release-consistency scan, and C regression tests. Record sanitized
phase/reason/checkpoint outcomes only; retain no secret or private product
metadata.

Before publication, re-fetch current `main`/tags and verify the candidate
branch remains based on the approved baseline, current C behavior is retained,
and `v0.1.3-svl.14` is still absent. If validation or review fails, keep the
worktree local, apply only in-scope remediation, and revalidate. The previous
`v0.1.3-svl.13` immutable tag remains the rollback/reference point. Never
force-push or retag it. A later TeamAI pin-adoption workstream is the only place
that may consider changing TeamAI's immutable runtime ref.

## Implementation order

1. Recheck state, live Issue #15, branch/base, current tags, and current C
   source; do not modify excluded workstreams.
2. Add the pure consent helper and deterministic consent tests.
3. Add and test the concrete runtime/CLI consent prepare/decision path,
   including the bounded stateful challenge registry, atomic one-shot consume,
   derived expected binding/scopes, `ConnectionBinding.accountFingerprint`
   authority, and account/ownership checks.
4. Implement the app-shell custom-MCP route contract across first-time,
   reconnect/recovery, and guided manual setup; bound the legacy deep link and
   update endpoint/CLI page metadata plus routing/compatibility tests.
5. Semantically update Skill consent wording while preserving C Project,
   pairing, identity, and ReviewerProof sections.
6. Update security/provenance documentation and all `.14` release/default
   metadata; add release-consistency coverage.
7. Run typecheck, focused tests, full tests, build, and diff check; repair only
   in the approved scope.
8. Produce the implementation/test artifacts and enter the canonical
   implementation C2C review only after the relevant implementation step.
9. At the later publication gate, recompute the available tag suffix, publish
   one immutable tag, verify the remote ref, and record commit/version/Skill
   digest. Do not adopt it in TeamAI in this workstream.

## Known limitations and open decisions

- The plan does not claim a new live ChatGPT browser/E2E run; it preserves the
  already-approved Target C evidence and adds deterministic local policy
  coverage.
- The exact subcommand spelling for the runtime decision surface follows the
  current CLI naming convention, but implementation must expose and exercise a
  concrete production call path; an uncalled helper or Skill-only policy is not
  acceptable.
- The final tag name is provisional until the publication preflight. Any new
  live tag requires recomputation and the canonical review path.

## C2C iteration-0 remediation disposition

The first pre-implementation C2C review returned
`REQUIRED_CAPABILITY_UNAVAILABLE` because the bound read-only workspace
connector could not independently read live Issue #15. The authorized GitHub
read connector refreshed `01-issue-snapshot.md` at
`2026-10-05T17:19:39.9513586Z`; title, state, timestamps, and body were
unchanged. The following findings were accepted into this revised plan:

- Finding 2 (HIGH): require and test one runtime/CLI production decision path;
  remove the no-call-site escape hatch.
- Finding 3 (HIGH): add one-shot freshness/TOCTOU semantics, a per-observation
  nonce, re-observation after transitions, and stale/reuse negative tests.
- Finding 4 (MEDIUM): require authoritative expected and observed account /
  ownership identities and explicit wrong/foreign/missing tests.
- Finding 5 (MEDIUM): include the existing `CONTEXT.md` modification as an
  intentional in-scope architecture/glossary change and inspect it in the
  reviewed diff.

The live Issue recheck restores the required evidence path. Submit this
revised plan for a new canonical pre-implementation C2C review before any
implementation or publication.

## C2C iteration-1 `FIX_REQUIRED` remediation

The previous canonical review confirmed the iteration-0 remediations but
returned `FIX_REQUIRED` for two implementation-authority gaps. This amendment
resolves them at plan level before the next review:

- **Stateful one-shot nonce:** the runtime-owned `consent prepare`/`consent
  decide` wrapper now registers a bounded challenge, binds observed evidence,
  acquires an inter-process exclusive lock, atomically consumes the challenge
  before `AUTO_CONFIRM`, and rejects second/expired/unknown/changed-surface or
  changed-binding use. Cleanup and concurrent-consume tests are required.
- **Expected account/ownership authority:** automatic consent derives the
  expected account only from an existing machine-verified
  `ConnectionBinding.accountFingerprint`; missing legacy identity fails closed
  and is never browser-backfilled. Observed account and ownership proof must
  equal that fingerprint and the exact durable connector binding, with explicit
  missing/wrong/foreign tests.

These are implementation details constrained by approved Q705/Q708 semantics,
not new product scope. No source implementation occurs until this revised plan
passes the canonical C2C review.

## Q708 amendment disposition

The amended requirements and finalized Issue #15 add the supported ChatGPT
custom-MCP creation surface. This plan therefore treats the app-shell
plugin/customize -> `/plugins` -> clear search -> Add -> Create custom MCP
server route as a first-class runtime boundary, while retaining Settings as
management/recovery only. A redirect from `CHATGPT_CREATE_CONNECTOR_URL` to
Settings is route drift and must recover semantically through the app-shell
surface before any capability-unavailable result. The route, metadata, Skill,
documentation, first-time setup, reconnect/recovery, guided manual setup, and
associated tests are all in scope; no hidden storage/API workaround or TeamAI
change is permitted. Q701-Q707, Target C behavior, and `.13` consent semantics
remain unchanged.

## C2C review request

Independently review this draft against live Issue #15 and the current
repository through the read-only connector. Check requirements coverage,
preservation of Target C, semantic (not mechanical) `.13` reconciliation,
architecture/trust boundaries, exact scope and consent behavior, version/ref
consistency, Q708 surface-routing and route-drift behavior, compatibility/
migration, concurrency, tests, rollback, and implementation order. Confirm the
Issue body and local snapshot contain Q708 and acceptance criteria 9–18.
Return each finding with `severity`, `rationale`,
`evidence`, and `recommended change`, followed by a canonical verdict
(`PASS`, `FIX_REQUIRED`, `HUMAN_DECISION_REQUIRED`, or
`REQUIRED_CAPABILITY_UNAVAILABLE`).

## C2C iteration-2 review disposition

The canonical C2C review independently re-read the amended Issue #15
snapshot and the revised plan through the bound read-only workspace. It
returned `PASS`. Q701-Q708 and acceptance criteria 9-18 are covered; the
app-shell `/plugins` -> clear inherited search/filter -> Add -> Create custom
MCP server route is the normal creation path; Settings remains
management/recovery-only; and Settings redirects from the historical deep
link are classified as recoverable route drift. The review also confirmed
separate coverage for first-time automatic setup, reconnect/recovery, and
guided manual setup.

The two prior `FIX_REQUIRED` findings are closed at plan level: the runtime
`consent prepare`/`consent decide` path owns a bounded stateful challenge with
atomic one-shot consumption, replay/expiry/unknown/changed-surface rejection,
and concurrency/cleanup tests; and expected account authority comes only from
the machine-verified `ConnectionBinding.accountFingerprint`, with missing
identity failing closed and no caller-supplied expected account or owner.
The review found no remaining pre-implementation plan change and stated that
this plan may proceed to the Visual Plan approval gate. No source
implementation, publication, or TeamAI change is authorized by this record.

### Canonical disposition

`PLAN_READY_FOR_VISUAL_REVIEW`

## Visual Plan approval disposition

The user explicitly approved this current plan at the canonical `Visual Plan
approval` Human Gate after the iteration-2 pre-implementation C2C review
returned `PASS`. The Step 4 route is recorded as `direct` because this
workstream's evidence is source, metadata, tests, and security behavior rather
than a rendered visual output; the approved artifact is this plan. Step 5
implementation may proceed within the approved Q701-Q708 scope. No TeamAI,
publication, or unrelated workstream change is authorized by this approval.
