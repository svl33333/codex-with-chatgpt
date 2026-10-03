# Current OpenAI product research: ChatGPT surface compatibility for a read-only MCP binding

Research date: 2026-10-03 (Asia/Tokyo)

This note records current first-party OpenAI documentation relevant to the
repository's `Codex with ChatGPT` bridge. Sources are limited to the OpenAI
Help Center, OpenAI Developers documentation, and ChatGPT Learn documentation.
The repository documentation was read only for context; no source code was
changed as part of this research.

## Executive summary

The bridge's high-level shape is compatible with the current OpenAI product
model: ChatGPT can call a remote MCP server through a custom app/plugin, and a
server can expose only read tools. OpenAI's current developer-mode guidance
explicitly supports read and write MCP tools, recognizes the MCP
`readOnlyHint` annotation, and treats tools without that hint as write actions
for confirmation purposes.

The main compatibility boundaries are product-surface details rather than the
MCP protocol itself:

1. OpenAI documentation now uses several related terms. An app/MCP server is
   the connected integration; a plugin is a workflow bundle that can contain
   apps/MCP servers and skills. The repository's `connectorName` is best
   treated as a local stable label for one app/MCP-server connection, not as a
   separate OpenAI protocol object.
2. A ChatGPT Project stores chats, instructions, files, and connected sources,
   but it does not automatically grant local-folder access. App selection is
   documented as applying to the message where the app is used, not to the
   whole conversation. Project instructions can name the intended app, but the
   client still needs the app selected or mentioned when a message needs fresh
   MCP data.
3. OAuth is an OpenAI-hosted-client/MCP-resource-server flow. Current guidance
   requires protected-resource and authorization-server metadata, PKCE with
   `S256`, correct `resource` propagation, and per-request token validation.
   Client ID Metadata Documents (CIMD) are preferred when available; Dynamic
   Client Registration (DCR) remains supported. The bridge already has DCR,
   PKCE S256, scopes, bearer checks, and refresh rotation, but its current code
   does not advertise or implement the newer issuer-identification/CIMD path,
   and the OAuth `resource` is not visibly retained in issued token records.
   Those are compatibility items to verify before relying on the newest
   ChatGPT authorization flow.
4. OpenAI calls the in-app surface the “built-in browser” or `@Browser`, not
   “IAB”. It runs in the ChatGPT desktop app with a browser profile separate
   from the user's normal Chrome profile. OpenAI says it is usable from a
   ChatGPT desktop chat in Work or Codex, but not from Codex CLI or the Codex
   IDE extension. `iab` is therefore a repository/automation alias, not a
   public OpenAI contract. The built-in browser is a control/setup surface;
   MCP calls are still server-side remote tool calls.

There are also two current documentation conflicts that require a live account
check: the API developer-mode page lists Plus and Pro as eligible for full MCP
client access, while the Help Center article says full MCP/write support is
rolling out to Business, Enterprise, and Edu and describes Pro as read/fetch in
developer mode. The account's actual Developer mode toggle, workspace policy,
and app-management page should be treated as authoritative for a particular
user.

## Terminology mapping

| Repository wording | Current OpenAI wording | Compatibility implication |
| --- | --- | --- |
| `C2C Bridge`, MCP bridge | Remote MCP server / MCP server connection | The bridge is a remote HTTPS MCP resource from ChatGPT's point of view. OpenAI's server guidance describes the server as the place that defines tools and enforces authorization. |
| ChatGPT “connector” / `connectorName` | Custom app, MCP app, connected app, or an MCP server inside a plugin | The local name should identify one app/MCP connection. Do not assume that a plugin name, project name, and connection name are interchangeable. |
| Plugin/connector setup | Developer-mode custom app or plugin installation plus app authorization | A plugin can package skills and one or more apps. Installing a plugin does not bypass provider authorization or workspace permissions. |
| Read-only MCP | MCP tools annotated with `readOnlyHint: true`, with no write tools exposed | OpenAI's developer-mode client uses `readOnlyHint`; tools without the hint may be treated as write actions. Server-side absence of write endpoints remains the stronger guarantee. |
| One Project per workspace | ChatGPT Project containing chats, instructions, files, and connected sources | A Project is a context container. It is not a local filesystem mount and does not itself prove that the intended MCP app is selected for a message. |
| IAB / built-in in-app browser | Built-in browser, `@Browser`, ChatGPT desktop browser | “IAB” is not a term used by the cited public docs. It can remain an internal automation name, but behavior should be tested against the built-in-browser surface rather than assumed from the alias. |
| Local Codex project | Codex local project / working directory | Codex CLI uses the directory where it starts as its project. That is distinct from a ChatGPT Project and from a ChatGPT custom app connection. |

