# A1 implementation log

## Implementation summary

Implemented the approved delegated authorization layer beside A0. The change
adds strict JSON and owner-checked lease helpers, versioned policy/action
contracts, durable grant/reservation/audit records, typed decision proofs,
action-specific provider evaluation, known-operation reconciliation, and the
transaction/delivery/A0 reference seams. Workspace reads and current-v1 C2C
transport remain independent of GitHub authentication; provider evidence is
required only for an explicitly provider-bound known operation.

## Validation

See `04-test-summary.md`. Typecheck and targeted A1/A0 tests passed. The full
suite has 242 passing tests out of 249 and the same seven host `uv_os_get_passwd: ENOMEM`
child-process limitations documented at baseline.

## C2C findings and disposition

### `c2c_a1_step5`, iteration 0 — `FIX_REQUIRED`

The bound A1 reviewer identified nine implementation findings. All were
accepted or modified within the approved Q401–Q414 scope; no new requirement,
Human Gate, external write, or scope expansion was introduced:

1. **Critical — authoritative approval:** grant creation and rehydration now
   require an existing canonical `.harness/**/state.yaml` with recorded Step 4
   approval, and the approval digest covers the complete immutable action,
   normalized target, provider contract, lifetime, and use budget.
2. **Critical — A0 target binding:** delegated transport target fields are
   compared exactly with the canonical A0 event; operation targets are rejected
   from current-v1 delegated transport.
3. **Critical — excluded operation target:** only explicit non-delegated A0
   compatibility traffic may carry a GitHub operation target.
4. **Critical — workspace boundary:** bounded reads/search/status now route
   through `Workspace`/`IgnoreRules` semantics, including sensitive-file and
   symlink protection.
5. **High — retry identity:** caller-supplied `decisionInstanceId` is rejected;
   runtime identities are minted internally and only an unfinished durable
   reservation is rehydrated.
6. **High — atomic coordinator:** delegated transport now owns the event lease,
   reserves the grant under the event→grant order, calls the owned A0
   issue/reuse and receipt seams, and recovers an exact persisted authority.
   Revocation, supersession, reservation release, and consumption share the
   grant lease/CAS boundary.
7. **High — reconciliation evidence:** operation reconciliation derives a
   provider-bound path unless an authoritative A0 receipt contains bounded
   persisted operation evidence; local results use that evidence and do not
   resolve TeamAI.
8. **Medium — schemas:** grant/proof schemas now enumerate the serialized
   common, target, and conditional provider fields.
9. **High — tests/evidence:** deterministic tests now cover authoritative
   approval, target binding/exclusion, sensitive reads, retry identity,
   delegated transaction coordination, provider-free routes, and the existing
   A0 suites. The connector still exposes no independent Step 5 execution
   record output; the host's seven `uv_os_get_passwd returned ENOMEM` CLI
   failures remain a documented environment limitation.

The implementation log is being updated before the same-checkpoint C2C
re-review. No source change outside the approved plan was made.

### `c2c_a1_step5`, iteration 1 — `FIX_REQUIRED`

The reviewer found ten remaining issues. They remain within Q401–Q414 and were
remediated without changing the approved action vocabulary or Human Gate
boundaries:

1. Canonical approval now requires a grant-specific `delegation_approval`
   record in the canonical state, matching decision ID, complete contract
   digest, action, scope digest, target digest, timestamp, and approver; a
   generic Step 4 plan approval cannot mint an arbitrary grant.
2. Recovery preserves the exact persisted A0 delegation reference after grant
   consumption instead of rewriting it with the current grant generation.
3. Test fixtures now use the actual A1 workstream state path and durable
   grant-specific approval record.
4. Provider-bound grants require a non-empty exact expected account; the grant
   schema and evaluator enforce it.
5. A1 reconciliation now loads strict, validated receipt records, binds them
   to the persisted authorization/authority, target, payload, and unique
   operation key, and only then accepts persisted operation evidence.
6. Non-transport reservations are never implicitly shared by matching new
   requests; a separate trusted recovery seam is required for an unfinished
   reservation.
