# A0 Manual Fallback Evidence

This artifact records temporary live acceptance evidence only. It does not
change the intended steady-state requirement that the supported built-in
browser automate the complete A0 compatibility path.

- Checkpoint: `a0-surface-plan`
- Reason for fallback: the supported built-in IAB/CUA route terminated with
  `helper_unknown_error` before it could operate the ChatGPT surface.
- Observed route: custom MCP creation form, native custom-MCP risk
  acknowledgement, and the expected OAuth pairing surface.
- Form evidence: the user-provided view matched the exact A0 connector name,
  description, current endpoint, and OAuth choice. No pairing code, token,
  cookie, OAuth client identifier, or private URL is persisted here.
- Authorization evidence: the pairing surface named the exact A0 workspace and
  displayed only the expected read-only capabilities (session continuity,
  file read, workspace search, git status/diff read, and execution-summary
  read).
- Native risk acknowledgement: this is the expected ChatGPT custom-MCP warning.
  The explicit C2C request, exact connector/workspace binding, and read-only
  scope contract satisfy the existing machine-confirmation guard. The native
  acknowledgement was completed manually only because browser automation was
  unavailable; this does not broaden the exception to routine provisioning or
  OAuth pairing.
- Verification status: `Connected`, exact connector selection, `workspace_info`,
  and `git_status` remain unverified in Codex. No source implementation or A2
  workstream change has occurred.
- Next step: resume the same checkpoint after Connected is observed, then verify
  the exact read-only workspace and repository state.
