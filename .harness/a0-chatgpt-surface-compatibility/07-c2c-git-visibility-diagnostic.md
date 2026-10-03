# C2C Git-visibility diagnostic

- Observed after the exact A0 Project/chat binding and fresh MCP-dependent
  HANDOFF: `workspace_info` matched the A0 workstream, while `git_status` and
  `git_diff(mode=head)` returned `isRepo: false`.
- The supported bridge status reports the exact A0 workspace root and a green
  local bridge/MCP/OAuth state. The bridge process runs as the normal user.
- The worktree `.git` directory is owned by the Codex sandbox service identity,
  while the bridge user is the normal desktop user. This is an ownership
  boundary, not evidence of a missing repository or a need to change ownership.
- Reproducing the bridge's plain Git probe returns Git's `dubious ownership`
  refusal. With an explicit read-only `safe.directory` command-line override,
  the same worktree resolves as the expected repository and the local branch
  and HEAD are readable.

## Minimal reversible repair

The intended repair is one exact Git trust entry for the current A0 worktree:

```text
git config --global --add safe.directory <current A0 worktree>
```

This does not grant filesystem permissions, change ownership, remove deny ACEs,
or trust a parent/profile-wide path. Rollback is to remove only the matching
exact `safe.directory` value from the user Git configuration. No ACL or source
file change is part of this repair.

Validation requires the existing bridge to re-run `workspace_info`,
`git_status`, and `git_diff(mode=head)` through the same exact A0 connector.
Until that succeeds, source implementation remains paused and the
`a0-surface-plan` checkpoint is preserved.

## After the repair

- One exact `safe.directory` trust entry for the current A0 worktree was
  applied through the normal user Git configuration. No ACL, ownership, deny
  entry, source file, connector identity, or A2 artifact changed.
- The same reviewer chat, with the exact A0 app explicitly selected again,
  re-ran `workspace_info`, `git_status`, and `git_diff(mode=head)` through the
  existing connector.
- C2C reported `isRepo: true`, branch
  `a0-chatgpt-surface-compatibility`, the recorded full HEAD, no tracked
  staged/unstaged/conflicted files, and an empty HEAD diff. Only the untracked
  planning/evidence artifacts remained.
- Read-only status was verified from the connector tool annotations and no
  source or A2 implementation occurred.
- The bounded review returned `FIX_REQUIRED` only because the plan/state still
  described the now-resolved Git blocker. That evidence is reconciled in
  `02-plan-draft.md`; the `a0-surface-plan` checkpoint remains preserved.
