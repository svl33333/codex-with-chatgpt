# Requirements Discovery — immutable custom runtime release

## Workstream identity and authority

- Repository: `svl33333/codex-with-chatgpt`
- Workstream slug: `custom-runtime-release`
- Workstream kind: maintenance / release provenance
- Local branch: `maintenance/custom-runtime-release`
- Requirements baseline: current fork `main` at
  `1623df922bc5b8209e8bd797f392f9ac29e5c930`
- Canonical workflow: `codex-c2c-v2` 2.4.0 at
  `0069229049099c076a74ebb0c1797328ea8f8d3a`
- Existing approved runtime: tag `v0.1.3-svl.13`, commit
  `13d13f0a05bfaa102394de7145607241d9da1c48`
- Existing C implementation workstream and Issue #13 are historical evidence
  only. They are not resumed or edited by this workstream.
- TeamAI repository `svl33333/ai-agent-harness` is outside this workstream's
  write scope. No TeamAI pin, provenance file, bootstrap policy, or Skill SHA
  pin is changed here.

This document is a Step 1 requirements artifact. It authorizes no source
implementation, Issue creation, branch publication, PR, merge, or immutable
tag. Those actions follow the canonical workflow and their named Human Gates.

## Live facts re-verified before requirements capture

### Fork and tag state

- Repository metadata reports `main` as the default branch and confirms push
  access for the configured GitHub connection.
- `main` is `1623df922bc5b8209e8bd797f392f9ac29e5c930`, a merge of PR #14 with
  parents `c8e5a2b2ed7b56330983ecf2f5f629dea3f337db` and
  `9642c057495266fa8dbdabeba89cf785e9b04406`.
- The immutable tag `v0.1.3-svl.13` resolves through annotated tag object
  `12a166943a8acb95e916d691c88dc649cc8ce81c` to commit
  `13d13f0a05bfaa102394de7145607241d9da1c48`.
- No `v0.1.3-svl.14` or `v0.1.3-svl.15` tag exists.
- GitHub comparison of `.13` commit to current `main` is explicitly
  `diverged`: current `main` has 10 commits not on `.13`; the `.13` line has
  two commits not on current `main`:
  `10cd9a3fae42b528829b61ddc1c90c93674cc8f1` and
  `13d13f0a05bfaa102394de7145607241d9da1c48`.
- The two `.13`-side commits are the reviewed verified-connector-consent
  patch. They must be semantically reconciled, not mechanically merged or
  cherry-picked.

### TeamAI authority

The installed TeamAI runtime pin remains the separately approved
`v0.1.3-svl.13` / `13d13f0a05bfaa102394de7145607241d9da1c48` line. A mutable
fork `main` update is not an approved runtime update. This workstream records
the TeamAI boundary but does not modify the TeamAI repository.

### Current merged Target C behavior

The reviewed tree at `main` contains the Full Auto provisioning behavior from
PR #14, including:

- automatic Project reconciliation and bounded create when zero exact Projects
  exist;
- deterministic display-name normalization separate from durable identity;
- Project-only memory and distinct Project collection, settings, Instructions,
  reviewer-composer, connector, and OAuth/pairing surfaces;
- automatic pairing compatibility behavior and exact read-only connector
  binding;
- message-keyed ReviewerProof with current HEAD, complete git status/diff,
  repository/root/branch, connector identity, and read-only checks;
- fail-closed workspace mismatch and fresh-product E2E evidence carried by the
  merged workstream.

These behaviors are the release baseline and must not regress to the older
`.13` implementation.

### `.13`-only consent contract

The actual `.13` source and tests define a narrow policy helper. Automatic
confirmation is allowed only when all of the following machine-verifiable
guards hold:

1. `setupMode` is `auto`.
2. An explicit C2C request exists, or the canonical workflow supplies that
   explicit C2C intent.
3. The structured consent surface is exactly the expected ChatGPT
   unreviewed-MCP warning; warning text alone is insufficient.
4. Connector ownership and ChatGPT account identity are resolved.
5. No login, CAPTCHA, unsupported 2FA, destructive/security-sensitive, or
   ambiguous-account boundary is present.
