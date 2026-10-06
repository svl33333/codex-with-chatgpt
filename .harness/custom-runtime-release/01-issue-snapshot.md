# Step 2 Issue Snapshot

Source: live GitHub connector response for `svl33333/codex-with-chatgpt#15`.
The GitHub Issue is the authoritative requirements source after Step 2.
Refreshed: 2026-10-05T17:19:39.9513586Z through the authorized GitHub read
connector after the pre-implementation C2C review requested a live recheck.
The refreshed title, state, timestamps, and body are unchanged.

- Number: #15
- URL: https://github.com/svl33333/codex-with-chatgpt/issues/15
- Title: Custom runtime release: reconcile .13 consent into Target C main
- State: open
- Created: 2026-10-05T16:17:11Z
- Updated: 2026-10-05T16:17:11Z

## Body captured from the live Issue

# Custom runtime release: reconcile `.13` consent into Target C main

Workstream: `custom-runtime-release`

This Issue is the authoritative Step 2 conversion of the explicitly approved
Step 1 requirements artifact. It does not authorize publication by itself.
All later implementation, validation, C2C review, and publication gates remain
governed by the pinned canonical `codex-c2c-v2` workflow.

## Background / Problem

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

## Non-goals

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

## Requirements

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

## Constraints

The following constraints are preserved verbatim from the approved requirements:

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

## Acceptance Criteria

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

## Edge Cases

- A new `.14` tag appears while work is in progress: stop before publication,
  re-resolve the next suffix and update only the current workstream state after
  the required review path.
- A file still advertises `.12` or a bootstrap default points at `.13`: fail
  release validation and repair the affected surface before review.
- A consent warning has the right text but unknown surface, wrong account,
  foreign connector, endpoint drift, duplicate/extra scope, or incomplete
  ownership proof: return `HUMAN_REQUIRED`; do not click or broaden.
- A current C Project/reviewer test regresses: preserve C semantics and
  remediate; do not substitute `.13` code wholesale.
- C2C review returns `FIX_REQUIRED`: remediate, revalidate, and re-review in
  the same workstream. `REQUIRED_CAPABILITY_UNAVAILABLE` remains `BLOCKED`.
- GitHub auth context fails: use the installed `github-cli-auth` procedure and
  retain the exact remaining human/security action; never print credentials or
  loop authentication.
- Any publication uncertainty: do not guess whether a tag was created; read
  the exact remote ref, then continue only if the canonical state is known.

## Open Questions

None. The approved Step 1 artifact records no blocking product or security question. Q701–Q707 are resolved and any new semantic decision must return to the canonical requirements gate.

## Implementation Notes

- The old `v0.1.3-svl.13` tag is a preserved rollback/reference point and is
  never moved or rewritten.
- A failed candidate remains a local branch/worktree and can be discarded by
  canonical workflow recovery; it must not be installed as TeamAI runtime.
- Runtime adoption is immutable-ref based. A later TeamAI maintenance task
  must record the new tag commit, package version, and Skill digest before
  changing any TeamAI pin.
- No secret, endpoint URL, pairing code, token, browser session, or account
  credential is part of release provenance.

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

- The current GitHub connector remains available for read-only live rechecks and
  the later canonical review. If it becomes unavailable, the workstream records
  the capability block rather than substituting a local reviewer.
- The repository's existing package manager and test scripts remain the
  authoritative validation entry points; no new dependency manager is invented.
- The final release tag suffix remains available until the publication gate. If
  not, Q703 is recomputed from live tags.
- The current C E2E evidence is regression evidence, not new live-product proof;
  no claim beyond the recorded evidence is made.

## Approval and provenance

- Approved artifact: `.harness/custom-runtime-release/00-requirements-working.md`
- Explicit approval: current user instruction approving the complete amended Q701–Q708 requirements without changes.
- TeamAI repository, all TeamAI pins, existing immutable tags, historical Target C, `final-review-state-model`, A0, A2, A3/A4, and unrelated connectors/repositories are outside this Issue.
- The next canonical action after Issue finalization is Step 3 planning and required independent C2C review.

## Approved Q708 amendment — ChatGPT custom-MCP creation surface

The requirements were amended and explicitly approved without changes. Q701–Q707 remain unchanged. Q708 is supported by TeamAI evidence commit `84c206baf8fb321ced0c3bfd25fd11da121108a2`, which is evidence only and does not authorize TeamAI changes.

### Q708 contract

- Normal custom-MCP creation uses the visible ChatGPT app-shell plugin/customize surface: `/plugins` -> clear inherited search/filter when needed -> `Add`/追加 -> `Create a custom MCP server`/カスタム MCP サーバーを作成.
- Fill the expected connector name, description, and current MCP URL; choose OAuth; verify the exact read-only scopes and consent warning; then use `Create as plugin`/プラグインとして作成.
- `Settings -> Plugins` and `/settings/plugins-settings` are management/recovery surfaces, not the normal creation route.
- `CHATGPT_CREATE_CONNECTOR_URL` is compatibility/navigation evidence only. A redirect to Settings is route drift, not capability unavailability; recover semantically through the app-shell surface.
- First-time automatic setup, reconnect/recovery, and guided manual setup use the same app-shell route. Hidden storage edits, undocumented/private APIs, and plugin-creator workarounds are prohibited.
- Preserve account/ownership, connector identity, endpoint, workspace/repository, exact read-only scopes, consent, pairing, `workspace_info`, `git_status`, ReviewerProof, and fail-closed contracts.
- Inventory and test `skill/SKILL.md`, `docs/troubleshooting.md`, `src/config/endpoint.ts`, `src/cli/index.ts`, setup/recovery instructions, Skill-contract tests, surface-routing/compatibility tests, and applicable CLI/page metadata tests.
- Preserve Target C behavior, the `.13` consent semantics, immutable history, and the TeamAI boundary.

### Additional acceptance criteria

9. The automatic creation path reaches the app-shell `/plugins` surface, clears inherited filters, observes Add/Create, verifies OAuth scopes and consent, and creates the custom MCP server.
10. Settings Plugins is not selected for normal creation and remains available for permitted management/recovery.
11. A deep-link redirect to Settings is classified as route drift, not `REQUIRED_CAPABILITY_UNAVAILABLE`.
12. Route drift recovers through the app-shell plugin/customize surface before bounded capability handling.
13. Clear-search and Add/Create are observable; genuinely absent or gated actions produce bounded evidence.
14. Management inspection/deletion remains available without bypassing identity or ownership checks.
15. First-time auto, reconnect/recovery, and guided manual setup all use the app-shell route.
16. Account/owner, endpoint, workspace/repository, connector identity, exact scopes, consent, pairing, `workspace_info`, `git_status`, ReviewerProof, and fail-closed checks remain unchanged.
17. No hidden storage, undocumented/private API, or plugin-creator workaround is used.
18. Target C and `.13` regression behavior remains passing, with TeamAI pins and repository history untouched.

The canonical next action after this Issue finalization is Step 3 planning and required independent C2C review; implementation and publication remain gated by the pinned workflow.
