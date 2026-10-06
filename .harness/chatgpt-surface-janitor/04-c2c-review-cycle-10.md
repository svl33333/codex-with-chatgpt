# Independent C2C post-implementation review — cycle 10

Task: `c2c_b0ce`
Iteration: 10
Stage: post-implementation

## Verdict

`FIX_REQUIRED`

## Finding

`HIGH` — `CompanionJanitorDriver.abortPendingOperation()` could resolve after
the one-second fallback even when the child process had not emitted `exit` or
`close`. The parent could then reject the destructive confirmation and release
the finalization lease while a delayed child remained alive.

## Remediation

The abort path now waits for an observed child `exit` or `close` event and no
longer treats a kill request as completion. It escalates to `SIGKILL` after a
grace period, but the pending confirmation is rejected only after termination
is observed. A deterministic delayed-child lifecycle test proves the pending
confirmation remains unresolved and the finalization lease remains held until
the exit/close event.

Cycle-10 evidence before this remediation was 67 targeted tests, 312 full
tests, clean TypeScript, and clean `git diff --check`.