7. Audit history is no longer automatically truncated; retention remains
   durable through terminal workflow state.
8. Supersession now resolves and validates the durable replacement grant before
   changing the old grant.
9. The proof schema includes the complete provider projection, including
   correlation and optional auth-attempt identifiers.
10. Tests now cover post-consumption A0/receipt recovery, separate identical
    read decision identities/use counts, exact provider-account requirements,
    persisted evidence-path derivation, and the delegated event-first path.

The connector limitation remains unchanged: no independent Step 5 execution
records or live Issue retrieval are available. The next C2C review must verify
the current source and these updated artifacts before any terminal decision.

### `c2c_a1_step5`, iteration 2 — `FIX_REQUIRED`

The reviewer confirmed that the iteration-1 source defects are materially
fixed, then identified five remaining plan-conformity gaps. Remediation stays
within Q401–Q414; no external write or new action vocabulary was introduced:

1. Canonical grant approval parsing now supports an append-only
   `delegation_approvals` sequence as well as the legacy singular fixture, so
   independently valid grants do not overwrite one another. The real A1 state
   records an explicit empty sequence because no concrete grant has been
   approved for this workstream; grant creation remains fail-closed until a
   grant-specific Human-Gate decision is recorded, rather than fabricating one.
2. Audit entries now retain grant generation, approval decision/digest,
   scope/target and binding links, reservation/use transition, stable audit
   references, A0 authority/receipt references, reconciliation references, and
   revoke/supersession evidence. The audit stream remains append-only with no
   silent truncation, and delegated A0 references carry the stable audit link.
3. The approved read-only/controlled CLI surface is now present under
   `delegation`: strict duplicate-aware grant creation input, sanitized
   inspection, explicit revoke/supersede, and proof-only evaluation. Provider
   observations are resolved only through the trusted TeamAI provider boundary;
   structural provider results and structural grants are rejected.
4. The grant schema now requires the runtime target and target digest. Tests
   validate generated grants and local/provider proof projections against the
   published schema shape.
5. Tests now cover keyed approvals, audit links, explicit reservation recovery,
   distinct new reservations, revoke fail-closed behavior, and schema
   validation in addition to the existing transport/receipt recovery matrix.

The reviewer still requires a genuine grant-specific Human Gate only if a
concrete grant is intended; no such grant is being fabricated during Step 5.
The next same-checkpoint review must verify these remediations and decide
whether the empty no-grant canonical state is sufficient for terminal PASS.

### `c2c_a1_step5`, iteration 3 — `FIX_REQUIRED` remediation

The reviewer identified five remaining boundary and evidence gaps. All fixes
remain inside the approved Q401–Q414 implementation scope; the canonical
state continues to record `delegation_approvals: []`, so no grant-specific
Human Gate or approval was fabricated:

1. Approval matching now requires one exact grant-specific record, rejects
   duplicate decision IDs, and compares the grant's own timestamp and
   approver identity rather than the generic Step 4 approval timestamp.
2. The event-first transport coordinator now holds the grant lease across
   final reservation revalidation and A0 authority persistence. New
   reservations and non-recovery consumption recheck generation, status,
   and expiry; exact persisted-A0 recovery retains its existing authority
   reference.
3. The CLI keeps `delegation evaluate` proof-only and adds explicit
   class-specific `delegation read` and `delegation reconcile` commands.
   Policy-derived operation evidence is inspected before any TeamAI provider
   import; provider options are rejected for local reads and current-v1
   transport, and trusted branded evidence is resolved only for a
   provider-bound reconciliation path. Provider observations now cross the
   strict duplicate-aware JSON boundary as well.
4. Known-grant denials append sanitized durable `DENY` audit entries while
   preserving the append-only lifecycle links.
5. Deterministic tests cover revoke-before-commit reservation recovery and
   consumption failure, durable DENY audit evidence, duplicate approval
   identities, and grant-specific timestamp mismatch. The targeted suite
   passes 26 tests; the full suite passes 244/251 with the seven known host
   `uv_os_get_passwd returned ENOMEM` child-process failures.

