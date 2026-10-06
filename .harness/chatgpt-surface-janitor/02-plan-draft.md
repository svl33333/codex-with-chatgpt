# Implementation plan draft — chatgpt-surface-janitor

This is a revised pre-implementation draft for the mandatory independent C2C
review. It does not authorize implementation or a ChatGPT mutation.

## Safety model and scope

`c2c janitor` is a machine-wide maintenance command. It inventories and builds
protection evidence from every valid local C2C binding/reference record on the
machine, rather than only the workspace supplied through `-w`. In accordance
with the established machine-wide CLI contract, it accepts and ignores a
leftover `-w <anything>` and explicitly reports its machine-wide scope; this
preserves existing Skill/session compatibility without weakening protection.

The command supports four discriminated resource kinds: `project`, `plugin`,
`custom_mcp`, and `connector`. Every observed resource has a stable
ChatGPT-side resource ID, kind, allowlisted safe metadata, and a per-kind
surface capability outcome. An absent, conflicting, label-only, ordinal,
prefix, wildcard, or otherwise ambiguous identity is never eligible for
removal.

Protection is fail-closed and takes precedence throughout planning and apply.
The design will define a versioned exact-protection-evidence mapping for each
kind. Existing project bindings may contribute their stored exact project ID.
For connector, plugin, custom-MCP, reviewer, and app references, the local
binding state will gain either an observed stable resource ID or an
exact-resource-reference registry entry. Name-only legacy records remain
legacy and are never promoted to exact protection. A documented composite
correlation (for example, endpoint fingerprint plus installation/workspace
identity) may locate a candidate only in order to observe and bind its stable
resource ID; it may not select a target by itself. An explicit local keep list
also supplies exact IDs only. The protection format is versioned, migrates old
records without weakening protection, and preserves readable old state.

## Plan authorization and local records

Janitor records use allowlisted, janitor-specific DTOs under the existing
owner-only user-local C2C state directory. They do not reuse permissive
advisory JSON helpers for an authorization artifact. The strict store has:

- explicit missing-versus-malformed errors;
- schema-versioned inventory, plan, result, history, and protection records;
- atomic temp-file plus rename writes, owner-only permissions, and bounded
  retention/rotation; and
- an allowlist that persists stable IDs and safe display metadata only. It
  excludes private Project URLs, tokens, cookies, browser storage, chat body,
  screenshots, and raw page content.

`scan` writes one sanitized inventory snapshot with a unique inventory ID and
the existing runtime-owned `ConnectionBinding.accountFingerprint`. The
companion supplies only current, non-secret authenticated-surface evidence to
the existing machine-verified account-binding verifier; it must match the
runtime binding before scan can use it. It never invents a fingerprint from a
display label, and raw account data never leaves that surface. Inventory DTOs retain safe protection/reference status,
classification, and reason. `plan` carries the inventory's account fingerprint
and creates a strict, versioned plan: exactly protected or exact keep-list
entries are `keep`; only non-protected entries default to `unknown`. A human
may edit an eligible exact `unknown` entry to `delete`, but can never override
a current `keep`. Unknown fields, duplicate entry IDs, unknown kinds, missing
required fields, mismatched inventory/account IDs, and malformed JSON are
rejected before a driver is touched.

The authorization digest is deterministic and has one defined domain: the
canonical serialization of the validated plan authorization payload
(`schemaVersion`, `inventoryId`, account fingerprint, exact entries and their
requested actions).
The payload excludes derived `digest`, outcome, history, timestamp, and
retention fields so it cannot be self-referential. Canonicalization has a
specified key order, UTF-8 encoding, and whitespace-independent behavior.
`dry-run` re-reads and strictly validates the human-edited plan, recomputes
the digest, checks its inventory/protection preconditions, prints the current
digest, exact proposed delete IDs/names, and keep/unknown/protected/stale/
ambiguous totals, and makes no surface call. `apply --plan-digest <digest>`
re-reads, validates, canonicalizes, recomputes, and compares that digest
before any driver method can run. It also re-observes the authenticated account
through the companion and requires an exact account-fingerprint match; a
missing, stale, or changed account fails closed. An edit after dry-run,
inventory drift, or digest mismatch therefore fails closed.

## Domain, concurrency, and deletion contract

Pure domain code owns normalization, exact protection evaluation, strict
schemas, digest computation, result classification, and retention. Tests use
synthetic drivers for this layer.

