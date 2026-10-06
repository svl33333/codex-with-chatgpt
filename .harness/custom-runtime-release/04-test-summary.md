# Step 5 Test Summary

Workstream: `custom-runtime-release`
Issue: [#15](https://github.com/svl33333/codex-with-chatgpt/issues/15)
Branch: `maintenance/custom-runtime-release`
Candidate: `0.1.3-svl.14` (publication-time live-tag recheck still required)

## Validation commands

All commands were run from the workstream repository. The bundled Corepack
package manager was used; no Python was required.

| Command | Result |
| --- | --- |
| `corepack pnpm vitest run tests/consent.test.ts tests/release-consistency.test.ts tests/surface-routing.test.ts tests/endpoint.test.ts tests/skill-contract.test.ts` | PASS — 5 files, 45 tests |
| `corepack pnpm test` | PASS — 28 files, 289 tests |
| `corepack pnpm typecheck` | PASS — `tsc --noEmit` |
| `corepack pnpm build` | PASS — `tsc -p tsconfig.json` |
| `git diff --check` | PASS |

## Coverage recorded

- Runtime-owned consent policy and the production CLI `consent verify-account`,
  `consent prepare`, and `consent decide` path. The account-establishment test
  starts with the same binding shape as fresh setup, accepts only a current
  authenticated-surface observation, and persists only the fingerprint.
- One-shot challenge replay, expiry, unknown-id, bounded cleanup, each durable
  binding dimension, login/CAPTCHA/2FA/destructive/unexpected-account blockers,
  duplicate/missing/write scopes, stale evidence, changed account/binding,
  invalid-first/valid-second terminalization, and concurrent consume behavior.
- App-shell `/plugins` route, inherited-filter clearing, Add/Create controls,
  Settings management/recovery-only behavior, and route-drift recovery.
- Skill, endpoint/page metadata, version/default-ref, and release-consistency
  contracts.
- Existing Project, connector, pairing/OAuth, ReviewerProof, workspace, MCP,
  and CLI regression suites.

## Remediation note

The first post-change typecheck identified redundant control-flow comparisons in
the new route selector. The comparisons were removed without changing the
approved routing contract. The first post-implementation C2C review then
required an explicit production account-binding path, first-attempt challenge
terminalization, and a complete negative matrix. Those fixes were implemented;
the focused suite, full suite, typecheck, build, and diff check were rerun
successfully.

No synthetic live ChatGPT product E2E is claimed. No commit, push, PR, tag, or
TeamAI runtime-pin change has been made.
