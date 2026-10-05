# Step 6 publication proposal

## Target

- Repository: `svl33333/codex-with-chatgpt`
- Branch: `requirements/full-auto-c2c-provisioning-revision`
- Issue: #13
- Base: `main`

## Proposed commit

`feat: harden full-auto C2C provisioning`

The change implements the approved Issue #13 plan: request-bound automatic
pairing with compatibility-first fallback, capability-gated runtime handoff,
exact Project reconciliation and settings-only Instructions routing, and
message-keyed read-only ReviewerProof enforcement through READY. It also adds
the deterministic regression and Skill contract coverage recorded in
`04-test-summary.md`.

## Validation and review

- 268 tests in 26 files — PASS.
- typecheck — PASS.
- build — PASS.
- `git diff --check` — PASS.
- bounded post-implementation C2C iteration 7 — PASS.
- Exact read-only binding: workspaceId `279caac78bfd`.

## Known limitations

The exact connector cannot fetch live Issue #13, so Issue-body parity remains
unverified. A fresh-workspace real ChatGPT product E2E is still required before
Target C can claim completion or weaken the compatibility path. This
publication does not claim that evidence and does not alter the compatibility
fallback.

## Proposed PR

Title: `Full-auto C2C provisioning: preserve automatic pairing and exact review proof`

Body:

Closes #13

Implements the approved successor workstream for Full Auto C2C provisioning:
request-bound compatibility-first pairing, capability-gated runtime handoff,
automatic exact Project reconciliation, settings-only Project Instructions,
and structured message-keyed read-only ReviewerProof enforcement through READY.

Validation: 268 tests, typecheck, build, and `git diff --check` pass. The
post-implementation C2C review passed on the exact read-only requirements
binding. Real fresh-workspace ChatGPT product E2E remains a required follow-up
acceptance step; this PR does not weaken the compatibility path.
