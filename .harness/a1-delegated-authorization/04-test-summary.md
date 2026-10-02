# A1 implementation validation summary

## Scope

Step 5 implementation of the approved `.harness/a1-delegated-authorization/02-plan.md`
within Q401–Q414. No commit, push, PR publication, or Human Gate action was
performed in this step.

## Commands and results

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | TypeScript strict check passed after the implementation changes. |
| `pnpm build` | 0 | Production TypeScript build passed. |
| `pnpm test tests/delegation.test.ts tests/delegation-cli.test.ts tests/delegation-schema.test.ts tests/transaction.test.ts tests/authorization.test.ts` | 0 | 32 targeted tests passed, including provider-free `workspace_read`, provider-bound operation reconciliation, duplicate-key rejection, keyed authoritative approvals, canonical revocation provenance, audit links, schema-shaped grants/proofs, sensitive-file rejection, reservation-before-revoke fail-closed behavior, canonical receipt-path rejection, CLI boundary smoke coverage, delegated event-first transaction wiring, A0 receipt transitions, and TeamAI provenance. |
| `pnpm test tests/delegation.test.ts tests/transaction.test.ts` | 0 | 9 focused A1/transaction tests passed after the coordinator, approval, and lease/reference changes. |
| `pnpm test` | 1 | 250 tests passed out of 257. Seven existing child-process cases in `tests/cli-workspace-flag.test.ts` and the valid case in `tests/record-cli.test.ts` failed before assertions because Node/tsx reported `uv_os_get_passwd returned ENOMEM`; this is the same host resource limitation recorded at the baseline, not an A1 product failure. |
| `git diff --check` | 0 | No whitespace errors. |

## A1 evidence covered

- Strict raw JSON parsing rejects nested and decoded-equivalent duplicate keys,
  malformed/truncated input, and distinguishes missing records from corrupt
  records before ordinary object construction.
- Durable owner-only grants, reservations, finite-use accounting, exact
  `notBefore <= now < expiresAt` expiry, injected clocks, explicit revocation/
  supersession, canonical Human-Gate approval and complete-contract digest
  binding, exact provider-account requirements, and typed allow/deny proofs.
- Closed action routing rejects caller-controlled `delegationRequired`,
  unknown/compound/write/Human-Gate actions, and target/provider fields outside
  the action schema.
- `workspace_read` is bounded and local, issues no A0 authority, and requires
  no TeamAI `github-cli-auth` result or resolver call. Current-v1
  `c2c_transport` is likewise provider-free and returns an evaluator-issued
  permit only after the delegated grant decision and exact A0 target match;
  excluded GitHub operation targets are rejected.
- `operation_reconcile` loads only a known persisted operation. Its
  policy-owned local/provider discriminator requires branded compatible TeamAI
  evidence only on the provider-bound path; local persisted evidence remains
  provider-free.
- A0 authorization/receipt records carry bounded delegation references;
  delegated delivery rejects missing, forged, or mismatched runtime permits.
  Existing A0 issuer, binding, receipt, visible-bubble, ambiguity, and
  no-blind-resend behavior remains covered by the original suites.
- Event leases now accept both legacy `at` and current `acquiredAt` shapes and
  never reclaim a live owner solely because a lock is old.
- Workspace read/search/status projections reuse the existing sensitive-file,
  custom-ignore, symlink, and filtered git-status boundaries. Reconciliation
  derives a local path only from persisted A0 operation evidence; otherwise it
  fails closed to the provider-bound contract.
- A delegated A0 authority is rehydrated with its original grant-generation /
  reservation / decision digest after the receipt file is absent, while two
  new identical bounded reads receive distinct runtime decision identities and
  consume two uses.
- Grant-specific canonical approval records are required in the state fixture;
  generic Step 4 plan approval, missing provider accounts, and forged target
  widening fail closed.
- The proof-only CLI path classifies the policy-owned reconciliation path
  before any TeamAI import; explicit `delegation read` and `delegation
  reconcile` commands now execute only their named class. Local reads reject
  provider options, while provider-bound reconciliation resolves the trusted
  provider only after the persisted operation requires it.
- Reservation commit readiness, recovery, and consumption all recheck grant
  generation/status under the grant lease. A revoke-before-A0 attempt is
  covered by deterministic tests and emits a durable typed DENY audit entry.

## Known limitation

The seven host-limited CLI subprocess failures must remain explicitly
separated from product regressions in the post-implementation review. No
source workaround or unrelated CLI behavior change is authorized by A1.

## Review handoff

The exact isolated A1 C2C connector/project/chat is requested to independently
read the live Issue #8, the approved plan, this summary, current git state,
the changed source, and the relevant tests. Source bodies, diffs, and logs are
not copied into the control message.

## Iteration-2 remediation validation

- `pnpm typecheck` and `pnpm build` both exited 0 after the multi-record
  approval parser, audit correlation, CLI, schema, and test additions.
- `pnpm test tests/delegation.test.ts tests/delegation-schema.test.ts
  tests/transaction.test.ts tests/authorization.test.ts` exited 0 with 24
  passing tests.
- `pnpm test` exited 1 with 242/249 tests passing. The only seven failures
  remain the known host `uv_os_get_passwd returned ENOMEM` child-process cases
  in `cli-workspace-flag.test.ts` and `record-cli.test.ts`; no A1 test failed.
- `git diff --check` exited 0.

## Iteration-6 remediation validation