The implementation is ready for the next same-checkpoint C2C review. No
source behavior outside the approved action vocabulary, A0 compatibility,
Human Gate boundaries, or external-write exclusions changed.

### `c2c_a1_step5`, iteration 4 — `FIX_REQUIRED` remediation

The reviewer accepted all iteration-3 source fixes and identified two
remaining integrity defects plus their coverage gap. The fixes stay within
Q401–Q414 and do not create a grant or a new Human Gate:

1. Audit writes now serialize through a per-grant owner-checked audit lease.
   Existing grant-held paths use grant → audit ordering, while denial and
   post-consumption correlation writes use the audit lease alone; the
   append-only atomic replacement therefore cannot silently lose a concurrent
   lifecycle entry.
2. `readDeliveryReceiptForOperation` now requires the event-key-derived
   canonical receipt path and reloads the canonical receipt through the normal
   loader before joining it to the A0 authorization, operation target, and
   payload chain. A misplaced or duplicate receipt-shaped file cannot
   manufacture local persisted evidence.
3. Regression coverage now includes canonical/misplaced receipt handling,
   independent audit appends, and a CLI boundary smoke check for proof-only
   evaluation, explicit read/reconcile commands, strict structural-input
   rejection, and provider deferral. The targeted suite passes 29 tests; the
   full suite passes 247/254 with only the seven known host
   `uv_os_get_passwd returned ENOMEM` child-process failures.

The next same-checkpoint C2C review should verify the audit lease ordering,
canonical receipt rehydration, and the updated validation evidence. No
external write or implementation-scope expansion was made.

### `c2c_a1_step5`, iteration 5 — `FIX_REQUIRED` remediation

The reviewer found that delegated evaluation could still proceed without a
fresh canonical binding, and that CLI binding JSON was optional and treated as
authority. The remediation remains within Q401–Q414 and preserves the approved
action vocabulary, A0 seams, provider-free local/transport routes, and external
write exclusions:

1. `assertActiveBinding` now requires a binding, checks all required identity
   fields, and compares every scope dimension that is present, including
   workspace roots, branch, checkpoint, task/event, Project/chat,
   connector/app/version, installation, and endpoint identity. Missing,
   cross-worktree, branch-mismatched, or scoped-identity-mismatched input fails
   closed before grant continuation.
2. The CLI parser now requires `--binding-file` for `delegation read`,
   `delegation reconcile`, and proof-only `delegation evaluate`. It uses the
   file only as a candidate, then calls `deriveActiveCanonicalBinding` against
   the current workspace root/ID and harness-owned state before evaluation.
3. Regression coverage now includes missing active binding, another worktree,
   branch mismatch, checkpoint/project mismatch, and CLI required-binding/
   re-derivation smoke checks. The targeted suite passes 30 tests; the full
   suite passes 248/255 with only the seven known host
   `uv_os_get_passwd returned ENOMEM` child-process failures.

`pnpm typecheck`, `pnpm build`, and `git diff --check` pass. The next action is
the same-checkpoint C2C re-review; no external write or scope expansion was
made.

### `c2c_a1_step5`, iteration 6 — `FIX_REQUIRED` remediation

The reviewer confirmed the common fresh-binding seam but found that the CLI
still let caller-controlled binding JSON or request scope choose the root used
for canonical re-derivation. The remediation is limited to the approved CLI
trust boundary:

1. `delegation read`, `delegation reconcile`, and proof-only `delegation
   evaluate` now accept the normal `--workspace` selection, defaulting to the
   process current directory. They pass that independently resolved root to
   `deriveActiveCanonicalBinding`.
2. The binding file remains a candidate only. The parser no longer falls back
   to `candidate.workspaceRoot` or `scope.workspaceRoot`, so a process in
   worktree B cannot point evaluation back at approved worktree A.
3. The CLI boundary regression asserts the runtime-root call shape and the
   absence of the former caller-root fallback. The main test summary's
   targeted count is reconciled to the latest 31-test result; the full suite
   is 249/256 with the same seven host ENOMEM child-process failures.

