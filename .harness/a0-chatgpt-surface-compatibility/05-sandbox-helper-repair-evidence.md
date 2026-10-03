# Sandbox/helper repair and fresh-IAB evidence

- Observed: 2026-10-03, fresh-session recovery of the existing A0 workstream
- Checkpoint preserved: `a0-surface-plan`
- Source implementation and A2 remain unchanged.

## Runtime and supported-path checks

- The active Codex desktop package is the current production build reported by
  the installed updater; the active CLI bundle reports `codex-cli 0.160.0`.
- The active CUA Node runtime is the bundled CUA runtime, and the sandbox setup
  binary is Authenticode-valid and signed by OpenAI.
- The normal helper runs at medium integrity. A direct `--elevated` setup
  invocation did not bypass the supported brokered path; it returned the
  expected elevation-required result. No permanent elevation was used.
- The upstream/local helper contract identifies the sandbox-group grant and the
  current workspace capability grant as write-root ACEs with access mask
  `0x001301BF` and object/container inheritance (`OI|CI`).

## Before repair

- The Temp write root had the normal user, SYSTEM/Administrators, sandbox-group,
  and older capability entries, but lacked the current Temp-root capability ACE
  required by the active helper contract.
- The helper repeatedly attempted that exact write-root refresh and failed with
  `SetSecurityInfo failed: 5`; setup then returned `setup refresh had errors`
  and the supported IAB/CUA initialization stopped before UI access.
- The failure occurred under the normal non-elevated helper context. No broad
  ACL grant, ownership change, deny-ACE removal, or recursive ACL reset was
  performed.

## Minimal repair

- A one-time UAC-mediated repair added only the missing current Temp-root
  capability ACE with the contract mask and `OI|CI` inheritance. The existing
  sandbox-group and protected-path rules were preserved.
- Rollback is the exact inverse: remove only that one current Temp-root
  capability ACE. No other path or workstream was changed.

## After repair

- The next Codex sandbox refresh processed all four write roots with
  `errors=[]`, completed the setup binary, and reused the command-runner helper.
  The remaining `C:\Users\Default` hide-users warning is unrelated and was not
  setup-fatal.
- Exactly one fresh built-in IAB/CUA initialization was then performed in the
  fresh recovery session. It reached the built-in Codex In-app Browser and the
  authenticated ChatGPT UI; the previous `helper_unknown_error` did not recur.
- The existing A0 app binding was reconciled in place: the stale remote app was
  removed and the same exact A0 identity was recreated against the current
  workspace endpoint. No second workstream or alternate connector was created.

## OAuth and current external gate

- The user explicitly authorized the exact runtime-resolved A0 temporary OAuth
  origin. The built-in IAB then displayed the expected read-only scope list and
  pairing form; the one-time pairing completed successfully.
- The A0 plugin page now visibly shows the connected account for the exact A0
  app, confirming Connected state without touching any other connector.
- Post-pairing `c2c doctor` is green for node, sandbox, workspace, bridge, MCP,
  OAuth, and tunnel. No pairing code, token, endpoint, or private browser data
  is recorded here.
- The preserved C2C session is in `project` mode but has no saved Project or
  chat URL (`projectReady=false`). The next required human action is to bind the
  existing workspace to its intended ChatGPT Project; no unrelated Project may
  be guessed. After binding, Connected verification, `workspace_info`,
  `git_status`, and the bounded pre-implementation plan review remain pending
  at `a0-surface-plan`.

## Project reconciliation boundary

- The authenticated ChatGPT Project list was inspected. There was no exact
  `codex-with-chatgpt-a0-chatgpt-surface-compatibility` Project and no ambiguous
  candidate was treated as equivalent.
- The native create form rejected that exact requested identity because the
  product enforces a 50-character Project-name limit while the requested name
  is 51 characters. The form was closed without creating a truncated or
  near-match Project, and no other Project was changed.
- The C2C checkpoint remains `a0-surface-plan`; Project binding,
  `workspace_info`, `git_status`, and the bounded plan review are pending this
  product naming constraint.

## Approved Project-name compatibility continuation

- The current ChatGPT creation surface visibly enforces a 50-character
  display-name limit. The previously requested
  `codex-with-chatgpt-a0-chatgpt-surface-compatibility` value is 51 characters
  and is invalid on that surface.
- The user approved the bounded replacement
  `codex-with-chatgpt-a0-surface-compatibility`. This is display-name
  normalization only; the durable workstream, repository, local workspace,
  connector identity, and `a0-surface-plan` checkpoint are unchanged.
- Project reconciliation found no exact existing replacement, so exactly one
  Project was created with that exact display name. Its memory is
  Project-only; Library/Space access remains disabled. No other Project was
  changed and no private Project or chat URL is recorded here.
- Project instructions bind the exact A0 connector by name only. One reviewer
  chat was created in Chat mode. The exact A0 app was explicitly selected for
  the fresh MCP-dependent HANDOFF message.
- The same chat returned exact `workspace_info` identity and a bounded
  `PLAN_REVIEW / FIX_REQUIRED` result. It called `workspace_info`,
  `git_status`, and `git_diff(mode=head)`, but the connector reported
  `isRepo: false`, so branch/HEAD/cleanliness are not yet independently
  verifiable through C2C. Local elevated read-only verification remains
  authoritative for the current branch and HEAD until that visibility issue
  is resolved.
- No source implementation, A2 change, additional connector, or additional
  workstream was created.
