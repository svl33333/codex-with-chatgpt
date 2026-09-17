# Custom stability patch set

This checkout is a small, reviewable fork of `XiaoDuoYa/codex-with-chatgpt`.
The upstream source remains the runtime source of truth for bridge, MCP, OAuth,
pairing, workspace inspection, tunnel, and process behavior. The custom layer
adds durable identity and reconciliation state without copying runtime source
into the TeamAI repository.

## Provenance

- Upstream: <https://github.com/XiaoDuoYa/codex-with-chatgpt>
- Integrated official baseline: `9663b88753e35c76796c5bce000293e0bd22cd9e`
- Baseline version: `0.1.3`
- Custom fork: <https://github.com/svl33333/codex-with-chatgpt>
- Custom version: `0.1.3-svl.11`
- License: MIT (retained from upstream)

Keep `upstream` and `origin` separate. A future update first fetches and
reviews upstream changes, then reapplies the custom patch commits. Do not
replace the custom checkout with a mutable working tree during bootstrap.

## Patch inventory

| Area | Files | Contract |
| --- | --- | --- |
| Installation identity | `src/connection/identity.ts` | One persistent installation ID per user installation; remotes are canonicalized without credentials; bindings are user-local and secure. |
| Connector reconciliation | `src/connection/reconciler.ts` | Read/list and `workspace_info` are the normal path; verified reuse performs zero mutations; create/delete use a deterministic operation key and checkpoint. |
| Message delivery | `src/conversation/delivery.ts` | Task, iteration, and message ID form an idempotency key; ambiguous transport is reconciled by remote status rather than blindly resent. |
| Conversation identity | `src/conversation/registry.ts` | Project, conversation, repository, work, stage, and role are bound together; mismatches fail closed. |
| Endpoint metadata | `src/config/endpoint.ts`, `src/cli/index.ts` | Endpoint mode, fingerprint, repository, installation, and connector identity are persisted alongside existing endpoint state. |
| Runtime identity | `package.json`, `src/version.ts` | Custom releases are distinguishable from upstream releases. |
| CLI compatibility | `src/cli/index.ts`, `tests/cli-workspace-flag.test.ts` | Machine-wide commands accept and ignore a legacy `-w`; workspace-scoped commands continue to use `-w <workspace root>`. |
| Distribution | `scripts/bootstrap-custom-c2c.ps1`, `scripts/update-custom-c2c.ps1`, `scripts/install-codex-c2c-skill.ps1` | A pinned ref is cloned, built with the frozen lockfile, and the exact Codex-native Skill is installed only after successful verification. |

These modules are adapter-level foundations. The upstream browser workflow
still performs the user-facing connector operation; callers should use the
checkpoint contracts before invoking it. Normal startup must not delete or
recreate a connector merely because a process restarted.

## Safety invariants

1. A connector label never proves ownership. Match workspace, canonical
   repository, installation ID, endpoint mode, and endpoint fingerprint.
2. A same-name foreign connector is a conflict and remains untouched.
3. A delete is followed by an authoritative absence check before create.
4. A create timeout is reconciled by list plus `workspace_info`; an unverified
   result becomes `CONNECTION_WAITING`.
5. A message timeout is `ambiguous` until remote status is known. Reasoning and
   in-progress states are waiting, not send failures.
6. Project, conversation, stage, role, and repository mismatch is `BLOCKED`.
7. Checkpoints contain identifiers and hashes, never OAuth tokens, cookies,
   pairing codes, or message bodies.

## Verification

The fixture suite runs on Windows and covers reuse with zero mutations, owned
replacement, foreign-name protection, create/delete uncertainty, two
installations, message restart idempotency, reasoning waits, and conversation
identity mismatch. Run:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
```

Passing adapter fixtures do not prove a live ChatGPT browser connection. Live
verification additionally requires the user's ChatGPT session, connector
authorization, and (for named endpoints) Cloudflare login; those credentials
stay outside the repository and are not exercised by CI.

## Update procedure

1. Inspect upstream release notes and diff the new base against the recorded
   baseline; preserve the upstream remote.
2. Semantic-port only reviewed upstream behavior. Do not merge, cherry-pick, or
   wholesale-replace the custom fork; resolve conflicts in identity/reconciliation
   modules explicitly.
3. Bump the custom version, update this provenance table and tests, then run
   typecheck and the full fixture suite.
4. Publish a new immutable tag on the custom fork.
5. Run `scripts/update-custom-c2c.ps1 -Ref <tag>`; it builds a new version
   directory and advances the user-local manifest only after verification.

The TeamAI repository distributes the policy, Codex-only installer, and
bootstrap/update wrappers as control-plane material. The executable Skill
remains in this runtime repository and is never copied into TeamAI's generic
`skills/` directory. TeamAI does not contain this runtime's `node_modules`,
credentials, endpoint URLs, or full source tree.
