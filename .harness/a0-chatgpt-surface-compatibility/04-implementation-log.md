# A0 implementation log

## Approved scope

Step 4 direct approval was recorded for `02-plan.md` at the existing
`a0-surface-plan` checkpoint. This implementation is limited to the approved
ChatGPT-surface compatibility work: semantic surface routing, deterministic
Project display-name compatibility, identity-preserving connector evidence,
read-only verification, canonical OAuth resource binding, fail-closed scope
handling, and current-message app-selection evidence.

## Implemented

- Added a 50-character Project display-name validator and deterministic
  normalization. The approved A0 label is normalized to
  `codex-with-chatgpt-a0-surface-compatibility`; durable workstream identity
  remains separate.
- Added semantic ChatGPT surface selection and explicit outcomes for reuse,
  creation, recovery, recoverable failure, human boundary, and unavailable
  capability.
- Extended connector binding and reconciliation with account, Project,
  selected-surface, and read-only verification evidence while retaining
  schema-1 compatibility.
- Extended provisioning state with bounded surface/outcome/readiness fields
  and schema-1 migration behavior.
- Added secure runtime-only, message-key-bound app-selection records; message
  bodies and private app identifiers are not persisted by this feature.
- Canonicalized OAuth discovery/resource handling to the active bridge base,
  rejected mismatched resources, and made explicit unsupported scopes fail
  closed.
- Hardened local Host fallback to loopback when no configured public base is
  present; the bridge no longer derives OAuth metadata from arbitrary Host
  input.
- Documented the semantic surface policy, Project-label/identity boundary,
  OAuth audience contract, and the current product compatibility constraint.

## Historical validation before C2C remediation

See [04-test-summary.md](04-test-summary.md). This section records the
pre-remediation iteration only: the focused suite passed 55 tests and the full
suite passed 226 tests. Direct compiler diagnostics were limited to existing
Express/dependency typing issues outside the changed A0 modules; the
package-manager typecheck could not start because the configured Corepack
cache entry was absent. The final validation is recorded below under the
post-remediation C2C evidence and supersedes these historical counts.

## Safety and disposition

The exact existing A0 Project/connector/chat binding and read-only workspace
verification were preserved. No new connector, Project, workstream, OAuth
scope, source-side A2 change, commit, push, PR, or merge was made. The
conditional CIMD/DCR product branch remains a runtime/product observation,
not an unconditional implementation assumption.

The implementation is ready for the existing bounded post-implementation C2C
review. Any further change must remain inside the approved A0 scope and the
canonical workflow.

## C2C remediation after iteration 4 (iteration-5 validation)

The bounded post-implementation review returned `FIX_REQUIRED` for four
in-scope issues: the normalized Project label was not yet consumed by the
setup payload/Skill path; legacy resource-less OAuth tokens and implicit
`offline_access` were fail-open; surface/app-selection/readiness records were
not connected to the machine-local control plane; and the Skill retained
contradictory unconditional browser-route rules.

The remediation kept the existing workstream, connector, Project, reviewer
chat, and `a0-surface-plan` checkpoint. The workspace payload and doctor output
now expose the deterministic Project label and its 50-character bound; the
Skill consumes that field rather than reimplementing normalization; access and
refresh verification reject missing or mismatched resources; omitted scopes
exclude `offline_access`; provisioning readiness requires a selected semantic
surface, a reuse/create/recovery outcome, and all five live verification
proofs; the CLI records message-key-bound app selection; and the Skill route
policy is capability-driven with a bounded authenticated-profile fallback.

Iteration-5 validation passed: the corrected focused suite ran 6 files
and 60 tests, the full suite ran 22 files and 231 tests, and direct TypeScript
compilation exited successfully. No private runtime identity, OAuth material,
A2 source, push, PR, or merge was introduced.

## C2C remediation after iteration 5

The next bounded review found four A0-only corrections. The current-message
app-selection record now has an explicit pending-to-succeeded lifecycle keyed
by the existing delivery identity, and the provisioning CLI verifies that
successful record before it can persist READY. Project-label normalization now
uses only the durable workstream identity and workspace id, so doctor and
workspace payloads cannot diverge when connector presentation changes.
Connector reconciliation tests now cover missing and mismatched account and
Project proof, missing and false read-only proof, and exact verified reuse.
The earlier 55/226 validation paragraph is explicitly historical; the final
iteration-6 counts below supersede it.

Iteration-6 validation passed: the focused suite ran 8 files and 81 tests, the
full suite ran 22 files and 240 tests, and `tsc -p tsconfig.json --noEmit
--pretty false` exited 0. The readable outputs are recorded in the existing
C2C execution records. No private runtime identity, OAuth material, A2 source,
push, PR, or merge was introduced.

## C2C iteration-6 review disposition

The bounded post-implementation C2C review returned `EXECUTED_REVIEW PASS`.
The reviewer independently verified the exact A0 workspace, branch, recorded
HEAD, clean upstream relation, A0-only working diff, readable iteration-6
execution outputs, and the corrected implementation evidence. The workflow
remains at Step 5 with the existing `a0-surface-plan` checkpoint and is ready
for the canonical Push/PR publication approval gate. No publication action was
taken.