6. The observed workspace, canonical repository, installation identity,
   endpoint mode, endpoint fingerprint, and connector name exactly match the
   expected binding.
7. The observed OAuth scopes are exactly the runtime-owned read-only set:
   `workspace.read`, `workspace.search`, `git.read`, `execution.read`, and
   `offline_access`, with no duplicates or extra/write scope.

Any failed or unknown guard returns `HUMAN_REQUIRED`. The policy does not add
an acknowledgement-only chat step after an automatic decision. The
runtime-owned scope set cannot be widened by a browser adapter's expected-value
argument.

## Problem statement

Current fork `main` is the merged Target C implementation but still advertises
custom version/provenance `0.1.3-svl.12`, and it does not contain the `.13`
consent-policy module/tests. Treating mutable `main` as the TeamAI runtime
would therefore mix a reviewed product tree with stale release identity and
would omit the fail-closed automatic-consent contract. Tagging `main` directly
would also discard the semantic reconciliation required by the divergent
history.

The maintenance workstream must produce one internally consistent, reviewed,
validated, immutable custom runtime candidate that preserves the merged Target C
behavior and incorporates the `.13` consent semantics. TeamAI adoption is a
later pin-adoption workstream.

## Goals

1. Reconcile the `.13` consent policy into the current C-merged line without
   regressing Project provisioning, pairing, identity, or ReviewerProof.
2. Make package, source, documentation, bootstrap, installer, tests, and tag
   metadata advertise one custom release version. Live tag rules select the
   next suffix after `.13`, `0.1.3-svl.14`, with the final tag name derived and
   rechecked at publication time.
3. Preserve a deterministic regression suite for both the Target C behavior
   and the consent policy, including fail-closed boundary cases.
4. Run all repository-required validation from the reconciled candidate.
5. Obtain canonical C2C review and publish only through the authorized
   immutable-release path after the applicable Human Gates.
6. Record the final tag, target commit, package version, and exact Skill
   SHA-256 for the follow-up TeamAI pin-adoption maintenance.

## Non-goals and exclusions

- Do not modify `svl33333/ai-agent-harness`, `c2c-runtime.json`, `teamai.yaml`,
  TeamAI provenance, bootstrap docs, or TeamAI Skill pins.
- Do not resume or alter `final-review-state-model`, Issue #6 semantics, A0,
  A2, A3/A4, unrelated connectors, or the completed Target C historical state.
- Do not move, delete, force-push, or rewrite `v0.1.3-svl.13` or any existing
  published history.
- Do not mechanically merge/cherry-pick the `.13` branch merely to join
  history, and do not tag mutable `main` without a reviewed candidate.
- Do not broaden connector scopes, ownership, account selection, or write
  capabilities. Do not store credentials, cookies, pairing values, private
  endpoints, or browser state in source, logs, fixtures, Project memory, or
  workstream state.
- Do not claim live-product E2E from synthetic tests or use synthetic tests as
  a substitute for evidence already required by the approved Target C work.

## Constraints, dependencies, security, and privacy

- The release must retain the exact current C Project/reviewer separation and
  read-only connector contract.
- Consent is a security-sensitive boundary. Only structured, exact, current
  DOM/surface evidence may authorize the expected warning; generic text or a
  same-name connector never does.
- Scope comparison is set-exact with duplicate rejection and the expected set
  owned by runtime code.
- Any unresolved login, CAPTCHA, unsupported 2FA, password/recovery, account
  or ownership ambiguity, unexpected SSO/scope expansion, destructive action,
  or unsupported consent surface remains human/security bounded.
- Validation uses the repository's frozen dependency and build rules. Python
  work, if needed, uses the Codex-bundled interpreter identified in the
  workflow-resolution artifact.
- GitHub read/write operations use the current configured GitHub connector or
  credential-visible context after the installed `github-cli-auth` preflight;
  no token is printed or copied.

## Custom-MCP creation-surface contract