The next action is the same-checkpoint C2C re-review. No external write,
grant fabrication, Human Gate expansion, or implementation-scope expansion
was made.

### `c2c_a1_step5`, iteration 7 — `FIX_REQUIRED` remediation

The reviewer closed the runtime-root issue and identified one remaining
plan-conformity bypass: `delegation grant-revoke` could mutate a durable grant
from only a grant ID and local reason, without an authoritative canonical
revocation decision. The remediation stays within the approved grant lifecycle
and does not create a grant or Human Gate:

1. A bounded `DelegationRevocationProvenance` contract and digest now bind the
   target grant ID, checkpoint, decision ID, timestamp, approver, and optional
   bounded reason to one exact `delegation_revocations` record in canonical
   state. Missing, duplicate, wrong-workstream, mismatched, or malformed
   records fail closed.
2. The CLI `delegation grant-revoke` command now requires strict `--input`
   provenance, verifies it before entering the grant lease, and passes the
   same verified decision through the mutation/audit path. The internal
   trusted lifecycle seam remains compatible with existing recovery tests.
3. Regression coverage verifies that a missing canonical revocation decision
   is denied and that the exact record permits one revocation; CLI boundary
   coverage requires the strict input and verification call.

The targeted suite passes 32 tests and the full suite passes 250/257 with only
the seven known host `uv_os_get_passwd returned ENOMEM` child-process failures.
Typecheck, build, and diff-check pass. The next action is the same-checkpoint
C2C re-review; no external write or scope expansion was made.

### `c2c_a1_step5`, iteration 8 — `FIX_REQUIRED` remediation

The reviewer closed the canonical runtime-root issue and found that A1 still
accepted a structural binding object whose ordinary fields matched the grant,
even though A0 already protects its canonical binding with a runtime-only
brand. The remediation is a shared trust-boundary fix:

1. The A0 `assertActiveCanonicalBinding` check is now exported as the shared
   brand verifier, and A1's `assertActiveBinding` invokes it before comparing
   any grant scope dimensions.
2. A1 therefore requires both a freshly derived canonical object and all
   existing worktree/branch/checkpoint/task/event/Project/chat/connector/app/
   version/installation/endpoint predicates; JSON/plain lookalikes fail closed.
3. Regression coverage verifies that serializing an exact derived binding
   removes the runtime brand and produces `TARGET_DENIED`, while the derived
   binding still permits the bounded workspace read.

The targeted suite passes 32 tests and the full suite passes 250/257 with only
the seven known host `uv_os_get_passwd returned ENOMEM` child-process failures.
Typecheck, build, and diff-check pass. The next action is the same-checkpoint
C2C re-review; no external write or scope expansion was made.

### `c2c_a1_step5`, iteration 9 — terminal `PASS`

The exact isolated A1 reviewer independently rechecked Issue #8, the approved
plan, current workspace identity and git state, the implementation, tests, and
the iteration-8 remediation. It found no remaining findings.

The reviewer confirmed that the shared runtime-only canonical-binding brand is
now enforced before A1 scope comparison: a structurally identical serialized
binding is denied, while a freshly derived canonical binding succeeds. It also
confirmed preservation of the runtime-root CLI boundary, canonical revocation
provenance, provider-free `workspace_read`/current-v1 `c2c_transport`,
action-specific `operation_reconcile` routing, A0 binding/security checks,
reservation/expiry/revocation/CAS and crash recovery, authoritative receipts,
serialized audit history, strict schemas, supersession, and all approved
external-write exclusions.

`pnpm typecheck`, `pnpm build`, the targeted delegation/CLI/schema/
transaction/authorization suite (32 tests), and `git diff --check` pass. The
full suite remains 250/257 with only the seven known host
`uv_os_get_passwd returned ENOMEM` subprocess limitations. No A1 test failed.

Disposition: terminal `PASS`; Step 5 is complete. The worktree remains
unpublished and uncommitted. The canonical next action is the Step 6 Push/PR
publication Human Gate; no push, PR creation/publication, or merge is
authorized before explicit human approval.
