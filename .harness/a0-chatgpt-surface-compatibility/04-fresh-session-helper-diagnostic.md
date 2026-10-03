# Fresh-session built-in browser/helper diagnostic

- Observed: 2026-10-03 19:23 JST (fresh Codex session)
- Workstream checkpoint preserved: `a0-surface-plan`
- Attempt: the first supported built-in IAB/CUA initialization call (`cua.getState()`)
- Result: the helper terminated before any browser/UI inspection with
  `helper_unknown_error` / `setup refresh had errors`.

## Direct evidence

- `C:\Users\yuyab\.codex\.sandbox\setup_error.json` records the same
  `helper_unknown_error` and message.
- The current sandbox log shows the current CUA Node runtime
  (`...\\cua_node\\45309f9050f7314b\\bin\\node.exe`) starting, followed by
  `codex-windows-sandbox-setup.exe` setup refresh.
- The refresh completed the read-ACL phase and processed the visualization
  write root, then failed while granting the write ACE for
  `C:\Users\yuyab\AppData\Local\Temp`:
  `SetSecurityInfo failed: 5`.
- The helper then reported `setup refresh had errors` and exited with status 1.

## Boundary checks

- The Temp directory is owned by `YB-DESKTOP\\yuyab` and already contains a
  `CodexSandboxUsers` Modify ACE; no ACL was changed during this diagnostic.
- The worktree is owned by `YB-DESKTOP\\CodexSandboxOnline`, while its parent
  `work` directory is owned by `YB-DESKTOP\\CodexSandboxOffline`. The normal
  Node `realpath` works, but the sandboxed native `realpath` returns `EPERM`;
  the same native call succeeds in an elevated read-only check.
- Consequently, the non-elevated C2C CLI reports the worktree as nonexistent,
  while the elevated CLI can read the exact existing binding and doctor state.

## Classification and safe next action

This is a browser/helper sandbox initialization defect, not a ChatGPT account,
connector ownership, OAuth scope, or product Human Gate. The failure occurs
before UI access, pairing input, or any connector mutation. No repair was
attempted because changing the Temp ACL or broadening sandbox permissions would
be a security expansion; the next remediation should make the sandbox setup
helper apply its intended ACEs under its authorized runtime, refresh the setup
marker/helper state, and then retry the single supported IAB initialization.

No source implementation, A2 workstream, connector selection, pairing, or
checkpoint was changed.
