# Implementation log — chatgpt-surface-janitor

## Scope completed

- Added a machine-wide `c2c janitor` command with `scan`, `plan`, `dry-run`,
  `apply --plan-digest`, and `rescan`; legacy `-w` input is accepted and
  ignored.
- Added a versioned, strict janitor domain and owner-only local store for
  sanitized inventories, human-editable plans, canonical digests, leases, and
  bounded apply results.
- Added exact protection references from local connection bindings, including
  optional exact janitor resource IDs; label-only legacy references are never
  deletion authority.
- Added a repository-owned Playwright companion child process using
  line-delimited JSON over inherited stdio, a dedicated owner-only profile, a
  visible first-party page, semantic locator probing, exact Project link
  enumeration/removal, one-shot token registry, and bounded per-kind
  unsupported behavior.
- Added account binding, immutable-plan and exact metadata/drift checks, final
  protection re-read, per-target outcomes, final account revalidation, shared
  protection-finalization leases with heartbeat, atomic result writes, strict
  state parsing/retention, exact rescan correlation, Project deletion warning,
  protection-reference registry aggregation, an owner-only exact keep-list with
  uniquely verified legacy migration, and English/Chinese operator
  documentation.
- The semantic companion retains the complete `g-p-...` Project identity,
  derives no account authority from visible labels, requires the machine-bound
  exact account attribute, and re-observes exact Project identity and safe
  metadata immediately before deletion. Invalid plan digests are rejected by a
  pure preflight gate before a browser process is created. A visible login/2FA
  boundary now has a bounded human wait whose parent transport timeout covers
  the child wait, and partial per-kind capability results are recorded in
  inventory diagnostics. Project capability detection now distinguishes a
  verified empty Project collection from an unavailable Project surface. A
  timed-out destructive confirmation now terminates the child companion before
  recording failure or releasing the finalization lease; abort completion is
  confirmed by an observed child `exit`/`close` event, with hard-kill
  escalation after the grace period.

## Tests

The complete command/exit/result record is in
[`04-test-summary.md`](04-test-summary.md). Final regression status: 29 test
files and 313 tests passed (68 targeted janitor/workspace/consent/session tests);
TypeScript typecheck and diff checks passed. The
execution summary/output was also recorded through `c2c record` for the C2C
reviewer.

## C2C post-implementation review

Cycle 9 found and closed a timeout race in destructive confirmation. Cycle 10
then identified that a one-second fallback could release the finalization
lease before the companion had actually exited. The parent now escalates to a
hard kill and waits for observed child `exit`/`close` before rejecting the
pending confirmation, while the lease remains held. A delayed-termination
regression test covers the lifecycle ordering. Independent post-
implementation C2C review cycle 11 returned `PASS`; no commit, push, or PR
has been performed.

## Known limitations and disposition

The current ChatGPT surface may not expose machine-verifiable semantic routes
for every resource kind or a usable authenticated account menu. The companion
returns `CAPABILITY_UNAVAILABLE` (or `AUTH_REQUIRED` at the visible login
boundary) for those cases and never guesses selectors, uses private APIs, reads
browser storage, or mutates an external resource. The Project path is concrete
but still fails closed on selector/route drift. Pure domain, store, lease,
digest, drift, account-switch, rescan, token, per-target failure, and CLI
compatibility behavior is covered by fixtures and can be reviewed independently
of bounded live capability.

No commit, push, tag, pull request, or external deletion was performed.