The driver contract models an identity-bound final operation instead of a
separate loose re-observe/remove pair:

1. `prepareExactTarget` resolves one stable-ID/kind target and its final
   semantic destructive control before any mutation. It returns an unguessable,
   short-lived, one-shot prepared token bound to the companion session, exact
   ID, kind, safe metadata, and the expected authenticated-account fingerprint;
   the token is never serialized to history.
2. The domain acquires a machine-local finalization lease, then re-reads the
   machine-wide protection index and compares the plan's expected
   identity/metadata with the prepared result. All connection, provisioning,
   app-selection, and exact-reference writers must use the same
   protection-state writer lease, so a new protected reference cannot appear
   after this re-read and before the final click.
3. While that finalization lease is held, `confirmPreparedRemoval` freshly
   re-observes the authenticated account at the final semantic control, requires
   an exact match with the token/plan fingerprint, then consumes only that
   prepared token and reasserts stable ID, kind, and expected safe metadata.
   Missing, stale, logged-out, or mismatched account authority invalidates the
   token and skips fail-closed. It reports absent, changed, ambiguous, newly
   protected, unsupported, or route-drift outcomes without guessing.

`apply` acquires a cross-process atomic janitor lease before reading the plan;
the lease has an owner nonce, bounded heartbeat/expiry, verified-owner release,
and safe stale/crash recovery. A concurrent invocation is rejected without a
browser operation, and result/history writes are atomic. The per-target
finalization lease is distinct from the overall apply lease and is held only
from the final protection read through token consumption/click. This closes
local protection-state and concurrent-apply TOCTOU windows. A target that
disappears is idempotently recorded as absent; one that becomes protected,
changes identity/metadata, replays/expires/crosses a companion session, or
loses a supported route is skipped fail-closed. `rescan` correlates every
frozen-plan target with removed, skipped, remaining, protected, or unknown
status and is explicitly repeat-safe.

## Browser companion and surface capability boundary

The first implementation task is a read-only feasibility probe, before any
janitor domain work. The repository cannot rely on the ChatGPT desktop
built-in browser: current product research records that it is not available to
Codex CLI. The selected production path is therefore a repository-owned local
Node companion launched as a child process by `c2c janitor`, with line-delimited
JSON request/response over inherited stdio. It uses a declared `playwright`
dependency and its bundled Chromium in a dedicated owner-only janitor profile
directory under C2C state; it never attaches to or reads a user's Chrome,
ChatGPT-desktop, or browser profile.

The companion opens a visible first-party ChatGPT page only as necessary for a
human to complete login or supported 2FA. Those are human boundaries: the
companion returns `AUTH_REQUIRED` and never attempts credentials, recovery, or
2FA. Once authenticated, it uses Playwright locators and semantic DOM controls
only; it neither reads nor exports cookies, browser storage, tokens, private
HTTP endpoints, screenshots, or chat content. The probe verifies the declared
browser binary, launch/stdio handshake, first-party origin, current
machine-verifiable account evidence compatible with
`ConnectionBinding.accountFingerprint`, and read-only per-kind enumeration
capability. It returns
`CAPABILITY_UNAVAILABLE` with bounded diagnostics if any of those conditions
cannot be established. That result is a valid terminal unsupported-surface
outcome, not permission to substitute a private API or a non-runnable adapter.

The companion exposes only capability discovery, authenticated account
observation, enumeration, prepare by exact stable ID/kind, and confirmation of
kind-specific removal through semantic controls. It maintains its prepared
token registry in memory for one companion session; tokens are random,
one-shot, session-bound, short-lived, and internally bound to exact ID/kind/
metadata and the expected account fingerprint. Before consuming a token, the
companion re-observes the authenticated account through the same semantic
surface and invalidates the token on logout, expiry, or mismatch. The
companion's stdio protocol accepts no raw URLs, profile paths, or page content
from a plan. The `playwright` package and browser-binary
delivery/install implications will be explicitly declared in `package.json`,
lockfiles, CLI preflight, and documentation before source changes are made.

Janitor gets its own capability matrix (enumeration and kind-specific removal
per resource kind), while reusing the existing bounded diagnostic/status
vocabulary and route-drift discipline. Creation/selection capabilities in
`src/provisioning/chatgpt-surface.ts` remain separate. An unavailable or
changed UI route yields a bounded unsupported diagnostic and never a guessed
control or fallback private API call.

