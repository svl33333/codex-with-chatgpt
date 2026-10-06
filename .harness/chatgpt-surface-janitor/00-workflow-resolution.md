# Workflow resolution — chatgpt-surface-janitor

- Repository: `svl33333/codex-with-chatgpt`
- Workstream: `chatgpt-surface-janitor`
- Local branch: `maintenance/chatgpt-surface-janitor`
- Base: `origin/main` at `075dac3880adef4af90e9fd152f0788a28eb1fa3`
- Verified release tag: `v0.1.3-svl.14`
- Verified annotated-tag object: `67a70daf417559399d2c409811b9e6d0b3b35c83`

The expected runtime and release evidence matches the live repository. The
historical `custom-runtime-release` and `custom-runtime-tag-publication`
workstreams are not part of this worktree and are read-only evidence.

## C2C pin

- Profile: `codex-c2c-v2`
- Workflow repository: `https://github.com/svl33333/codex-c2c-workflow`
- Version: `2.4.0`
- Commit: `0069229049099c076a74ebb0c1797328ea8f8d3a`
- Contract: `schema/c2c-review-contract.json`
- Validation: passed with the Codex-bundled Python runtime on 2026-10-06

The TeamAI resolver script could not invoke its Git command in this host, so
equivalent managed-cache evidence was performed without changing the cache:
the cache was refreshed, the exact commit was selected, and its validator was
run in a temporary detached worktree using the bundled Python runtime. The
validator passed.
