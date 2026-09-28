# P0-2 Issue finalization snapshot

- Issue: [#3](https://github.com/svl33333/codex-with-chatgpt/issues/3)
- Title: `[P0-2] Planner/C2C restart-safe zero-touch recovery foundation`
- Repository: `svl33333/codex-with-chatgpt`
- Created through: authenticated GitHub App transport after verifying the
  `svl33333` profile and repository ownership/permissions.
- Live verification: fetched Issue #3 after creation; title, URL, and body
  matched the finalized requirements conversion.

The first draft payload was rejected by the automatic safety review because it
contained machine-local paths, workspace identifiers, and detailed
credential/security context. The final public Issue is a materially safer
sanitized conversion. Exact local identifiers and protected-resource locations
remain only in the P0-2 local artifacts; no bearer token or credential file was
copied into the repository or Issue.

The Issue records the approved Q201/Q202/Q203/Q204/Q208 decisions, the settled
Q205/Q206/Q207 classifications, and the Full Auto Requirements Decision
Resolver regression case: technical facts and already-approved project policy
must be settled before a Human Gate, and only genuine
`OPEN_USER_DECISION` items may be re-asked with their complete question text.

Step 2 did not publish the branch and did not begin implementation.

## Step 3 C2C capability evidence

- The bounded Step 3 INIT request was sent through the saved C2C project chat
  after the local C2C doctor and session checks were healthy.
- The bound `full-auto-v1` ChatGPT connector failed on `workspace_info` twice
  with an internal tool error, so the required workspace identity and
  repository boundary could not be independently verified.
- The canonical contract outcome is
  `REQUIRED_CAPABILITY_UNAVAILABLE`; no alternate connector, local reviewer,
  repeated INIT, or source mutation was used.

## C2C recovery and current binding boundary

- The target workspace was independently resolved as `codex-with-chatgpt`
  (workspace ID `d2c224c45190`) with canonical repository
  `https://github.com/svl33333/codex-with-chatgpt` and the exact owned
  connector `Codex with ChatGPT · codex-with-chatgpt · 2aa24f13`.
- The target bridge was restarted through the installed runtime's supported
  entrypoint, `c2c doctor --no-fix --json` is green, and the recreated
  connector is paired through OAuth at the current target endpoint. Remote
  settings identify account `svl333 (svl333)`, the exact connector name, and
  the expected target workspace URL.
- The surfaced ChatGPT collection is instead
  `ai-agent-harness-setup`. Its Project settings explicitly bind
  `full-auto-v1` and the fixture root, so it cannot be reused for P0-2. Its
  instructions were not edited; this preserves Full Auto M1 and its
  historical v2.2.0 state.
- A new Project chat HANDOFF was correctly rejected because the collection's
  own binding remained `full-auto-v1`. This is a verified project-level
  identity mismatch, not a target connector health failure. No additional
  connector, Issue, INIT, or source mutation was created.
- The installed C2C Skill's `Wrong collection / Bind Project` boundary now
  applies. The next supported action is to create/open a separate Project
  named `codex-with-chatgpt` (project-only memory, library access disabled),
  configure its instructions with the exact target connector name, and leave
  that collection page open so the existing Step 3 checkpoint can resume.

## Target Project rebound and provider limit

- The user created the expected Project collection:
  `https://chatgpt.com/g/g-p-6ab9c300b2f48191831194fb51168b19/project`.
- Project settings were verified as project-only memory with library access
  disabled. Its instructions now name only the target workspace
  `codex-with-chatgpt`, repository root, and exact connector
  `Codex with ChatGPT · codex-with-chatgpt · 2aa24f13`; no temporary tunnel
  URL or credential was written.
- The new Project chat is
  `https://chatgpt.com/g/g-p-6ab9c300b2f48191831194fb51168b19-codex-with-chatgpt/c/6ab9c359-745c-83e8-961e-59fe510c2e56`.
  The standard boot prompt was acknowledged, then the existing
  `c2c_b4e1` Step 3 HANDOFF was sent without a new INIT.
- ChatGPT returned `上限に達しました。後でもう一度お試しください。` before
  `workspace_info` could execute. The supported in-place Retry was attempted
  once and returned the same limit. This is a provider usage-capability
  failure, not evidence of a connector or workspace identity mismatch. No
  further retry loop, model substitution, connector change, Issue mutation,
  or source implementation was performed.

## Current-workspace connector repair and Step 3 re-review

- The saved target connector was proven to be owned by this exact workspace
  identity (`codex-with-chatgpt`, workspace ID `d2c224c45190`, installation ID
  `2aa24f13-b64e-45d1-8b78-12e0d793ef1c`). Its old endpoint was unavailable
  (`ERR_NAME_NOT_RESOLVED`) during the official install flow, so the exact
  target record was deleted through the official settings UI only after
  ownership was established; absence was then verified.
- The same connector name was recreated through the official MCP app creation
  flow at the current doctor-verified bridge endpoint. OAuth consent was
  limited to `workspace.read`, `workspace.search`, `git.read`,
  `execution.read`, and `offline_access`. The supported local pairing flow
  completed once; no pairing code or token is recorded here.
- The existing Project chat and `c2c_b4e1` session were reused. A bounded
  identity check confirmed `workspace_info` and the exact connector tools.
  The existing Step 3 review was then resumed without INIT, a new chat, Issue,
  or branch.
- The repaired connector verified the exact workspace and branch. ChatGPT's
  read-only review returned `FIX_REQUIRED`, because the plan had substantive
  defects in process-safe locking, atomic state writes, `/health` versus
  authenticated `/admin/info` ownership checks, stale-PID safety, secret
  transport, tunnel compatibility, rollback provenance, and test coverage.
  These were plan defects within the approved scope, not a capability failure
  or a new policy decision. The plan draft was remediated and the same-session
  C2C re-review returned `PASS`.
- Step 3 is complete. The canonical next gate is Step 4 direct plan approval
  against `02-plan.md`; implementation remains prohibited until that gate is
  explicitly approved.
- This remains explicit P0-2 evidence: ordinary process/restart recovery must
  not leave saved C2C connector or session bindings pointing at an unavailable
  or wrong workspace endpoint.

## Provider-limit recovery continuity check

- After the ChatGPT provider usage limit cleared, the same saved Project chat
  and `c2c_b4e1` session were used for a read-only continuity check. No INIT,
  new chat, Project, connector, pairing, Issue, branch, source, artifact, or
  workflow-state mutation was performed by that check.
- The exact bound connector reported `workspace_info` for
  `codex-with-chatgpt` (workspace ID `d2c224c45190`) and reported exact
  connector tools available. Read-only Git status reported repository present,
  branch `planner-c2c-restart-resilience-p0-2`, HEAD `13d13f0`, no staged or
  unstaged changes, and only `.harness/` untracked.
- The response explicitly confirmed that the completed Step 3 review was not
  repeated and the Step 4 direct plan-approval gate remains in force.
