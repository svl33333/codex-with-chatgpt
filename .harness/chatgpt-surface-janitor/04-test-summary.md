# Implementation test summary — chatgpt-surface-janitor

Run after Step 4 approval on 2026-10-07. All commands ran in the
`maintenance/chatgpt-surface-janitor` worktree.

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile verified; Playwright dependency installed without retaining the unrelated MCP SDK upgrade. |
| `pnpm exec tsc --noEmit` | 0 | TypeScript typecheck passed. |
| `pnpm exec vitest run tests/janitor.test.ts tests/cli-workspace-flag.test.ts tests/consent.test.ts tests/project-provisioning.test.ts tests/app-selection.test.ts tests/session.test.ts` | 0 | 68 targeted tests passed. |
| `pnpm exec tsx src/cli/index.ts janitor -w C:\\ignored --help` | 0 | Machine-wide janitor command exposes `-w` as an ignored compatibility option and lists scan/plan/dry-run/apply/rescan. |
| `pnpm test` | 0 | 29 test files and 313 tests passed. |
| `git diff --check` | 0 | No whitespace errors. |

The zero-resource capability regression and cancellation-safe destructive
confirmation were then re-run after their respective fixes:

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm exec vitest run tests/janitor.test.ts tests/cli-workspace-flag.test.ts tests/consent.test.ts tests/project-provisioning.test.ts tests/app-selection.test.ts tests/session.test.ts` | 0 | 68 targeted tests passed. |
| `pnpm test` | 0 | 29 test files and 313 tests passed. |
| `pnpm exec tsc --noEmit` | 0 | TypeScript typecheck passed. |
| `git diff --check` | 0 | No whitespace errors. |

The cycle-10 review finding was closed by making companion abort completion
wait for an observed `exit`/`close` event. A delayed child now receives a
hard-kill escalation only after the grace period, and the regression test
proves that the pending confirmation remains unresolved and the finalization
lease remains held until termination is observed. These latest results were
recorded through `c2c record` as iteration 11 evidence.

No live scan or deletion was attempted. The production companion is bounded
to `AUTH_REQUIRED` or `CAPABILITY_UNAVAILABLE` for resource kinds whose
semantic routes or authenticated account proof are unavailable; the verified
Project route remains fail-closed on route drift.
