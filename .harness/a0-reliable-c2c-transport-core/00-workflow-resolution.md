# A0 workflow resolution evidence

## Workstream

- Workstream: `a0-reliable-c2c-transport-core`
- Repository: `svl33333/codex-with-chatgpt`
- Local workspace: `C:\Projects\ai-agent-harness-setup\work\codex-with-chatgpt-a0-reliable-c2c-transport-core`
- Local branch: `a0-reliable-c2c-transport-core`
- Base ref: `release/v0.1.3-svl.13`
- Base commit: `13d13f0a05bfaa102394de7145607241d9da1c48`
- Remote publication: not performed (Step 1 does not publish a branch)

The worktree was created independently from the release baseline. The existing
`planner-c2c-restart-resilience-p0-2` worktree/branch and
`host-capability-broker-windows-user-context` worktree remain separate and
unchanged. Full Auto M1 is in another repository and is not migrated.

## Canonical workflow identity

The TeamAI resolver and managed cache identify:

- repository: `https://github.com/svl33333/codex-c2c-workflow`
- profile: `codex-c2c-v2`
- commit: `60d17218c256098522e063b5bf4731cecc9c1f12`
- `VERSION`: `2.3.1`
- review contract: `schema/c2c-review-contract.json`

The pinned checkout contains the required seven prompts, state schema, review
contract, and validator. The direct canonical validator was run with the
Codex-bundled Python runtime:

```text
VALIDATION PASSED: Japanese human-facing docs, English canonical spec, 7 steps, C2C contracts, lazy bootstrap, gates, multi-PC policy, schema, links, version, and PDF are consistent.
```

The resolver wrapper also returned the selected commit and version but reported
`WORKFLOW_VALIDATION_UNAVAILABLE` because its temporary detached-worktree
cleanup check could not confirm removal on this Windows filesystem. This is
recorded as wrapper evidence, not converted into a false `WORKFLOW_READY`
claim; the exact pinned commit's validator output above is the validation
evidence used for this initialization. No workflow source was copied into the
target runtime repository.

## Required Step 1 contract

The resolved `prompts/01-requirements-discovery.md` requires:

- a stable Q-ID design tree and requirements artifact;
- no implementation, Issue creation, or branch publication in Step 1;
- `workflow.step: 1`, `workflow.status: HUMAN_WAITING`, and
  `next.blocked_on: requirements approval`; and
- the terminal marker `REQUIREMENTS_READY_FOR_APPROVAL`.