- Delegation CLI commands now derive the active binding root from the explicit
  `--workspace` option or the process's current directory. A caller-controlled
  binding file or request scope can no longer select another checkout for
  canonical re-derivation; the candidate is checked against that independently
  selected runtime workspace.
- The CLI boundary regression covers the required workspace option and rejects
  the former candidate/scope-root fallback at the source boundary.
- The targeted delegation/CLI/schema/transaction/authorization suite passes
  31 tests after this remediation. The full suite passes 249/256; the same
  seven child-process cases remain limited by host
  `uv_os_get_passwd returned ENOMEM`, with no A1 assertion failure.

## Iteration-7 remediation validation

- Grant revocation now has a distinct canonical decision/provenance boundary.
  The durable record binds the grant ID, checkpoint, decision ID, digest,
  timestamp, approver, and bounded reason; duplicate, missing, mismatched, or
  non-canonical records fail closed.
- The `delegation grant-revoke` CLI requires strict revocation-decision input
  and verifies it before the grant lease mutation. The in-process lifecycle
  seam remains available for trusted recovery/tests, while the CLI cannot
  revoke from a standalone `--reason` or prose-only request.
- The targeted delegation/CLI/schema/transaction/authorization suite passes
  32 tests. The full suite passes 250/257; the same seven host
  `uv_os_get_passwd returned ENOMEM` child-process failures remain, with no A1
  assertion failure. `git diff --check` remains clean.

## Iteration-8 remediation validation

- A1's common active-binding check now requires the same runtime-only
  canonical-binding brand enforced by A0, in addition to the full identity and
  scope comparisons. A structurally identical JSON/plain object cannot satisfy
  an A1 ALLOW decision.
- Regression coverage serializes an exact active binding (which removes the
  runtime brand) and verifies fail-closed `TARGET_DENIED`; derived bindings
  continue to allow the bounded action.
- The targeted delegation/CLI/schema/transaction/authorization suite passes
  32 tests. The full suite passes 250/257; the same seven host
  `uv_os_get_passwd returned ENOMEM` child-process failures remain, with no A1
  assertion failure. Typecheck, build, and diff-check pass.

## Iteration-3 remediation validation

- The Step 5 iteration-3 fixes compile and build cleanly. The targeted suite
  now passes 26 tests, including duplicate approval identity/timestamp
  rejection and revoke-before-commit recovery/consume denial.
- The full suite now reports 244/251 passing; the same seven host
  `uv_os_get_passwd returned ENOMEM` child-process failures remain isolated
  from A1 assertions.
- The CLI proof path is strictly duplicate-aware for request, binding, and
  provider-observation JSON. `delegation read` and `delegation reconcile`
  expose class-specific execution while retaining proof-only `evaluate`.

## Iteration-4 remediation validation

- Audit appends now use a per-grant audit lease with grant-to-audit ordering,
  preventing lost lifecycle updates while retaining atomic replacement and
  append-only history.
- `readDeliveryReceiptForOperation` now requires the event-key-derived
  canonical receipt path and reloads the canonical receipt before accepting
  local persisted evidence. Misplaced receipt-shaped files are ignored.
- The targeted suite passes 29 tests, including canonical receipt-path,
  independent audit append, and CLI boundary smoke checks. The full suite is
  247/254 with the same seven host ENOMEM child-process limitations.

## Iteration-5 remediation validation

- A1 evaluation now requires a non-optional active canonical binding and
  compares every present scope identity dimension, including workspace roots,
  branch, checkpoint, task/event, Project/chat, connector/app/version,
  installation, and endpoint identity. Missing, cross-worktree, branch-
  mismatched, and scoped-identity-mismatched bindings fail closed.
- CLI `delegation read`, `delegation reconcile`, and proof-only `evaluate` now
  require a binding candidate and re-derive the active canonical binding from
  the current workspace and harness state before evaluation; caller JSON is
  never treated as binding authority.
- `pnpm typecheck` and `pnpm build` both exited 0.
- The targeted delegation/CLI/schema/transaction/authorization suite passes
  31 tests. The full suite is 249/256: the same seven host
  `uv_os_get_passwd returned ENOMEM` child-process failures remain in
  `cli-workspace-flag.test.ts` and `record-cli.test.ts`; no A1 assertion failed.
- `git diff --check` exited 0.

## Iteration-9 terminal C2C validation

- The exact isolated A1 reviewer at `c2c_a1_step5` returned terminal `PASS`
  after independently rechecking the approved plan, Issue #8, current source,
  tests, workspace identity, and the iteration-8 remediation.
- No remaining findings were identified. The reviewer confirmed that A1 now
  requires the shared runtime-only canonical-binding brand, so an exact
  JSON/plain structural lookalike is denied while a freshly derived binding
  succeeds. The runtime-root CLI selection, canonical revocation provenance,
  provider-free local/transport paths, action-specific reconciliation routing,
  A0/CAS/crash/audit/receipt/schema boundaries, and external-write exclusions
  remain intact.
- `pnpm typecheck`, `pnpm build`, the targeted delegation/CLI/schema/
  transaction/authorization suite (32 tests), and `git diff --check` pass.
  The full suite remains 250/257 with only the seven known host
  `uv_os_get_passwd returned ENOMEM` subprocess limitations; no A1 assertion
  failed.
- Step 5 is complete. No commit, push, PR creation/publication, merge, or
  other external write was performed. The canonical next step is the Step 6
  Push/PR publication Human Gate.