The custom runtime must treat the visible ChatGPT app-shell plugin surface as
the normal custom-MCP creation route. The route is: app-shell plugin/customize
control -> main `/plugins` surface -> clear any inherited search/filter ->
`Add`/`追加` -> `Create a custom MCP server`/`カスタム MCP サーバーを作成`
-> enter the expected connector name, description, and current MCP URL ->
choose OAuth -> inspect and retain only the expected read-only scopes and exact
consent warning -> `Create as plugin`/`プラグインとして作成`. The existing
identity, account/owner, endpoint, workspace, pairing, `workspace_info`,
`git_status`, ReviewerProof, and fail-closed checks continue after creation.

`Settings -> Plugins` and `/settings/plugins-settings` are management and
recovery surfaces for inspecting or deleting known plugins; they are not the
normal custom-MCP creation route. The historical
`CHATGPT_CREATE_CONNECTOR_URL`
(`https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`)
must not be treated as authoritative proof that creation is available. If it
redirects to Settings, record route drift and recover semantically through the
app-shell plugin/customize surface; do not classify that redirect alone as
`REQUIRED_CAPABILITY_UNAVAILABLE`. If the constant is retained, it must be
clearly bounded as a compatibility/navigation observation; it may instead be
renamed, deprecated, or redefined so its metadata cannot mislead callers.

This contract applies to first-time automatic setup, reconnect/recovery, and
guided manual setup. Use visible accessible labels and observable state; do not
edit hidden browser storage, call undocumented/private APIs, or use a plugin
creator workaround. The implementation must inventory and test every applicable
runtime surface, including `skill/SKILL.md`, `docs/troubleshooting.md`,
`src/config/endpoint.ts`, `src/cli/index.ts`, the first-time and recovery
orchestrators, guided manual setup, Skill-contract tests, surface-routing and
compatibility tests, and CLI/page-metadata tests where applicable.

## Stable design-tree questions and captured answers

### Q701 — Workstream lineage

**Question:** Should this task resume the prior C workstream or create a new
maintenance release workstream?

**Answer:** Create `custom-runtime-release` from current `main`. The prior
workstream is complete historical evidence and its state must not be modified;
the current task is release maintenance after its merge.

**Impact:** A new `.harness/custom-runtime-release/` state is used. The prior
`.harness/full-auto-c2c-provisioning-revision/` and
`final-review-state-model` state remain untouched.

### Q702 — Divergent `.13` history

**Question:** How should the two `.13`-only commits be handled on the C line?

**Answer:** Port and re-prove their consent semantics at the current C tree:
the runtime-owned consent decision helper, exact binding/scope guards, Skill
contract, documentation, and deterministic consent tests. Do not join history
by mechanical merge/cherry-pick.

**Impact:** The final review must classify the resulting source/tests/docs as
an intentional semantic reconciliation and confirm no C behavior is lost.

### Q703 — Next custom version and tag

**Question:** Which immutable custom version is eligible after the live tags?

**Answer:** The release rules require a suffix bump; live tags end at
`v0.1.3-svl.13`, so the candidate is `0.1.3-svl.14` with tag
`v0.1.3-svl.14`. Recheck that the tag is still absent immediately before
publication; if another immutable tag appears, stop and recompute rather than
reusing a name.

**Impact:** All version/provenance/default-ref surfaces must agree on `.14`;
TeamAI remains pinned to `.13` until a later workstream.

### Q704 — Target C preservation

**Question:** Which behavior is authoritative when `.13` and current `main`
diverge?

**Answer:** Current C-merged `main` is authoritative for provisioning,
Project, pairing compatibility, exact connector/reviewer binding, ReviewerProof,
and E2E behavior. The `.13` line contributes only its consent contract and
associated provenance/tests, adapted to current types and surfaces.

**Impact:** No older `.13` Skill or provisioning text may replace the current
Project reconciliation or ReviewerProof path.

### Q705 — Consent boundary

**Question:** When may automatic confirmation occur?

**Answer:** Only for the exact expected read-only C2C warning when every guard
listed in the `.13`-only consent contract is true. Otherwise the decision is
`HUMAN_REQUIRED`/security bounded, with no acknowledgement-only detour after a
machine-observable automatic decision.

**Impact:** Add explicit policy tests for wrong identity, endpoint/workspace,
scope expansion/duplicates, unknown surface, unresolved account/ownership,
login/CAPTCHA/2FA/destructive/ambiguous account, manual setup, and missing
explicit C2C intent.

