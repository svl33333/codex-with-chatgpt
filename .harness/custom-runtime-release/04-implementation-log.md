# Step 5 Implementation Log

Workstream: `custom-runtime-release`
Issue: [#15](https://github.com/svl33333/codex-with-chatgpt/issues/15)
Branch: `maintenance/custom-runtime-release`
Approved plan: `.harness/custom-runtime-release/02-plan-draft.md`

## Scope and implementation

The current C-merged line was preserved while the reviewed `.13` consent
semantics were reconciled into a runtime-owned implementation. The candidate
changes are limited to the approved Q701-Q708 contract:

- Added a pure exact-scope consent policy over the existing binding model.
- Added a production CLI `consent verify-account` → `consent prepare` /
  `consent decide` path. The first command accepts only a current,
  authenticated account-surface observation whose six binding dimensions match
  the runtime binding, then persists only the machine-verified
  `ConnectionBinding.accountFingerprint`; absent or conflicting authority
  remains `HUMAN_REQUIRED` and is never browser-backfilled.
- Added a bounded non-secret challenge registry with exclusive locking, atomic
  first-attempt terminalization (including fail-closed decisions), expiry/
  cleanup, replay rejection, and fail-closed identity, ownership, binding,
  surface, freshness, and exact-scope checks.
- Added semantic ChatGPT app-shell route selection for `/plugins` → clear
  inherited filter → Add → Create custom MCP server. Settings remains a
  management/recovery surface; legacy redirects are route drift with bounded
  recovery.
- Updated first-time, reconnect/recovery, and guided-manual Skill/docs route
  instructions and the endpoint/CLI metadata; preserved the existing Project,
  pairing, connector, workspace, ReviewerProof, and fail-closed contracts.
- Updated scoped release surfaces to candidate `.14` and added deterministic
  release-consistency, routing, consent, endpoint, and Skill-contract tests.
- Preserved the intentional `CONTEXT.md` task-scoped architecture update.

TeamAI pins, `svl33333/ai-agent-harness`, unrelated repositories/connectors,
and immutable published history were not modified.

## Validation

The complete command/results record is in
`.harness/custom-runtime-release/04-test-summary.md`. Final validation passed:

- focused contract suite: 45 tests;
- full suite: 289 tests;
- TypeScript typecheck;
- production build;
- `git diff --check`.

## C2C disposition

The pre-implementation plan review iteration 2 returned `PASS`, and the user
approved the plan at the Visual Plan approval gate. The implementation is now
ready for the canonical post-implementation C2C review through the bound
read-only connector. Any `FIX_REQUIRED` finding will be remediated within the
approved scope, revalidated, and re-reviewed; capability-unavailable findings
follow the canonical `BLOCKED` transition.

The first post-implementation review returned `FIX_REQUIRED`. Its accepted
findings are implementation-authority corrections within the approved plan:

- add a separate machine-verified account-binding establishment path before
  consent preparation, persisting only the verified fingerprint into the
  existing binding;
- terminalize a registered consent challenge on the first valid decision
  attempt, including fail-closed decisions, so invalid-first/valid-second
  reuse cannot occur; and
- add the plan's complete deterministic negative matrix and correct the test
  summary to report demonstrated coverage only.

No requirements, plan scope, TeamAI boundary, or publication gate is reopened.

The iteration-4 post-implementation C2C re-review returned `PASS`. It
independently confirmed the separate `verify-account` authority path, first-
attempt challenge terminalization, complete negative consent matrix, Q708
app-shell routing, Target C preservation, `.14` release consistency, and the
TeamAI/publication boundary. Step 5 is complete and the workstream now waits
at the canonical Push/PR publication Human Gate.

## Known limitations and publication boundary

- The `.14` tag and exact provenance remain provisional until the required live
  tag recheck immediately before publication.
- This workstream does not claim a new live ChatGPT browser/E2E run.
- No commit, push, PR publication, tag creation, merge, or TeamAI pin adoption
  is performed in Step 5.

`IMPLEMENTATION_READY_FOR_PUSH_APPROVAL`
