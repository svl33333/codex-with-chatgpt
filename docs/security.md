# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** The normal automatic
   compatibility path uses only a short-lived, one-use pairing value bound to
   the exact OAuth request; a stronger runtime-only handoff may avoid browser
   custody when it has real product E2E proof. Access/refresh tokens travel
   only inside the OAuth redirect/token endpoints between ChatGPT's client and
   the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |
| Pairing request confusion | Bound pairing sessions compare workspace, connector/installation, endpoint origin, OAuth request/client/redirect/resource/PKCE, and scopes before consuming; mismatches fail closed without consuming the valid session. |
| Project surface confusion | Project creation, collection, settings, Instructions, reviewer composer, connector configuration, and OAuth pairing are separate semantic surfaces. Instructions are never sent through the reviewer composer. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Explicit unknown or write scopes are rejected rather than
silently expanded. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. Tokens are bound to
`workspace_id`, `client_id`, and (when issued through OAuth) the canonical MCP
resource/audience; bearer middleware rejects a mismatched resource.

Current-message app selection is a separate trust fact from persistent Project
binding. A fresh MCP request must record exact app selection and reuse the
delivery message idempotency identity; a previous successful invocation cannot
authorize a different or unselected app.

The reviewer proof for a fresh MCP-dependent message must also include the
exact workspace ID, connector identity, read-only capability, repository,
workspace root, branch, full current HEAD, `workspace_info`, `git_status`, and
the required `git_diff`. A missing or mismatched proof is a fail-closed
`WORKSPACE_MISMATCH`, not a reason to repoint another connector.

The production Skill builds this proof with `c2c reviewer-proof build` from
one runtime-only evidence bundle returned by the explicitly selected
connector. The bundle must contain the current message identity and the
machine-observed `workspace_info`, `git_status`, and complete `git_diff`; it
must never be synthesized from local Git or a prose summary. The resulting
proof is passed unchanged to both `c2c app-selection record` and
`c2c provisioning set --phase ready`, then the temporary evidence/proof files
are removed. Only the non-secret message-keyed state is retained.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Machine defaults/overrides are public policy values in `prefs.json`;
named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Cloudflare certificates,
installation identity, connector tokens, pairing codes, cookies, and live
endpoint state remain machine/workspace local and are never copied to TeamAI.
Only SHA-256 hashes of tokens are persisted — a stolen state file does not yield
usable bearer tokens.

Ephemeral pairing values are not persisted in repository files, checkpoints,
logs, screenshots, fixtures, Project memory, or normal chat. Project display
labels are limited to 50 characters and are never durable workspace identity;
identity reconciliation uses machine-observed IDs and connector ownership.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
