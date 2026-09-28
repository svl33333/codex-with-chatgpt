# P0-2 workflow resolution evidence
## Workstream

- Workstream: `planner-c2c-restart-resilience-p0-2`
- Repository: `svl33333/codex-with-chatgpt`
- Local branch: `planner-c2c-restart-resilience-p0-2`
- Remote publication: not performed (Step 1 does not publish a branch)

## Canonical workflow identity

The live remote identity supplied after the normal-user GitHub authentication
was:

- repository: `https://github.com/svl33333/codex-c2c-workflow`
- remote `main` commit: `60d17218c256098522e063b5bf4731cecc9c1f12`
- `VERSION`: `2.3.1`
- profile: `codex-c2c-v2`

The managed cache at
`C:\Users\yuyab\AppData\Local\codex-c2c-workflow\repo` resolves
`60d17218c256098522e063b5bf4731cecc9c1f12^{commit}` to the same full SHA.
The cached commit's tree contains `VERSION`, the seven canonical prompt files,
`schema/state.schema.json`, `schema/c2c-review-contract.json`, and
`scripts/validate.py`. The cached `VERSION` is `2.3.1`, and the README names
`codex-c2c-v2`.

## Validation

The canonical cached validator was run against the cache checkout at the exact
verified commit using the Codex bundled Python runtime:

```text
VALIDATION PASSED: Japanese human-facing docs, English canonical spec, 7 steps, C2C contracts, lazy bootstrap, gates, multi-PC policy, schema, links, version, and PDF are consistent.
```

The TeamAI resolver's temporary detached-worktree wrapper returned
`WORKFLOW_VALIDATION_UNAVAILABLE` while reporting the Git preparation message
(`Preparing worktree (detached HEAD 60d1721)`). This wrapper result is retained
for diagnosis; it does not replace the direct validator result for the exact
cached commit.

## Credential-context capability record

The normal-user GitHub CLI authentication was independently refreshed, but the
Codex sandbox still cannot read that user's credential store. Sandbox-local
`gh auth status` therefore remains unavailable/invalid and is not treated as
evidence that the user account is invalid. No token, credential file, or bearer
value was copied into this repository.

P0-2 carries the following explicit unresolved capability requirement:

> Codex must be able to perform authorized GitHub operations through a narrow
> credential-visible host-side mechanism without exposing tokens, copying
> credentials into the repository, or broadly weakening the Codex sandbox.