### Q706 — TeamAI and old-tag boundary

**Question:** Should the release task update TeamAI or move the approved `.13`
tag?

**Answer:** No. Publication ends at the new immutable custom tag and recorded
provenance. TeamAI pin adoption is the next maintenance workstream; the `.13`
tag and history remain immutable.

**Impact:** Any proposed TeamAI diff or tag rewrite is out of scope and must
block publication until removed.

### Q707 — Validation and review evidence

**Question:** What evidence makes the candidate eligible for publication?

**Answer:** Frozen install where needed, typecheck, full tests, build,
`git diff --check`, consent-policy tests, provisioning/Project tests,
ReviewerProof tests, Skill contract tests, and every repository release/version
check must pass. The canonical configured ChatGPT C2C connector must independently
review the reconciled diff; local evidence is supplemental only.

**Impact:** Recoverable failures enter the canonical remediation loop, not a
Human Gate. Missing required C2C capability is `BLOCKED` with one recovery
action; publication cannot proceed from unreviewed or unvalidated code.

### New evidence — supported custom-MCP creation surface

The canonical TeamAI repository contains read-only evidence commit
`84c206baf8fb321ced0c3bfd25fd11da121108a2`, titled `Document supported custom
MCP creation route`. Its reference distinguishes the Settings Plugins pane
from the app-shell plugin directory, requires clearing inherited search before
`Add` -> `Create a custom MCP server`, and preserves the existing OAuth,
identity, ownership, endpoint, workspace, pairing, and read-only-scope checks.
The commit is evidence for this requirements amendment only; it is not a
workflow authority and the TeamAI repository remains outside this workstream's
write scope.

### Q708 — ChatGPT custom-MCP creation surface

**Question:** Which ChatGPT surface is authoritative for normal custom-MCP
creation, and how must route drift be handled?

**Answer:** Use the visible app-shell plugin/customize route and its semantic
`/plugins` directory. Clear any inherited search/filter, observe `Add`/`追加`,
choose `Create a custom MCP server`/`カスタム MCP サーバーを作成`, fill the
expected connector name, description, and current MCP URL, choose OAuth,
verify the exact read-only scopes and consent warning, then choose `Create as
plugin`/`プラグインとして作成`. Continue through the existing exact account,
owner, workspace, repository, endpoint, connector identity, pairing,
`workspace_info`, `git_status`, ReviewerProof, and fail-closed path.

Settings -> Plugins and `/settings/plugins-settings` remain valid management or
recovery surfaces but are not normal creation. The legacy
`CHATGPT_CREATE_CONNECTOR_URL` deep link is compatibility/navigation evidence
only. A redirect to Settings is route drift, not proof of unavailable
capability; recover through the app-shell surface before returning any bounded
capability or Human Boundary outcome. First-time auto setup, reconnect/recovery,
and guided manual setup all use this same semantic route. No hidden storage,
undocumented API, or plugin-creator workaround is allowed.

**Impact:** The implementation and tests must cover the complete surface
inventory named above, including Skill and troubleshooting prose, endpoint and
CLI/page metadata, all setup/recovery modes, Skill-contract checks,
surface-routing/compatibility checks, and applicable CLI metadata checks. The
route change must not alter Target C provisioning/Project/pairing/connector/
reviewer behavior or the `.13` fail-closed consent/security semantics. TeamAI
remains a separate later pin-adoption workstream.

## Acceptance criteria (Given / When / Then)

1. **Live baseline:** Given the workstream starts, when live state is resolved,
   then current `main`, `.13` tag/commit, tag absence for the next suffix, and
   the divergent comparison are recorded with exact SHAs.
2. **Semantic disposition:** Given the two `.13`-only commits, when the
   candidate is implemented, then their consent behavior is present on the C
   line without mechanically joining the divergent histories.
3. **Consent safety:** Given any missing or mismatched guard, when the policy
   is evaluated, then it returns `HUMAN_REQUIRED` and never authorizes a
   generic or broadened consent action. Given every guard matches, it returns
   `AUTO_CONFIRM` only for the expected read-only warning.
