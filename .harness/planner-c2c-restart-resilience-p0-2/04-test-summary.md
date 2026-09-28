# P0-2 implementation test summary

## Scope

- Workstream: `planner-c2c-restart-resilience-p0-2`
- Workflow pin: `codex-c2c-v2` 2.3.1 at
  `60d17218c256098522e063b5bf4731cecc9c1f12`
- Branch: `planner-c2c-restart-resilience-p0-2`
- Implementation scope: recovery binding registry, atomic user-local state,
  cross-process binding locks, authenticated bridge ownership checks,
  protected-secret/tunnel adapter boundaries, recovery CLI, and owned
  per-user supervisor command construction.

## Checks run

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | PASS | TypeScript completed with exit code 0. |
| `pnpm build` | PASS | `tsc -p tsconfig.json` completed with exit code 0. |
| `node_modules\\.bin\\vitest.CMD run tests/recovery.test.ts --pool=threads --maxWorkers=1 --minWorkers=1` | PASS | 23 tests passed. Covers registry identity/root validation and exact-resource capability attestation, atomic replacement with interrupted-write fault injection, same-process/cross-process/dead-owner lock behavior, checkpoint isolation and locked-operation failure persistence, malformed metadata, injected recovery, healthy exact tunnel reuse without secret resolution, stale and post-reconcile tunnel targets, capability fail-closed behavior, encoded Windows supervisor action execution and exact ownership/query failure/exit propagation, installer-side missing/manual/valid startup-policy enforcement, authenticated admin PID-reuse disagreement, and retryable provenance-safe cleanup including idempotent owned-secret release. |
| `node dist/cli/index.js --help` | PASS | Built CLI exposes `recover` and `supervisor`. |

## Full-suite attempt

Command:

```text
pnpm typecheck; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; node_modules\\.bin\\vitest.CMD run
```

The suite completed with 226 passing tests and 7 failures in existing
subprocess-based CLI cases. The spawned Node processes failed before the CLI
loaded with `uv_os_get_passwd returned ENOMEM (not enough memory)` from the
installed `tsx` runtime. The same environment showed the error in a direct
`node --import tsx ...` invocation; this is an execution-host resource failure,
not an assertion from the P0-2 recovery code. The new recovery test file and
the TypeScript/build checks pass independently. The seven failures are the
same pre-existing subprocess resource failures observed before the P0-2
remediation; no new assertion failure was introduced.

## Capability boundary

The implementation does not invent a shell or argument transport for the
configured Secure MCP Tunnel. The default recovery path uses explicit
unsupported protected-secret and tunnel adapters and returns bounded
`protected_secret_unavailable` / `unsupported_tunnel_capability` results
without mutating the existing tunnel profile. An injected in-process test
adapter proves the actual-endpoint and protected-handle seams without exposing
the test secret to the caller or durable state.

## Not run

- Windows reboot acceptance: requires a later supervised Windows acceptance
  window and is not simulated by the unit tests.
- GitHub Issue/push/PR writes: outside Step 5; no GitHub credential was copied
  into the repository and no write operation was attempted.
