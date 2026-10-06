# Step 5 post-implementation C2C review — cycle 5

The independent review returned `FIX_REQUIRED` for seven items:

1. Account authority must not be derived from visible menu text.
2. Project stable IDs must retain the complete `g-p-...` namespace.
3. Preparation and final confirmation must re-observe exact identity and safe
   metadata.
4. A bad `--plan-digest` must fail before browser construction.
5. A fresh rescan must override a stale historical `removed` outcome.
6. An owner-only exact keep-list and uniquely verified legacy migration were
   still missing.
7. The targeted-test count and recorded verification outputs were stale or
   incomplete.

Remediation is complete: the companion now accepts only the machine-bound
exact account attribute, canonicalizes full Project IDs, re-observes metadata
during preparation and immediately before the delete click, the CLI uses the
pure `preflightApplyPlan` gate before creating a driver, rescan correlation
reports `still_present` and `repeatSafe: false` for a fresh observation, the
store has a leased exact keep-list plus unique composite migration, and the
test summary/evidence records were updated to 61 targeted and 306 full tests.
