# A0 workspace preflight

This artifact records the runner precondition for the existing A0 workstream.
It is not a canonical workflow stage and does not replace the Step 1
Requirements Human Gate.

## Target identity

- Workstream: `a0-reliable-c2c-transport-core`
- Workspace root: `C:\Projects\ai-agent-harness-setup\work\codex-with-chatgpt-a0-reliable-c2c-transport-core`
- Workspace ID: `f5dc2ee0d7ba`
- Repository: `https://github.com/svl33333/codex-with-chatgpt`
- Branch: `a0-reliable-c2c-transport-core`
- HEAD/base: `13d13f0a05bfaa102394de7145607241d9da1c48`
- Installation ID: `2aa24f13-b64e-45d1-8b78-12e0d793ef1c`
- Runtime: `0.1.3-svl.13` at the user-local pinned checkout

## Existing-state inspection

The exact workspace had no prior binding, endpoint, session, or runtime state.
Bindings for other workspaces were inspected and were not reused or edited.
The stable runtime created exactly one A0-local binding with endpoint mode
`ephemeral`, connector title
`Codex with ChatGPT · codex-with-chatgpt-a0-reliable-c2c-t · 2aa24f13`, and a
new endpoint fingerprint. No second connector was created.

Local checks after setup:

- `identity`: exact workspace, repository, installation, endpoint, and binding
  match.
- `workspace`: exact root, Node/Vitest project metadata, and expected branch
  are verified locally.
- `doctor --no-fix`: Node, sandbox, workspace, bridge, MCP (401 unauthenticated
  probe), OAuth, and tunnel are green.
- Connection policy: TeamAI named default for `aristocrats.win`; named tunnel
  provisioning failed and the stable runtime recorded its permitted Quick
  fallback. The named policy is retained for the next retry.

## Current bounded result

The A0 bridge and read-only endpoint are healthy. The supported Add connector
URL did not expose its form on two automatic attempts, so the stable Skill's
guided manual boundary was used. The exact MCP app was then created and
authorized in the built-in browser, and the one-time pairing was accepted.
The live OAuth surface showed the exact A0 workspace and read-only scopes:
session continuity, file read, workspace search, Git status/diff read, and
execution-summary read.

An independent ChatGPT-side verification subsequently called `workspace_info`
through the exact A0 MCP app and reported the intended workspace identity. The
final verification was performed from the dedicated A0 Project review chat,
using the exact connector title above, and it also read the top-level
requirements artifact `.harness/a0-reliable-c2c-transport-core/00-requirements-working.md`:

- Workspace ID: `f5dc2ee0d7ba`
- Workspace: `codex-with-chatgpt-a0-reliable-c2c-transport-core`
- Branch: `a0-reliable-c2c-transport-core`
- Commit: `13d13f0a05bfaa102394de7145607241d9da1c48`

The dedicated Project is `codex-with-chatgpt-a0-reliable-c2c-transport-core`
at `https://chatgpt.com/g/g-p-6abc8031691c819185f50e07de7422b6/project`.
Its memory is Project-only, its library access is disabled, and the A0-specific
Project instructions are saved. The final review chat is
`https://chatgpt.com/g/g-p-6abc8031691c819185f50e07de7422b6-codex-with-chatgpt-a0-reliable-c2c-transport-core/c/6abc88ad-4bb8-83e8-8c95-c0bbba2dd9f1`.
That chat returned an exact identity match and confirmed the then-current
Step 1 / `HUMAN_WAITING` pre-approval snapshot, no Issue or implementation
authorization at that time, Q301-Q310 open at that time, and A0-AC-014..018
present. This paragraph is preserved as historical evidence of the
intermediate bootstrap state; the later Q301-Q310 approval is recorded in the
requirements artifact's Section 13.1 and in `state.yaml`. This establishes all
configured readiness phases, including `REVIEW_SESSION_READY` and
`WORKSPACE_READY`.

The earlier intermediate snapshot above is retained rather than rewritten.
It has since been reconciled: the exact Project/chat/session metadata and
final review-chat verification are recorded here, all four readiness phases
are observed, and the reconciliation led to the canonical Step 2 Issue
Finalization recorded in `state.yaml`. The current canonical next action is
Step 3 planning. This readiness evidence does not itself create or publish an
Issue and does not bypass any canonical workflow gate.

## Readiness phase record

| Phase | Status | Evidence |
| --- | --- | --- |
| `LOCAL_RUNTIME_READY` | observed | Pinned runtime, exact workspace identity, and local `doctor --no-fix` passed. |
| `MCP_BINDING_READY` | observed | Exact A0 MCP app authorized/paired and independent `workspace_info` identity above. |
| `REVIEW_SESSION_READY` | observed | Dedicated Project, Project-only memory, library disabled, exact connector instructions, exact chat/session, and final review-chat verification all match. |
| `WORKSPACE_READY` | observed | All configured lower-level phases match and the final review chat verified the exact A0 workspace identity. |

## Regression rule

Every new workstream reaches `WORKSPACE_READY` before canonical development
activity depends on C2C review transport. `WORKSPACE_READY` is automatic runner
preflight, not a canonical Human Gate. One broken workspace binding must not
block unrelated workstreams.
