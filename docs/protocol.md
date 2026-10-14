# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

## Required work product acquisition

`list_work_product_manifest({ required_paths: [...] })` observes an explicit,
nonempty set of workspace-relative regular files. It requires both existing
`workspace.read` and `git.read` scopes. The reviewer determines the required
set independently from the Issue, plan, source and status; the returned set
does not certify its own sufficiency. There is no directory expansion or
pagination. The limits are 256 paths, 1 MiB per file/blob, 256 KiB policy,
64 MiB index and 256 KiB for the entire serialized MCP response. Refusal,
missing required files, unsupported modes/stages, read errors, drift or limits
return `complete: false` with no successful partial entries.

Each entry maps to existing receipt fields `path/status/head_blob/index_digest/
worktree_digest/mode`. `head_blob` is the Git object ID; `index_digest` is
SHA-256 of the stage 0 blob's raw bytes; `worktree_digest` is SHA-256 before
any newline conversion. A null layer is directly observed as absent. Layer
modes, full HEAD, physical workspace and actual worktree roots, Git directory/
common-directory identity, raw index digest, policy identity and repository
selection are acquisition metadata, not new receipt fields. Status compares
raw layers and modes without executing Git filters; newline conversion can
therefore differ from Git's filtered status. A staged deletion followed by
recreation is represented as `staged_and_unstaged`. Include both paths of a
rename in the required set.

Connection and evidence share the upstream-first, otherwise unique eligible
GitHub remote selector. Ambiguous/detached/unsafe associations are refused.
`local-only` file identities establish no GitHub review binding. Repository
numeric IDs still require live GitHub acquisition. Existing bindings are not
automatically migrated when the selected repository changes.

Retrieve all text pages separately through `read_file`. Directly reacquire a
manifest of the same independently determined paths before and after those
pages, and again before the verdict under the existing cycle freshness rules.
Compare root/worktree, full HEAD, index, each raw digest/mode/status, policy,
repository selection, scope and page coverage. Any drift or incomplete
acquisition requires fresh evidence. A complete single call is a bounded
observation, not an atomic snapshot or a freshness guarantee for other calls.
It grants no content verdict or canonical workflow transition.

`git_history` returns bounded full-ID local history. `git_compare` compares
explicit local revisions and pages its diff with `nextOffset` and the returned
`evidenceId` supplied as `expected_evidence_id`. Independently verify complete
page coverage and completeness metadata. These read-only operations do not
fetch missing objects or execute external diff/textconv/filter/hooks/fsmonitor.
History/comparison require the workspace to be the Git worktree root, so a
subtree connection cannot expose paths outside its workspace through them.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Legacy loop limits and canonical remediation

`maxIterations` (default 12, configurable in `.c2c.json`) applies only to this
legacy conversation protocol. When reached, Codex pauses and asks the user
whether to continue the legacy loop. For a canonical `codex-c2c-v2` workstream,
resolve the governing workflow and recorded pin/state instead: FIX_REQUIRED
uses its autonomous remediation, required verification and re-review, and
existing stop conditions. Do not apply the legacy 12-iteration stop or a new
"continue?" acknowledgement to canonical remediation. Existing bounded OAuth,
network, and resource retries are unchanged.

## Approved connection and current-attempt continuity

Normal new reviewer authorization requests use exactly `workspace.read`,
`workspace.search`, `git.read`, `execution.read`, and `offline_access` when
scope is omitted or blank. The consent page shows the actual requested set.
Explicit narrower scope requests remain narrow. `offline_access` enables
refresh-token continuity after consent, without adding an MCP operation.
`execution.read` permits sanitized saved output, not execution of commands.

For an authorized scope change on an existing App, first observe the current
App/workspace/repository/endpoint/account binding and effective scopes using
the existing read-only tools. Use only that same App's supported OAuth
reauthorization flow. Confirm the request actually contains the intended five
scopes; a client that explicitly requests two scopes stays at two. Complete
the provider's actual consent and required login/MFA/CAPTCHA/account steps,
then verify permitted read/search/git/saved-output access and refresh
continuity from that same reviewer. Keep old grant observations as history.
Never record tokens, cookies, or real codes. If the provider cannot offer the
same-App flow, report that capability blocker without replacing the App.

Preparing this procedure or passing synthetic tests does not authorize or
prove a live scope change, release, consumer adoption, or F02 resumption.
Old 2.5.x pins and their evidence requirements remain governing until a
formally published successor is explicitly adopted through its migration
rules. Safe OAuth connectivity is separate from receipt eligibility and the
independent reviewer's content verdict.

Continue an already authorized operation when its current service, origin,
account, exact installation/workspace/repository/endpoint binding, and read-only
scopes still match. Reuse existing connection, session, provisioning,
current-message selection, and delivery state; after compact/resume, reconcile
the live service before advancing. A healthy saved phase alone is not current
proof. Reconcile prepared/sending/confirmed/ambiguous delivery by the same
task/iteration/message identity; never blind-resend or re-pair just to resume.
Unknown ownership, changed account/endpoint/scopes, unsupported authentication,
or an unresolved service consent boundary retains the existing safe stop.
Observable service completion resumes without another chat acknowledgement.

The Runtime connection owner retains installation, endpoint, account, scope,
and connection safety checks. Safe connectivity and task approval do not
replace the formal reviewer's independent evidence acquisition or receipt
decision. Use the canonical workflow for formal review and its Human Gates;
do not add a decision engine, receipt field, or Runtime READY-to-PASS mapping.

For automatic consent, `consent prepare` registers the current short-lived
challenge; `consent decide` requires the independently observed top-level
`challengeId` to match it. The CLI does not substitute the request ID. Missing,
malformed, or mismatched observations terminalize the registered challenge and
return HUMAN_REQUIRED; replay, TTL, atomic one-shot, binding/account, and exact
scope protections still apply. A matching value is not proof of UI provenance.
No live ChatGPT UI producer for the challenge correlation is established here.
Never copy `--challenge-id` or prepare output into observation JSON to obtain
AUTO_CONFIRM. Until independent correlation is demonstrated, fail closed at
the normal service consent UI; synthetic fixtures do not prove live capability.

Prefer automatic input of a current authorized attempt's user-facing C2C
pairing code. If necessary, its full value may appear in the current user chat
or a transient tool response. Delegate GitHub `user_code` and email-code
handling to `github-cli-auth`; internal `device_code` and other credentials are
excluded. Never copy real codes or credentials into state, logs, hook context,
receipts, Issues/PRs/commits, review artifacts, shared documents, or fixtures.
Reuse the memory-only handoff and existing sanitizer. Chat/tool history may be
retained by the platform; this permission does not disable retention or approval
review. Expired values are not reusable after resume.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
   If execution_output lists a readable item for this iteration, list
   then read it. If status is restricted, ignore the body and review
   from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```
