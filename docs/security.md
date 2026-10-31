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
| Consent replay / TOCTOU | `c2c consent prepare` registers a bounded non-secret challenge and `c2c consent decide` atomically consumes it before `AUTO_CONFIRM`; replay, expiry, changed binding/account/surface/scope, and concurrent second use fail closed. |
| ChatGPT route drift | `/plugins` app-shell → clear inherited filter → Add → Create custom MCP server is the normal creation route. Settings is management/recovery-only; a historical deep-link redirect is recoverable route drift, not capability absence. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Explicit unknown or write scopes are rejected rather than
silently expanded. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. Tokens are bound to
`workspace_id`, `client_id`, and (when issued through OAuth) the canonical MCP
resource/audience; bearer middleware rejects a mismatched resource.

An omitted or blank authorization scope request uses all five scopes above.
The consent page displays those actual requested scopes, including continued
access through `offline_access`; displaying the page alone issues no tokens.
Explicit narrower requests remain unchanged. Malformed non-string scope
inputs and requests containing unknown scopes use the existing `invalid_scope`
refusal instead of falling back to the default.

Existing access tokens and stored grants are never rewritten by this default.
A `workspace.read git.read` grant has no refresh token and cannot search or
read execution output. A narrower grant that explicitly includes
`offline_access` can refresh only its original scope set. Rotation does not
add scopes requested at the refresh endpoint. `offline_access` grants no MCP
read, write, shell, test execution, commit, or administrative capability by
itself; `execution.read` only reads allowed, sanitized saved output.

Expanding an existing App requires the same App's supported OAuth
reauthorization and actual provider consent, including login, MFA, CAPTCHA,
and account selection when required. Preserve the App/workspace/repository/
endpoint binding and verify the actual requested and effective scopes.
If that provider flow is unavailable, record the limitation; do not create
another App or modify stored credentials to bypass it. Synthetic OAuth and
consent tests do not demonstrate a live grant or provider consent.

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

Automatic consent has a separate runtime authority. The expected account is
read only from the machine-verified `ConnectionBinding.accountFingerprint`;
legacy bindings without that field cannot auto-confirm and are never
browser-backfilled. Before consent preparation, the authenticated
ChatGPT/account surface must provide a current exact-binding observation to
`c2c consent verify-account`; the runtime persists only the verified fingerprint
and fails closed for missing, stale, mismatched, or caller-supplied authority.
The challenge registry stores only an opaque id, binding digest, account
fingerprint, timestamps, and consumed state; it never stores OAuth tokens,
pairing values, cookies, endpoint URLs, DOM, or message bodies. A live challenge
is terminalized on the first valid decision attempt, including a failed
decision, so invalid evidence cannot be corrected and replayed.

The observation's top-level `challengeId` must come independently from the
current consent attempt and equal the registered challenge. The CLI never
fills it from the request's `--challenge-id`; missing, malformed, or mismatched
values fail closed after that challenge is terminalized, without consuming a
different observed challenge. A matching string alone does not prove its UI
origin. A live ChatGPT UI correlation producer has not been established here.
Do not copy prepare output or request parameters into observation JSON to
obtain AUTO_CONFIRM. Until trusted independent correlation is demonstrated,
this auto-confirm path stays fail closed at the normal service consent UI.
Synthetic CLI/core fixtures do not demonstrate live UI or production capability.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Delegated authorization

A1 delegation grants are separate owner-only records under the machine state
directory. They contain bounded identifiers and SHA-256 digests, never control
message text, credentials, tokens, or endpoint material. Strict raw JSON
parsing rejects duplicate keys and malformed records before ordinary object
construction; unsupported records fail closed and remain available for
diagnosis.

The policy classifier derives the route from a closed action vocabulary. A
caller cannot bypass delegation by omitting or setting a `delegationRequired`
flag. `workspace_read` is local and bounded: it does not authenticate to
GitHub or invoke the TeamAI `github-cli-auth` resolver. Provider evidence is
required only for a known persisted operation whose policy-owned reconciliation
path is explicitly provider-bound. Transport still requires the canonical A0
issuer, binding, receipt, visible-evidence, and no-blind-resend checks.

Grant leases are owner-checked and injectable-clock driven. A stale lock is
reclaimed only when its recorded process is dead; age alone never reclaims a
live owner. Exact grant expiry is `notBefore <= now < expiresAt`.

Dead-owner recovery takes an exclusive same-filesystem hardlink claim before
removing the old lease. An unavailable hardlink, unknown process liveness, or
an orphaned recovery claim keeps the lease locked. Reconcile such claims only
while the participating writers are quiescent. All concurrent writers must
use this claim protocol; older binaries with unguarded stale removal cannot
safely share these records during adoption. Source integration does not
activate or migrate an installed consumer.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
