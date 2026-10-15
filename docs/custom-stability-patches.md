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
- Custom version: `0.1.3-svl.16`
- Publication status: source candidate; no `.16` tag or release has been published.
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
| Provisioning state | `src/provisioning/state.ts`, `src/cli/index.ts` | Machine-local, secret-free setup phases survive a new Codex session; live verification can advance them without chat acknowledgements. |
| Consent policy | `src/connection/consent.ts`, `src/cli/index.ts`, `skill/SKILL.md` | The authenticated account surface establishes `ConnectionBinding.accountFingerprint` through `consent verify-account`; a ChatGPT unreviewed-MCP warning is then auto-confirmable only through runtime-owned `consent prepare`/`consent decide` after exact read-only binding, machine-verified account/ownership, exact scopes, and first-attempt terminalized one-shot challenge consumption; ambiguous consent remains human-required. |
| ChatGPT creation surface | `src/provisioning/chatgpt-surface.ts`, `src/config/endpoint.ts`, `skill/SKILL.md` | The normal custom-MCP creation route is the plugin app shell (`/plugins` → clear inherited filter → Add → Create a custom MCP server). Settings is management/recovery only; a historical deep-link redirect is route drift and must recover semantically. |
| Runtime identity | `package.json`, `src/version.ts` | Custom releases are distinguishable from upstream releases. |
| CLI compatibility | `src/cli/index.ts`, `tests/cli-workspace-flag.test.ts` | Machine-wide commands accept and ignore a legacy `-w`; workspace-scoped commands continue to use `-w <workspace root>`. |
| Distribution | `scripts/bootstrap-custom-c2c.ps1`, `scripts/update-custom-c2c.ps1`, `scripts/install-codex-c2c-skill.ps1` | Bootstrap delegates to the updater; a fetched candidate is verified, reserved without overwrite at its final path, and built there before activation. Dependency links and the placed CLI are checked before active files change. Existing managed source proves an unedited Skill; unknown or installed-only content is preserved. |

These modules are adapter-level foundations. The upstream browser workflow
still performs the user-facing connector operation; callers should use the
checkpoint contracts before invoking it. Normal startup must not delete or
recreate a connector merely because a process restarted. Browser-visible login,
authorization, Project, and `workspace_info` state is the synchronization
source; a user chat acknowledgement is not.

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
8. A service-side warning is never accepted from text alone. Automatic consent
   requires exact read-only binding, account, ownership, and scope evidence,
   plus a runtime-owned challenge that is atomically consumed before
   `AUTO_CONFIRM`; otherwise the operation remains human-required.

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

Windows installation tests also run actual Corepack/pnpm install and build in
isolated directories. They cover working final placement, broken `commander`
and nested dependency links, destination collisions, and unchanged active
files on preparation failure. The updater never relocates pnpm-built
directories: absolute Windows junctions otherwise retain the old candidate
path. It inspects local dependency metadata without traversing external store
contents. Failed preparation retains the final directory and reports it;
retry does not silently overwrite or adopt that inactive directory.
An unchanged active installation remains a no-op without executing its
existing generated code. These tests do not constitute consumer adoption.

Consent correlation additionally requires the independently observed top-level
`challengeId` to equal the registered current attempt. The CLI never substitutes
the request ID, and a failed correlation terminalizes that request without
consuming another challenge. Matching strings and successful synthetic fixtures
do not prove UI provenance. No live ChatGPT UI correlation producer is
established here; copying prepare output or request parameters into observation
JSON is prohibited. Until a trusted producer is demonstrated, the auto-confirm
path fails closed at the service's normal consent UI. This source change does
not establish release/adoption or production automatic-consent capability.

The installed `.13` Runtime and the immutable `.14` tag are distinct from this
`.15` source candidate. F09's production assurance gap remains open until the
formal release/adoption and actual environment checks. Candidate regression
coverage reuses `tests/oauth.test.ts` for resource binding, unsupported scopes,
read-only grants, refresh rotation/replay and secret-free persistence;
`tests/consent.test.ts` for current observations, challenge mismatch, one-shot
consumption and replay; `tests/reliability.test.ts` for exact reuse proofs and
ambiguous delivery; and `tests/mcp-integration.test.ts`, `tests/workspace.test.ts`
and `tests/execution-output.test.ts` for containment and filtered output.
Synthetic success does not establish a browser observation producer or a live
provider grant.

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

`bootstrap-custom-c2c.ps1` defaults to `v0.1.3-svl.16`. The updater still reads
`runtime.json`'s ref when `-Ref` is omitted. Both accept optional
`-ExpectedCommit`, `-ExpectedVersion`, and `-ExpectedSkillSha256`; the latter
retains TeamAI's UTF-8/LF-normalized Skill digest meaning. Expected identities
are checked against the Runtime's own fetched candidate before build and again
before activation, independently of a parent's staging inspection.
An existing version checkout is never fetched or checked out in place.
Only an unchanged, already active installation with the same manifest,
launcher and managed Skill is a no-op. This path executes no existing generated
code and makes no claim about the health or authenticity of `dist` or
`node_modules`. A same-commit directory that is not the active installation is
a collision. All new activations use an isolated build and the updater's own
safe Skill installer, including when the fetched candidate has a legacy installer.
Conflicting/dirty version directories, missing provenance, edited `SKILL.md`,
and installed-only Skill content fail closed. Installation failure restores the
previous raw bytes or absence of `SKILL.md`, its source metadata, the launcher,
and `runtime.json`. Rollback only restores files written by this attempt whose
current bytes still equal that write; conflicting edits are preserved.
Every successful write retains a read handle to the actual written file in
the existing in-memory write record until the attempt ends. Existing-file
restoration compares both live file identities and the known write bytes
under its write lock. For originally absent files, rollback compares
the two open handles' Windows volume/file identities and the written bytes
under a DELETE handle that denies writes, deletes and replacements. It releases
the retained reader, marks the checked handle for deletion, closes it, and
confirms absence. It never follows the check with a separate path-based deletion.
Unsupported APIs, conflicting handles, replacement, or unconfirmed absence
fail closed and report partial rollback with residual paths and retained
snapshots. This uses the existing limited rollback rather than a persistent
receipt or transaction journal.
Same-process PowerShell callers may request `-PassThru` on bootstrap/update to
receive the successful attempt's existing in-memory write records, including
live ownership readers. A no-op returns no records; console build output is
separate. The caller must dispose those readers in `finally`, and must use the
returned known write bytes rather than infer ownership from a fresh snapshot.
Originally absent files can be reverted with `C2CFileRollback`'s checked
deletion; byte restoration still requires the existing locked comparison.
Without `-PassThru`, the Runtime releases all readers itself.
A failed restoration reports the affected file and retained
backup directory; unused prepared versions are retained for inspection.
Preferences, OAuth grants, old versions and unrelated user files are untouched.

The TeamAI repository distributes the policy, Codex-only installer, and
bootstrap/update wrappers as control-plane material. The executable Skill
remains in this runtime repository and is never copied into TeamAI's generic
`skills/` directory. TeamAI does not contain this runtime's `node_modules`,
credentials, endpoint URLs, or full source tree.
