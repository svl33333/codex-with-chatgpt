# A1 workspace preflight

This artifact records runner readiness for the isolated A1 workstream. It is
not a canonical workflow stage and cannot replace the Step 1 Requirements
Approval Human Gate.

## Target identity

- Workstream: `a1-delegated-authorization`
- Workspace root: `a1-delegated-authorization-worktree`
- Workspace label: `a1-delegated-authorization-workspace`
- Repository: `https://github.com/svl33333/codex-with-chatgpt`
- Branch: `a1-delegated-authorization`
- Base/head: `b36a38cdd613ef474460e2ebc4a62180a93e99c7`
- Runtime: `0.1.3-svl.13`
- Expected connector: `a1-read-only-reviewer`

## Local checks

The release-base worktree was installed and built without changing source
files. `identity`, `tunnel status`, `sandbox-allow`, `doctor`, and
`provisioning` checks were run against this worktree. The local bridge, Node
runtime, sandbox write allowance, OAuth plumbing, and tunnel policy are green.
The configured TeamAI named policy attempted its permitted named provisioning
path and recorded the documented Quick fallback; the named policy remains the
machine default for future retries.

Observed local readiness:

| Phase | Status | Evidence |
| --- | --- | --- |
| `LOCAL_RUNTIME_READY` | observed | `pnpm install --frozen-lockfile`, build, identity, and doctor passed. |
| `MCP_BINDING_READY` | pending | A1 setup produced the expected workspace/connector identity, but no ChatGPT-side connector has been authorized. |
| `REVIEW_SESSION_READY` | pending | No A1 Project or chat has been bound; `c2c session` remains unset. |
| `WORKSPACE_READY` | pending | Depends on the exact connector, Project/chat, and `workspace_info` verification. |

## Browser/bootstrap boundary

The single built-in IAB tab was kept on the documented connector settings
surface. The exact A1 connector title was not present, and the documented Add
connector URL redirected to the installed-plugin settings page without exposing
the create form. No existing connector was edited, deleted, reconnected, or
paired. The A0 connector and every unrelated workspace remain untouched.

The setup command's temporary MCP address and pairing code are intentionally not
persisted in this repository or this artifact. If the documented manual setup
surface is used, the current setup output must be read locally and the one-time
pairing code generated only while the OAuth pairing form is visible. The next
safe manual action is to create exactly the expected A1 connector, authorize it
for the current account, and leave the resulting Project page open; then Codex
can verify `workspace_info`, bind the session, and mark provisioning `ready`.

## Current bounded result

`runtime_ready` is recorded by the local provisioning state. This artifact does
not claim `MCP_BINDING_READY`, `REVIEW_SESSION_READY`, or `WORKSPACE_READY`.
Those phases are runner preconditions for any future C2C review and are not a
reason to bypass the canonical Step 1 requirements gate.

## Regression rule

The A1 workstream must not reuse an A0 connector, Project, chat, endpoint, or
session. A later C2C-dependent step may start only after exact connector
ownership, account, workspace identity, Project/chat binding, and
`workspace_info` evidence all match this worktree.
