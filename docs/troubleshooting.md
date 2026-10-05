# Troubleshooting

First move, always:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Mint the pairing code only when the ChatGPT Authorize form is on screen
(`c2c pair`). After the connector is recreated, doctor being green is not
enough: the saved ChatGPT conversation must pass `workspace_info` again. If
that old chat still cannot read the workspace, open a new chat in the same
Project (or switch long-chat) and continue there.

Supported semantic ChatGPT surfaces for first-time setup and later repair:

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

Prefer the plugin-hub Add → Create custom MCP server capability and verify that
the creation form is actually usable. The deep Add URL above is only a bounded
fallback observation; if it lands on an installed list, classify route drift
and rediscover the semantic capability instead of declaring global
unavailability. The active account/workspace policy, not the historical
Security-page location, decides whether a Developer/custom-app gate exists.

Project display names are limited to 50 characters on the observed creation
surface. Validate or deterministically normalize generated labels before
submission; keep the durable workstream and connector identity separate from
the label and reconcile by verified binding rather than display-name similarity.

Full Auto reconciles an existing Project by machine-observed durable identity
(`projectId`, collection URL, owner account, workspace ID, and exact connector
name). It creates a Project only when no exact identity exists; identity
ambiguity is a bounded Human Boundary, not a reason to guess by display name.
Project settings and the Project Instructions field are distinct from the
reviewer-chat composer. If the semantic settings surface is unavailable,
return `C2C_CAPABILITY_UNAVAILABLE:PROJECT_INSTRUCTIONS`; never send settings
content through the composer.

For `setupMode: auto`, pairing remains automatic with zero routine user
pairing-code actions. If the stronger runtime-only handoff is not proven on the
live ChatGPT OAuth surface, use the bounded automatic compatibility path
(`pairingStrategyOverride=compatibility`) instead of silently switching to
manual setup. Manual setup is reserved for an explicit manual mode or a real
Human Boundary.

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Mint a pairing code with `c2c pair` only
when the Authorize form is on screen.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes. Generate one only
when the ChatGPT Authorize page is ready:

```
c2c pair
```

Older codes become invalid immediately. Do not mint a code during `c2c doctor`.

### Temporary address keeps dropping on a UDP-filtered network
cloudflared defaults to QUIC. If the tunnel reconnects over and over on a
corporate network, set `C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.
Leave it unset to keep cloudflared's default.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Open **Chats**, click the … that appears, and choose
**Organize by project**. Then create a project named after
this workspace, with **project-only memory**. Codex resumes automatically once
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace; Codex verifies the live Project and connector binding
before continuing. Each workspace has its own Project and its own connector.

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
