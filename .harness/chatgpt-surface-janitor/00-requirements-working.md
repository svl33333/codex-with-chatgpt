# Requirements working document — chatgpt-surface-janitor

## Problem statement

C2C development can leave behind ChatGPT Projects and installed custom
MCP/plugin/connector resources. Removing them one by one in the ChatGPT UI is
slow and makes identity mistakes more likely. The repository needs a local
maintenance utility that can inventory those resources, create a reviewable
machine-local plan, and perform a bounded batch deletion only when the plan
contains exact, revalidated targets.

## Goals

1. Provide an obvious local command surface for `scan`, `plan`, `dry-run`,
   `apply`, and `rescan`.
2. Inventory visible Projects plus plugin, custom-MCP, and connector resources
   from supported ChatGPT browser/app-management surfaces.
3. Persist inventory and plans only in machine-local C2C state, never in the
   repository.
4. Make every resource decision explicit: `keep`, `delete`, or `unknown`.
5. Revalidate stable identifier, kind, expected identifying metadata, and
   protection state immediately before every deletion/uninstall.
6. Fail closed for missing, drifted, ambiguous, unverified, or protected
   resources, while completing other exact independent targets in the same
   approved run.
7. Provide deterministic tests with synthetic adapters and a short routine-use
   document.

## Non-goals

- Runtime/package release, tag changes, TeamAI pin changes, adoption work, or
  changes to the immutable `v0.1.3-svl.14` release.
- Automatic cleanup at workstream completion or broad lifecycle garbage
  collection.
- Any undocumented/private ChatGPT HTTP endpoint, storage inspection,
  credential/cookie/token extraction, or coordinate/screenshot automation.
- Reading Project conversation bodies, private chat content, pairing codes, or
  authentication data to decide deletion eligibility.
- A production-runtime refactor unrelated to the local maintenance command.

## Repository facts observed

- `origin/main` is `075dac3880adef4af90e9fd152f0788a28eb1fa3`; its package
  version is `0.1.3-svl.14` and the release tag evidence matches the task.
- The Node CLI convention is `c2c` (`bin/c2c.js` and `src/cli/index.ts`), with
  Vitest tests under `tests/`.
- Secure, owner-only machine-local JSON is already implemented through
  `src/config/paths.ts`; Windows defaults to
  `%LOCALAPPDATA%/codex-with-chatgpt`.
- `src/provisioning/project.ts` already establishes the critical distinction
  between a display label and durable identity: labels are never sufficient
  evidence for a destructive action.
- `src/provisioning/chatgpt-surface.ts` models verified semantic surfaces and
  capability failure, but source code currently has no executable browser
  inventory/delete adapter. The existing browser-control contract resides in
  the Codex skill and uses semantic DOM checks.

## Canonical terms and boundaries

| Term | Meaning | Boundary |
| --- | --- | --- |
| Resource | One visible ChatGPT-side entity: `project`, `plugin`, `custom_mcp`, or `connector`. | A resource is never identified by display name alone. |
| Inventory snapshot | A timestamped, machine-local normalized observation of resources from the supported surface. | It contains only safe identity/metadata; no secrets or private content. |
| Protection reference | Exact current local C2C state that proves a resource is current or in use. | Absence of proof does not prove deletion safety. |
| Cleanup plan | A machine-local, reviewable set of exact resource decisions over one inventory snapshot. | Every entry is `keep`, `delete`, or `unknown`. |
| Frozen plan digest | The digest binding `apply` to the exact reviewed plan payload. | A different inventory or edited plan cannot be silently substituted. |
| Delete candidate | A plan entry explicitly set to `delete`. | It remains non-destructive until exact preflight revalidation passes. |
| Drift | Any mismatch in resource kind, stable ID, expected metadata, or protection state between plan and apply. | Drift skips/fails closed for that resource. |

## Invariants

1. `unknown` is the default classification and cannot be applied.
2. Similar names, prefixes, timestamps, list position, or substring matches
   never authorize deletion.
3. `apply` selects exact stable IDs from one frozen plan only; there is no
   wildcard, ordinal, or first-name-match delete path.
4. An inventory result that is malformed, ambiguous, route-drifted, or
   unauthenticated has no destructive authority.
5. A current exact protection reference always overrides a proposed deletion.
6. Each deletion validates kind, stable ID, expected metadata, and current
   protection state immediately before the semantic UI confirmation.
7. A post-apply rescan reports removal, skips, remaining planned deletes,
   unknowns, and protected resources; reruns are idempotent.
8. Fixtures, tests, diagnostics, and committed documentation use synthetic
   identifiers only. Live inventory/plan data stays out of Git.

## Acceptance criteria in Given / When / Then form

- Given a supported authenticated ChatGPT surface, when `scan` runs, then it
  emits normalized visible resources with kind, exact stable ID, safe identity
  fields, protection/reference status, classification, and reason.
- Given an observed resource with no exact lifecycle proof, when a plan is
  generated, then its decision is `unknown`.