## CLI, documentation, and implementation order

After the safety foundation exists, add `scan`, `plan`, `dry-run`, `apply
--plan-digest`, and `rescan` under the existing `c2c` CLI without changing
current command semantics. CLI help and a short janitor guide will show the
routine:

`scan → inspect/edit exact plan → dry-run and record digest → apply with that digest → rescan`.

They will state exact pre-apply warnings, the local result/retention location,
machine-wide scope (including accepted-and-ignored `-w`), browser preflight and
login/2FA human boundaries, and unsupported-surface outcomes. They will state
that successful external ChatGPT deletions are not automatically reversible:
rollback is preventive fail-closed validation plus audit/result records;
ordinary code changes can still be reverted normally.

Implementation order is fixed:

1. Add the explicit companion protocol/preflight contract and its minimal
   read-only feasibility probe. Stop with bounded `CAPABILITY_UNAVAILABLE` if
   the selected path cannot be established.
2. Define machine-wide scope, strict schemas/digest/account lifecycle, exact
   protection evidence, shared writer/finalization leases, and migration.
3. Implement pure domain/store/protection logic and fake-driver tests.
4. Implement the identity-bound driver contract, one-shot token semantics,
   cross-process leases, and atomic results.
5. Implement the concrete authenticated browser companion and janitor-specific
   capability matrix.
6. Wire the CLI, documentation/warnings, compatibility behavior, and tests.
7. Run typecheck/Vitest; only if the production capability is actually
   available, run one live read-only `scan → plan → dry-run` with no `delete`
   edits.

## Tests and validation

- Companion/preflight: stdio protocol and browser-launch failures, first-party
  origin verification, missing authentication, login/2FA boundary, declared
  dependency/binary preflight, bounded capability-unavailable output, and a
  minimal read-only enumeration feasibility test.
- Strict schema and digest: malformed/truncated plans, unknown fields,
  duplicate IDs, canonical key/whitespace stability, inventory/account
  mismatch, account switch after scan, edit-after-dry-run, digest mismatch,
  required `keep` derivation, required inventory reason/status fields, and no
  driver access on rejection.
- Protection/migration: per-kind exact protection, legacy label-only records
  that remain non-exact, composite correlation followed by stable-ID binding,
  multi-workspace machine-wide protection, old state readability, and
  compatibility with the machine-wide `-w` policy.
- Store: atomic writes, corrupt records, retention trimming, owner-only
  permissions, and exclusion of private URLs, tokens, cookies, and content.
- Driver/apply: exact-ID preparation, kind/metadata reassertion at final
  confirmation, token replay/expiry/wrong-session rejection, account
  switch/logout between preparation and final confirmation, unsupported/
  route-drift diagnostics, a target newly protected at the finalization
  boundary, writer exclusion while finalization is held, two simultaneous
  applies, stale/crashed/non-owner lease handling, altered targets,
  already-absent idempotency, partial outcomes, and atomic history.
- Surface: per-kind enumeration/removal capabilities, no name-only selection,
  and bounded diagnostics when a semantic route is unavailable.
- Regression: existing CLI workspace-flag and Skill-contract behavior,
  including accepted-and-ignored `-w` reporting, plus relevant
  TypeScript/Vitest suites. Dry-run reports exact deletes and all required
  totals; rescan reports every frozen target and has a repeat-safety test. Live
  validation remains read-only and is skipped when the supported companion
  cannot be established.

## Explicit exclusions

No runtime/package version change except a necessary declared browser-companion
dependency, no release/tag action, TeamAI pin/adoption, or modification to
`custom-runtime-release` or `custom-runtime-tag-publication` is planned. The
plan does not use private ChatGPT APIs or state, derive obsolescence from chat
contents, or authorize resource mutation before a final C2C `PASS` verdict.

## Review focus

The C2C reviewer must independently validate the selected companion process,
stdio transport, dedicated-profile attachment, dependency/preflight, and human
auth boundary; verify that exact protection and account authority cannot be
inferred from labels; and confirm that finalization re-observes the token-bound
account at the destructive semantic control, while finalization leases, one-shot tokens,
digest/account binding, scope/compatibility, output semantics, migration, and
tests match Issue #18. Implementation remains prohibited until that review
gets a `PASS` verdict.