4. **C behavior preservation:** Given the candidate, when provisioning,
   pairing, Project, connector, and ReviewerProof tests run, then current C
   behavior—including bounded Project create, deterministic display label,
   exact settings/composer separation, message-keyed proof, complete diff, and
   fail-closed mismatch—remains passing.
5. **Release consistency:** Given the candidate, when release/version checks
   inspect package, source, docs, bootstrap/update defaults, Skill installer
   defaults, and tests, then they all identify exactly `0.1.3-svl.14` and its
   new tag/provenance policy with no stale `.12` or conflicting `.13` runtime
   advertising.
6. **Validation:** Given the reconciled candidate, when the full required
   validation runs, then install/typecheck/tests/build/diff-check and release,
   consent, provisioning, ReviewerProof, and Skill-contract checks pass.
7. **Review and publication:** Given a clean validated candidate, when the
   canonical C2C review passes and the named publication Human Gate is granted,
   then one new immutable tag is published without rewriting old tags, and the
   exact tag, target commit, package version, and Skill SHA-256 are recorded.
8. **TeamAI boundary:** Given publication completes, when the follow-up is
   described, then TeamAI remains unchanged and the next action is explicitly
   TeamAI pin-adoption maintenance.
9. **Normal app-shell creation:** Given a new connector is required, when the
   automatic route runs, then it reaches `/plugins`, clears inherited filters,
   observes `Add`/`追加`, opens `Create a custom MCP server`/`カスタム MCP
   サーバーを作成`, fills the expected name/description/current MCP URL,
   selects OAuth, verifies exact read-only scopes and consent, and uses `Create
   as plugin`/`プラグインとして作成`.
10. **Settings is not creation:** Given Settings -> Plugins or
    `/settings/plugins-settings` is visible, when normal creation is needed,
    then that surface is not selected as the creation route; it remains usable
    only for permitted management/recovery inspection or deletion.
11. **Deep-link route drift:** Given `CHATGPT_CREATE_CONNECTOR_URL` redirects to
    Settings, when the redirect is observed, then it is recorded as route drift
    and not as `REQUIRED_CAPABILITY_UNAVAILABLE`.
12. **Redirect recovery:** Given route drift, when recovery continues, then the
    app-shell plugin/customize surface is rediscovered and used before any
    bounded capability or Human Boundary result is returned.
13. **Observable Add/Create:** Given an app-shell directory with a carried-over
    query, when the route is exercised, then the visible clear-search control
    is used and the unfiltered directory exposes observable `Add` and `Create a
    custom MCP server` actions; a genuinely absent or gated action produces
    evidence-backed bounded handling.
14. **Management remains valid:** Given an existing connector, when inspection
    or deletion is required, then the plugins hub/settings management surface
    remains available without bypassing exact identity and ownership checks.
15. **All setup modes use the route:** Given first-time auto setup,
    reconnect/recovery, or guided manual setup, when custom-MCP creation is
    required, then each mode follows the app-shell route and guided manual mode
    does not fall back to the Settings creation path.
16. **Identity and security safety:** Given any route, when connector creation or
    handoff proceeds, then account/owner, endpoint, workspace, repository,
    connector identity, exact scopes, consent, pairing, `workspace_info`,
    `git_status`, ReviewerProof, and fail-closed checks remain unchanged and
    mismatches never authorize continuation.
17. **No hidden workaround:** Given a route mismatch or missing visible action,
    when compatibility is evaluated, then no hidden storage edit,
    undocumented/private API, or plugin-creator workaround is used or treated
    as equivalent evidence.
18. **Target C and `.13` preservation:** Given the route amendment, when the
    full Target C and `.13` regression suites run, then Project/provisioning,
    pairing, reviewer identity/ReviewerProof, read-only scopes, and
    fail-closed consent/security semantics remain passing; TeamAI pins and
    repository history remain untouched.

## Edge cases and failure behavior

- A new `.14` tag appears while work is in progress: stop before publication,
  re-resolve the next suffix and update only the current workstream state after
  the required review path.
- A file still advertises `.12` or a bootstrap default points at `.13`: fail
  release validation and repair the affected surface before review.