- Given an exact current protection reference or keep-list entry, when a plan
  is generated, then the resource decision is `keep`.
- Given a manually reviewed `delete` entry in a frozen plan, when `dry-run`
  runs, then it changes no ChatGPT resources and names the exact proposed
  targets plus all keep/unknown/protected counts.
- Given a frozen plan and multiple exact deletions, when `apply` runs, then it
  processes each target independently and only after exact preflight identity
  and protection checks.
- Given a stale plan or target drift, when `apply` runs, then that target is
  skipped or fails closed and no similarly named resource is substituted.
- Given a completed apply, when `rescan` runs, then it reports the outcome for
  every target and is safe to repeat.
- Given fixture-based destructive tests, when the test suite runs, then no
  live ChatGPT resource or personal identifier is required.

## Security and privacy constraints

- Use only supported first-party browser/app-shell surfaces and semantic DOM
  validation; route changes are bounded diagnostics, not prompts to guess.
- Do not inspect browser storage, private endpoints, cookies, tokens, pairing
  codes, project conversation contents, or hidden application state.
- Keep local plan/inventory data at the existing C2C state location with
  owner-only file permissions; never add it to repository fixtures or release
  metadata.
- Projects are especially destructive because deletion may remove their chats,
  files, and instructions. The tool must state this before an apply summary.

## Edge cases and failure behavior

- A resource seen twice with conflicting IDs or metadata becomes `unknown` and
  is non-deletable.
- A target deleted outside the tool between plan and apply is reported as an
  idempotent already-absent/skip result, never replaced by a name match.
- A resource that becomes protected after planning is skipped.
- An unsupported or route-drifted surface yields a bounded diagnostic and no
  mutation.
- Partial success is reported per exact target; a failed target does not cause
  a retry against another resource.
- A corrupted/modified plan or mismatched digest is rejected before the
  browser adapter receives any delete request.

## Design tree and unresolved frontier

### Q100 — production browser execution boundary

The repository presently has semantic surface selectors and a Codex-skill
browser contract, but no executable source-level adapter that can enumerate or
remove account resources. Should this workstream add a repository-owned local
semantic browser-driver companion/adapter so `c2c janitor` is truly a runnable
local command, rather than exposing only an agent-session integration?

Recommendation: **yes**. Keep the command's domain logic adapter-based and
test it with fakes, while the production adapter uses only the supported
authenticated semantic DOM surface. This is necessary to meet the requested
“one command can inventory” criterion without using private HTTP APIs.

### Q101 — plan review and explicit mutation authorization

Should plan review use a human-editable machine-local JSON document, with an
explicit `apply --plan-digest <digest>` command as the sole bulk-mutation
authorization (no per-resource prompt), or should `apply` require an
additional interactive confirmation after the digest?

Recommendation: **digest-bound command only**. The deliberate `apply` command
plus the exact immutable digest meets the requested one-operation bulk apply,
is scriptable for local maintenance, and avoids a weaker name/position-based
confirmation. The plan must still expose every `delete` action for review.

### Q102 — manual delete policy in the initial plan

May a human change an `unknown` entry to `delete` after review even when the
tool has no strong successor/orphan evidence, provided the entry retains its
exact stable ID and passes apply-time revalidation? Or should the tool refuse
all deletion unless it can independently classify the resource as safely
superseded?

Recommendation: **allow the exact human-reviewed change**. The task requires
explicit plan actions and says recommendations do not automatically authorize
deletion; requiring a recommendation would prevent the utility from cleaning
up genuinely obsolete resources that lack machine-readable lifecycle history.

### Q103 — machine-local plan retention

Should completed inventory snapshots and plans be retained indefinitely in the
local state directory for auditability, or should the utility keep only the
active plan plus the most recent post-apply result?

Recommendation: **retain a bounded history** (for example, the active plan
and a small fixed number of prior plans/results). This supports stale-plan and
idempotence diagnostics without accumulating a permanent private account
inventory.

## Assumptions and impact

- The active authenticated ChatGPT account is the only account in scope; the
  utility will not switch accounts or broaden a browser profile. This keeps
  account identity as a protection boundary.
- “Referenced by current C2C state” means exact machine-readable references
  from the established local state mechanism and current workspace bindings,
  not conversation memory or name similarity.
- A scan may require user login/2FA on the existing supported browser surface;
  this is a capability boundary, not a reason to use an alternate data source.
- The existing `c2c` CLI and local state helpers are the preferred isolation
  point unless Q100 changes the execution boundary.

## Approved decisions

On 2026-10-06, the user approved the recommendation for every requirements
decision:

- Q100: add the repository-owned local semantic browser-driver companion.
- Q101: authorize bulk mutation solely with an explicit frozen plan digest.
- Q102: permit a human to change an exact, revalidated `unknown` entry to
  `delete` in the machine-local plan.
- Q103: retain only a bounded local history of plans and results.

## Step 1 status

Requirements discovery is complete and approved. The canonical requirements
record is GitHub Issue #18. No source implementation, remote branch
publication, or live ChatGPT mutation has been performed.