The clearest first-party terminology statement is the ChatGPT Learn
“Plugin controls” guide: it says that “app” and “MCP server” refer to the same
connected integration, while “app” is retained in UI labels such as Workspace
apps and App permissions. The same page describes plugins as workflow bundles
that may include MCP servers and skills.

Source: [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
(accessed 2026-10-03; page does not show an update date).

## Custom MCP apps and Developer mode

### What the current docs say

The API developer-mode guide describes ChatGPT Developer mode as full MCP client
support for both read and write tools. It says a user enables Developer mode in
ChatGPT Settings, creates a developer-mode app for a remote MCP server, and
then selects the app from the Developer mode/Plus menu in a conversation. It
lists SSE and streaming HTTP as supported MCP transports and OAuth, no-auth,
and mixed authentication as supported choices. It also says that
`search`/`fetch` tool names are not required in developer mode.

The Help Center's “Developer mode and MCP apps in ChatGPT” article describes a
workspace-oriented flow: provide an endpoint and metadata, choose an
authentication mechanism, run “Scan Tools”, complete OAuth if requested, and
create a draft app. The draft can then be tested in a new chat and published
by an administrator/owner. Enterprise/Edu workspaces can use role-based
access and action controls. The article warns that full MCP, including write
actions, is rolling out in beta and that UI and permissions may change.

After an administrator first approves an MCP app, the Help Center says ChatGPT
uses a frozen snapshot of its available tools and inputs. Tool changes are not
automatically applied; an administrator must refresh/review and publish an
update. A non-backward-compatible live tool definition can therefore produce
errors until the app is refreshed.

Sources:

- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
  (accessed 2026-10-03; page does not show an update date).
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
  (updated “last month” at retrieval; accessed 2026-10-03).

### Read-only implications

The API developer-mode guide says write actions require confirmation by default
and that read-only detection respects the MCP `readOnlyHint` annotation; tools
without the annotation are treated as write actions. It also says that the
developer-mode client can call any tools the app exposes, subject to the
configured confirmation settings. Consequently:

- Keep the server's tool set read-only by construction. A prompt or project
  instruction cannot make an omitted write endpoint appear safe.
- Set `annotations: { readOnlyHint: true }` on every tool that truly cannot
  change state. The current `src/mcp/server.ts` already does this for its nine
  tools.
- Treat the annotation as a client-facing classification, not an authorization
  boundary. OpenAI's security guidance says a malicious or incorrectly
  annotated MCP can still cause data exposure, so the server must enforce path,
  scope, and workspace checks itself.
- For managed workspaces, action controls and app permissions are separate:
  action controls decide which actions exist, while app permissions decide when
  ChatGPT asks for approval. “Allow read actions” does not grant provider
  access that the connected account did not already have.

Sources:

- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
  (accessed 2026-10-03).
- [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
  (accessed 2026-10-03).
- [Managing app permissions in ChatGPT](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt)
  (updated 3 hours ago at retrieval; accessed 2026-10-03).

### Remote endpoint requirement

The Help Center FAQ says ChatGPT does not connect directly to a local MCP
server; it connects to remote MCP servers. For a private, on-premises, or
developer-machine server, OpenAI documents Secure MCP Tunnel as an option. The
tunnel guide makes clear that tunnel permissions and ChatGPT Developer mode
permissions are separate, and the target ChatGPT workspace must be associated
with the tunnel. The repository's public HTTPS Cloudflare tunnel is therefore
within the documented remote-server shape; a loopback-only MCP endpoint by
itself is not.

Sources:

- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
  (accessed 2026-10-03).
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
  (accessed 2026-10-03).

## OAuth and authorization

### OpenAI's current MCP authorization contract

OpenAI's plugin authentication guide describes three parties:

1. The MCP server is the resource server and must verify access tokens on every
   request.
2. The identity provider or custom authorization service is the authorization
   server and publishes discovery metadata.
3. ChatGPT or Codex is the OpenAI host/client acting for the user.

For authenticated MCP servers, the guide expects an OAuth 2.1 flow conforming to
the MCP authorization specification. The documented requirements are:

- A protected-resource metadata endpoint on the MCP server, commonly
  `/.well-known/oauth-protected-resource` (or a `WWW-Authenticate` pointer on
  a 401 response).
- Authorization-server discovery metadata, including authorization and token
  endpoints and supported PKCE method.
- The `resource` value echoed through the authorization and token requests and
  represented in the issued token (commonly as `aud`) so the resource server
  can reject a token minted for a different resource.
- Client registration by CIMD, DCR, or a predefined client. CIMD is preferred
  when supported; DCR remains supported.
- Authorization-code flow with PKCE using `S256`.
- Bearer access tokens on subsequent MCP requests and server-side checks for
  issuer, audience/resource, expiry, and scopes.

When issuer identification (RFC 9207) is advertised, the authorization server
must return an exact matching `iss` parameter in successful and error
authorization responses. The documented redirect choices are:

- `https://chatgpt.com/connector_platform_oauth_redirect` when issuer
  identification requirements are met.
- `https://chatgpt.com/connector/oauth/{callback_id}` when they are not met.

The management page is the source of truth for the exact production redirect
URI to allowlist. The OAuth flow starts when the user first invokes a tool:
ChatGPT discovers metadata, identifies/registers itself, sends the user through
authorization and consent, exchanges the code, then attaches the bearer token
to MCP requests.

OpenAI's ChatGPT Help article separately warns that providers should issue
refresh tokens when a connection must survive the original authorization. For
OpenID Connect, it specifically points to `offline_access` and discovery
metadata advertising that scope. Without refresh support, ChatGPT may lose
access after the original authorization expires and require reauthorization.

Sources:

- [Authentication – Plugins](https://developers.openai.com/plugins/build/auth)
  (accessed 2026-10-03).
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
  (updated “last month” at retrieval; accessed 2026-10-03).

### Comparison with the current bridge implementation

This is a research comparison, not a request to modify code:

| OpenAI requirement or behavior | Current bridge evidence | Finding |
| --- | --- | --- |
| Read-only tool classification | Every tool registration in `src/mcp/server.ts` has `readOnlyHint: true`; no write/exec tool is registered. | Aligned. Keep the annotation on future tools and ensure their behavior remains genuinely read-only. |
| Protected-resource metadata and 401 challenge | `src/auth/oauth.ts` serves protected-resource metadata; `src/auth/middleware.ts` emits `WWW-Authenticate` with a `resource_metadata` pointer. | Aligned in shape. Test the exact deployed HTTPS URL and metadata path through the tunnel. |
| Authorization-code + PKCE S256 | `src/auth/oauth.ts` requires `code_challenge_method=S256`; tests cover verifier mismatch and one-time code use. | Aligned. |
| DCR | `/oauth/register` is implemented and the authorization endpoint requires a registered client. | Compatible with OpenAI's still-supported DCR mode, but the newest docs prefer CIMD when available. |
| Issuer identification / stable callback | Authorization-server metadata does not advertise `authorization_response_iss_parameter_supported`, and authorization responses do not visibly include `iss`. | The current code appears to target the callback-ID-specific/non-issuer path. This should be verified against the current ChatGPT app-management flow rather than assuming the stable callback path. |
| `resource` propagation and audience binding | The authorization request's `resource` is stored on the authorization-code record, but the visible token record/`issueTokens` path does not retain or validate a resource/audience value. | Compatibility risk. The current workspace binding is strong, but OpenAI's current contract expects the resource to survive token issuance and be checked by the resource server. Confirm or harden this in a separate implementation task. |
| Refresh continuity | `offline_access` is a supported scope and refresh tokens are rotated. | Aligned with the provider-refresh guidance, assuming the client requests `offline_access` and the deployed metadata remains accurate. |
| Per-request authorization | MCP middleware checks bearer token validity, workspace ID, and tool scopes. | Aligned with the requirement that the resource server, not the model, enforces authorization. |

The `resource` item is an evidence-based compatibility concern, not proof that
the opaque-token design is unusable. An opaque authorization server could bind
the resource internally instead of exposing an `aud` claim, but the current
code should make that binding explicit and test it against the deployed
ChatGPT client.

## Projects, connected apps, and app selection

### ChatGPT Projects are context containers

The Help Center says a Project groups related chats, files, and instructions;
Project instructions apply only within that Project and override global custom
instructions. It also documents connected apps in Project chats: use the `+`
tools menu to choose an app or refer to the app by name, and ChatGPT may ask for
confirmation before searching outside the Project.

The newer ChatGPT Learn “Projects and chats” page distinguishes a ChatGPT
Project from a local Codex project:

- A ChatGPT Project shares uploaded files, Project instructions, and connected
  sources across its chats.
- A ChatGPT Project does not provide direct access to a folder on the computer;
  sources must be uploaded or connected.
- Codex CLI uses the directory where it starts (or `--cd`/`-C`) as the local
  project and does not expose the ChatGPT Projects view.
- The IDE extension uses its open folder/workspace as the local project and
  also does not expose the ChatGPT Projects view from the web or desktop app.

For this repository, the remote read-only MCP bridge is the connected source
that supplies local workspace data to ChatGPT. It should not be described as
ChatGPT having direct filesystem access or as the ChatGPT Project itself being
the security boundary.

Sources:

- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
  (updated 13 days ago at retrieval; accessed 2026-10-03).
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
  (accessed 2026-10-03).

### App selection is not a conversation-wide binding

The Developer mode Help article explicitly says that app selection applies to
the message where the app is used, not the entire conversation. A follow-up
that needs new data or another app action should mention/select the app again.
The connected-apps article likewise documents selecting an app from `+` or
mentioning it with `@` in a supported conversation.

This matters for the repository's Project and conversation registry:

- A Project instruction naming the expected connector is useful for intent and
  human review, but it does not itself force ChatGPT to call that app.
- A new C2C chat should explicitly select or mention the intended app before
  the `workspace_info` verification call.
- Follow-up messages that require fresh file/diff/test data should reselect or
  mention the app. Do not use a successful prior tool call as proof that the
  app is still selected for the next message.
- Existing app results may be discussed without reselection, but a new MCP
  action/data fetch is the case that needs explicit selection.

Sources:

- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
  (accessed 2026-10-03).
- [Connected apps in ChatGPT](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt)
  (updated 2 days ago at retrieval; accessed 2026-10-03).
- [Connecting and managing app accounts in ChatGPT](https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt)
  (updated 2 hours ago at retrieval; accessed 2026-10-03).

### Authorization layers must remain separate

OpenAI's current docs separate the following checks:

1. Plugin availability/installation.
2. MCP server/app availability for the workspace and role.
3. Provider-account authorization and the provider's own scopes.
4. App action controls (which read/write actions are allowed).
5. App permissions (when ChatGPT asks before an available action).
6. Runtime permissions and approvals on the active ChatGPT/Codex surface.

Installing a plugin or enabling an app does not grant provider access that the
connected account lacks. Conversely, changing an app permission changes the
approval behavior but does not disconnect the account or revoke provider
access. This supports keeping the bridge's server-side scopes and workspace
audience checks even when the app is configured to “Allow read actions”.

Source: [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
(accessed 2026-10-03).

## Built-in browser / “IAB” behavior

### What OpenAI documents

The Help Center calls the surface the “built-in browser in the ChatGPT desktop
app”. It says:

- It is available in the ChatGPT desktop app on macOS and Windows.
- A user can open a chat in Work or Codex, open the browser from the toolbar,
  and follow permission prompts.
- The user and ChatGPT see the same page; the browser can use multiple tabs,
  downloads, and sign-in flows.
- The built-in browser uses its own browser state. It does not use the user's
  existing Chrome profile, cookies, tabs, or signed-in session.
- Use the Codex Chrome extension instead when a task explicitly needs an
  existing Chrome profile/session or Chrome extensions.
- Credentials should be entered in the browser, never in chat, and the active
  account should be reviewed before allowing ChatGPT to continue.

The ChatGPT Learn Browser page adds that the built-in browser is not available
in Codex CLI or the Codex IDE extension; the ChatGPT desktop app is required.
It calls the surface `@Browser`, documents a shared view and separate profile,
and says that ChatGPT asks before using a new website or sensitive actions.
Browser Developer mode/full CDP is a separate elevated-risk setting and is not
needed for ordinary MCP app authorization.

Sources:

- [Using the built-in browser in the ChatGPT desktop app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)
  (updated 13 hours ago at retrieval; accessed 2026-10-03).
- [Browser](https://learn.chatgpt.com/docs/browser?surface=app)
  (accessed 2026-10-03).

### Implications for this repository

- `iab` should be documented as an internal automation alias for OpenAI's
  built-in browser, not as an OpenAI API or MCP term.
- The repository's “built-in browser only” policy is a deliberate safety and
  workflow policy. OpenAI's public docs support both the built-in browser and
  the Codex Chrome extension; they do not impose the repository's stronger
  IAB-only rule.
- Browser navigation is a setup/control-plane concern: enabling Developer mode,
  creating an app, signing in, and completing the pairing/authorization page.
  The data-plane MCP request is a remote HTTPS request from ChatGPT to the
  server and should not rely on browser DOM state, browser cookies, or an open
  tab after authorization.
- The separate browser profile means a user may need to sign in in the built-in
  browser even when they are signed in to regular Chrome. Do not claim that
  IAB automatically reuses the user's existing ChatGPT or provider session.
- OpenAI's docs explain the OAuth MCP flow and the built-in browser separately;
  they do not guarantee that every custom-MCP authorization prompt will use a
  particular embedded-browser implementation. The exact flow remains a
  surface/rollout detail and should be verified live.

## Surface and availability matrix

| Surface | What first-party docs support | Consequence for the bridge |
| --- | --- | --- |
| ChatGPT web | Developer-mode custom apps and remote MCP are documented, but Help Center availability is workspace/plan dependent. Apps can be selected from the composer/`+` menu or mentioned. | The web conversation is the primary intended ChatGPT consumer; verify the account's Developer mode and workspace policy. |
| ChatGPT desktop app | Built-in browser, ChatGPT/Codex chats, plugins, and local MCP/plugin experiences are documented. | This is the surface on which the repository's IAB-only setup policy can operate. |
| Codex in ChatGPT desktop | Plugins can be selected from Sources → Use plugins; Codex has local project context and local MCP settings. | Do not confuse a Codex local MCP setting with the ChatGPT web custom-app binding. |
| Codex CLI | Local MCP configuration and a CLI plugin browser are documented; the ChatGPT Projects view and built-in Browser are not. | The CLI can run the coding harness but is not the target UI for ChatGPT connector setup. |
| Codex IDE extension | Local MCP configuration is shared via `config.toml`; the plugin-controls guide says plugins are not available in the IDE extension. The built-in Browser is not available. | Keep ChatGPT-app setup and IDE/CLI MCP configuration as separate concerns. |
| ChatGPT mobile | The plugin directory is available on supported surfaces, but the Developer mode Help article says MCP apps are web-only. | Do not promise that a custom Developer-mode MCP app can be created or used from mobile. |

Sources:

- [Plugins in ChatGPT](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt)
  (updated 24 hours ago at retrieval; accessed 2026-10-03).
- [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
  (accessed 2026-10-03).
- [Developer settings](https://learn.chatgpt.com/docs/developer-settings)
  (accessed 2026-10-03).
- [Browser](https://learn.chatgpt.com/docs/browser?surface=app)
  (accessed 2026-10-03).

## Current uncertainties and conflicts

1. **Plan eligibility conflict.** The API developer-mode page currently lists
   Plus, Pro, Business, Enterprise, and Education accounts as eligible for full
   MCP client access. The Help Center article says full MCP/write support is
   rolling out in beta to Business, Enterprise, and Edu, and its FAQ says Pro
   users have read/fetch MCP in Developer mode. This may reflect different
   rollouts or a difference between API/client capability and workspace custom
   app policy. Check the actual account UI and workspace admin settings.
2. **Apps versus Plugins versus Connectors.** Current pages use all three
   families of labels: Help Center app pages, a Plugins directory, and
   workspace “apps”/MCP-server controls. The stable semantic mapping is the
   Learn guide's: app and MCP server are the connected integration; plugin is
   the bundle. Exact navigation labels are rollout- and workspace-dependent.
3. **OAuth callback mode.** The latest auth guide documents both stable and
   callback-ID-specific redirects, with the exact choice depending on issuer
   metadata and the app's client-registration mode. Do not hard-code a callback
   solely from an older setup guide; copy the production redirect shown by the
   current app-management page.
4. **IAB is not official terminology.** The cited docs call the surface
   “built-in browser” and `@Browser`. The repository may keep `iab` as an
   internal identifier, but no compatibility guarantee should be inferred from
   that name.
5. **OAuth UI/browser coupling is unspecified.** OpenAI documents the MCP OAuth
   protocol and the built-in browser independently. The public docs do not say
   that every custom-app OAuth prompt must use the built-in browser profile or
   that it must use an external browser. Treat the repository's IAB-only choice
   as local policy and validate the actual desktop-app flow.
6. **Frozen tool snapshots.** A successful app connection does not prove that a
   later tool-schema change is live. Refresh/review/publish is a separate
   lifecycle step, and the current approved snapshot can reject incompatible
   calls.

## Recommended compatibility checks for the parent task

These are follow-up checks, not changes made in this research task:

- Verify a live custom-app connection from the current ChatGPT surface using
  the exact deployed HTTPS `/mcp` endpoint and the current management-page
  redirect URI.
- Confirm that all nine tools remain annotated `readOnlyHint: true` and that
  the app/workspace action controls expose only read actions.
- Exercise `workspace_info` after explicitly selecting/mentioning the app in a
  new Project chat, then repeat after a follow-up message that needs new data.
- Verify the deployed OAuth metadata and token flow with `resource` present in
  authorization and token requests, and verify that a token cannot be replayed
  against another MCP resource/workspace.
- Test both DCR (currently implemented) and, if the current app chooses it,
  CIMD/issuer-identification behavior. Do not assume that DCR tests prove the
  stable callback path.
- Test refresh after the access-token TTL and confirm that the provider/app
  requests or advertises `offline_access` when continuity across sessions is a
  requirement.
- After any tool metadata change, refresh the app and re-run the tool scan;
  avoid treating a cached/frozen app snapshot as current.
- Keep the browser setup check separate from MCP authorization checks: a
  successful IAB page navigation does not prove that the remote MCP endpoint
  has a valid bearer token, and a successful MCP call does not prove the
  built-in browser is signed in to the intended account.

## First-party source ledger

The following URLs were consulted directly on 2026-10-03. “Updated” is the
date/relative label displayed by the source at retrieval; developer and Learn
pages did not expose a reliable update date in the fetched page.

| Source | URL | Displayed update / access date | Main use |
| --- | --- | --- | --- |
| ChatGPT Developer mode | [developers.openai.com/api/docs/guides/developer-mode](https://developers.openai.com/api/docs/guides/developer-mode) | Update not shown; accessed 2026-10-03 | Full MCP client, plan list, transports/auth modes, app selection, `readOnlyHint`, confirmations. |
| Developer mode and MCP apps in ChatGPT | [help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | Updated last month; accessed 2026-10-03 | Workspace setup, Scan Tools, OAuth, app selection per message, frozen snapshots, plan/rollout FAQ. |
| Connected apps in ChatGPT | [help.openai.com/en/articles/11487775-connected-apps-in-chatgpt](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt) | Updated 2 days ago; accessed 2026-10-03 | App setup, `+`/`@` selection, permissions, connected account boundaries. |
| Connecting and managing app accounts | [help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt](https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt) | Updated 2 hours ago; accessed 2026-10-03 | Provider authorization, account selection, reconnect/disconnect. |
| Managing app permissions | [help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt) | Updated 3 hours ago; accessed 2026-10-03 | Allow read actions versus action approval and workspace restrictions. |
| Projects in ChatGPT | [help.openai.com/en/articles/10169521-projects-in-chatgpt](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) | Updated 13 days ago; accessed 2026-10-03 | Project instructions, connected apps, external-search confirmation. |
| Projects and chats | [learn.chatgpt.com/docs/projects](https://learn.chatgpt.com/docs/projects) | Update not shown; accessed 2026-10-03 | ChatGPT Project versus local Codex project and local-folder access. |
| Plugins in ChatGPT | [help.openai.com/en/articles/20001256-plugins-in-chatgpt](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt) | Updated 24 hours ago; accessed 2026-10-03 | Plugin/app distinction, Codex Sources → Use plugins, local MCP app limits. |
| Plugin controls | [learn.chatgpt.com/docs/enterprise/apps-and-connectors](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors) | Update not shown; accessed 2026-10-03 | App/MCP-server equivalence, surface matrix, capability/permission layers. |
| Authentication – Plugins | [developers.openai.com/plugins/build/auth](https://developers.openai.com/plugins/build/auth) | Update not shown; accessed 2026-10-03 | OAuth 2.1, protected-resource metadata, CIMD/DCR, issuer, redirect, PKCE, resource, refresh. |
| Build an MCP server | [developers.openai.com/plugins/build/mcp-server](https://developers.openai.com/plugins/build/mcp-server) | Update not shown; accessed 2026-10-03 | Resource-server authorization and read-only tool annotations. |
| Building MCP servers for plugins/API integrations | [developers.openai.com/api/docs/mcp](https://developers.openai.com/api/docs/mcp) | Update not shown; accessed 2026-10-03 | Remote MCP, read-only search/fetch compatibility, API-side MCP behavior. |
| Secure MCP Tunnel | [developers.openai.com/api/docs/guides/secure-mcp-tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) | Update not shown; accessed 2026-10-03 | Private/developer-machine MCP and separate tunnel/workspace permissions. |
| Built-in browser Help article | [help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app) | Updated 13 hours ago; accessed 2026-10-03 | Desktop browser availability, separate state, sign-in, approvals, Chrome distinction. |
| Browser | [learn.chatgpt.com/docs/browser?surface=app](https://learn.chatgpt.com/docs/browser?surface=app) | Update not shown; accessed 2026-10-03 | `@Browser`, Codex desktop/CLI/IDE boundaries, browser profile, CDP risk. |
| Developer settings | [learn.chatgpt.com/docs/developer-settings](https://learn.chatgpt.com/docs/developer-settings) | Update not shown; accessed 2026-10-03 | Codex MCP config/OAuth settings and browser Developer mode distinction. |