- A consent warning has the right text but unknown surface, wrong account,
  foreign connector, endpoint drift, duplicate/extra scope, or incomplete
  ownership proof: return `HUMAN_REQUIRED`; do not click or broaden.
- The deep creation link redirects to `/settings/plugins-settings`: classify
  this as route drift, recover to app-shell `/plugins`, and do not declare the
  creation capability unavailable solely from the redirect.
- The app-shell carries an inherited search/filter or hides `Add`/`Create`: use
  the visible clear-search action and wait for the unfiltered directory; only a
  genuinely absent or gated action is a bounded capability result.
- A guided/manual or recovery instruction still names the Settings creation
  pane or a hidden endpoint: repair the instruction and route through the
  visible app-shell capability without using storage/API workarounds.
- A current C Project/reviewer test regresses: preserve C semantics and
  remediate; do not substitute `.13` code wholesale.
- C2C review returns `FIX_REQUIRED`: remediate, revalidate, and re-review in
  the same workstream. `REQUIRED_CAPABILITY_UNAVAILABLE` remains `BLOCKED`.
- GitHub auth context fails: use the installed `github-cli-auth` procedure and
  retain the exact remaining human/security action; never print credentials or
  loop authentication.
- Any publication uncertainty: do not guess whether a tag was created; read
  the exact remote ref, then continue only if the canonical state is known.

## Rollback, migration, and provenance concerns

- The old `v0.1.3-svl.13` tag is a preserved rollback/reference point and is
  never moved or rewritten.
- A failed candidate remains a local branch/worktree and can be discarded by
  canonical workflow recovery; it must not be installed as TeamAI runtime.
- Runtime adoption is immutable-ref based. A later TeamAI maintenance task
  must record the new tag commit, package version, and Skill digest before
  changing any TeamAI pin.
- No secret, endpoint URL, pairing code, token, browser session, or account
  credential is part of release provenance.

## Canonical terminology and boundaries

- **C-merged line:** current `main` tree at `1623df9…`, authoritative for
  Target C product behavior.
- **`.13` consent semantics:** the reviewed narrow policy from commits
  `10cd9a3…` and `13d13f0…`; it is ported semantically, not as history.
- **Consent guard:** structured machine evidence that decides whether the exact
  warning is eligible for automatic confirmation.
- **Durable identity:** workspace, repository, installation, endpoint, account,
  Project, and connector identifiers; display labels are not identity.
- **Immutable runtime release:** reviewed validated commit plus a new custom tag
  and internally matching version/provenance/Skill digest.
- **TeamAI pin adoption:** a distinct follow-up that updates TeamAI only after
  this release exists; it is not part of this workstream.

## Assumptions and impact

- The current GitHub connector remains available for read-only live rechecks and
  the later canonical review. If it becomes unavailable, the workstream records
  the capability block rather than substituting a local reviewer.
- The repository's existing package manager and test scripts remain the
  authoritative validation entry points; no new dependency manager is invented.
- The final release tag suffix remains available until the publication gate. If
  not, Q703 is recomputed from live tags.
- The current C E2E evidence is regression evidence, not new live-product proof;
  no claim beyond the recorded evidence is made.
- The TeamAI evidence commit describes the supported app-shell route but does
  not authorize TeamAI changes; its contract is carried into a later,
  separately approved pin-adoption maintenance workstream.

## Unresolved questions

Q708 resolves the creation-surface and route-drift requirement at the
requirements level. The algorithmic details of adapting the consent helper to
the current C types and the exact test command ordering remain implementation
choices constrained by Q701-Q708. The canonical C2C review connector
availability and publication approval are later workflow gates, not
requirements ambiguities. Explicit approval of this amended artifact is still
pending.

## Human Gate

The requirements are amended with Q708 while Q701-Q707 remain unchanged. The
previous approval is superseded for this amended artifact; explicit approval of
the complete Q701-Q708 set is required. The next canonical action is to approve
or request changes to this artifact. Until then, remain at Step 1 and do not
finalize Issue #15 or proceed to implementation/review/publication gates.

`REQUIREMENTS_READY_FOR_APPROVAL`
