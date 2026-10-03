# A0 ChatGPT Surface Compatibility Maintenance — implementation plan draft

- Repository: `svl33333/codex-with-chatgpt`
- Issue: [#11](https://github.com/svl33333/codex-with-chatgpt/issues/11)
- Workstream: `a0-chatgpt-surface-compatibility`
- Branch: `a0-chatgpt-surface-compatibility`
- Base/head at planning start: `d030a196a8cb3ed4fca4573c174ebf7fa47c720c`
- Workflow: `codex-c2c-v2` 2.3.1, pinned at
  `60d17218c256098522e063b5bf4731cecc9c1f12`
- Scope: A0 provisioning/recovery compatibility only. No A2 source
  implementation, A3/A4 orchestration, publication, or merge.

This is a plan draft. It does not authorize source changes. The live Issue is
the requirements source of truth; the approved local requirements and product
research records provide provenance and evidence links.

## 1. Current implementation and confirmed gaps

### Existing foundations to preserve

- `src/connection/identity.ts` canonicalizes the repository without embedded
  credentials, persists one machine-local installation identity, fingerprints
  endpoints, and binds workspace/repository/installation/name.
- `src/connection/reconciler.ts` serializes operations per workspace and
  installation, reuses an exact endpoint with zero mutations, protects
  same-name foreign bindings, verifies `workspace_info`, checkpoints delete
  and create mutations, verifies absence before recreate, and reconciles an
  ambiguous create result before retrying.
- `src/provisioning/state.ts` persists bounded machine-local phases and
  distinguishes local readiness, authorization, repair, and human/security
  boundaries without storing tokens or chat bodies.
- `src/auth/oauth.ts`, `src/auth/store.ts`, and `src/auth/middleware.ts`
  already implement protected-resource/authorization-server discovery,
  DCR, authorization-code flow, PKCE S256, bearer validation, scoped tools,
  refresh rotation, revocation, and pairing-code authorization.
- `src/mcp/server.ts` exposes nine read-only tools and annotates each with
  `readOnlyHint: true`; server-side path, workspace, and scope checks remain
  the real authorization boundary.
- `src/tunnel/` and `src/bridge/server.ts` preserve named/quick endpoint
  state, loopback-only binding, runtime-only credentials, and endpoint
  recovery without changing logical connector names.
- Existing tests cover exact reuse, creation, duplicate-name protection,
  endpoint replacement, uncertain delete/create, installation separation,
  OAuth PKCE/refresh/revocation, read-only MCP tool behavior, and bounded
  provisioning state.

### Compatibility defects to address

1. `src/config/endpoint.ts`, `src/cli/index.ts`, `skill/SKILL.md`, and
   `docs/troubleshooting.md` model one historical deep create URL and the
   Security-page Developer mode location. They cannot represent a preferred
   plugin-hub route, a verified fallback, route drift, or a current
   account/workspace policy gate.
2. The Skill states built-in IAB is the only supported browser surface and
   forbids semantic plugin-hub discovery. This is a local safety policy, not a
   current first-party product requirement; the compatibility contract needs a
   preferred built-in-browser route plus an explicitly constrained officially
   supported authenticated-browser fallback.
3. The reconciler adapter has no account-context, explicit read-only proof,
   selected-surface, or current-message app-selection evidence. A successful
   project binding or prior MCP call can therefore be mistaken for current
   app availability.
4. OAuth metadata is derived from the request host unless a tunnel URL is
   already set. Authorization records retain `resource`, but token records do
   not retain or validate it. The bridge advertises no issuer-identification
   response behavior, has DCR only, accepts any HTTPS redirect at registration,
   and filters unknown scopes by silently falling back to all supported scopes.
   These behaviors must be compared with the exact current ChatGPT app flow;
   no mechanism migration is made unless the selected flow requires it.
5. The CLI doctor output reports fixed pages rather than semantic capability
   observations, and legacy `developerModeEnabled` is treated as a universal
   prerequisite by the Skill even though the observed Security page is stale.

## 2. Design goals and invariants

The implementation will preserve the following invariants:

- One exact binding is selected before any mutation: account/workspace proof,
  workspace ID/name, canonical repository, branch/worktree identity,
  installation/workstream identity, endpoint mode/fingerprint, connector
  label, Project/reviewer identity, and the current app-selection evidence.
- A same-name or same-repository foreign binding is a conflict and remains
  untouched. Existing resources are reconciled before creation. Ambiguous
  create/delete results never trigger a blind duplicate.
- The C2C connector exposes only read operations. Explicit write scopes,
  unexpected scopes, or a mismatched resource/audience fail closed.
- Route failure is classified as route drift/recoverable failure while another
  supported route remains. `REQUIRED_CAPABILITY_UNAVAILABLE` is emitted only
  after every supported route and required policy gate has been observed as
  unavailable.
- Persistent logical binding, current-message app/tool selection, and a
  successful current MCP invocation are separate facts. A fresh MCP-dependent
  message must select or mention the exact app as required by the product.
- ChatGPT Project display names are a bounded product field, not a durable
  identity. The observed creation surface accepts at most 50 characters, so
  generated names must be validated or deterministically normalized before
  submission. Normalization preserves the separate workstream identity,
  avoids collisions through workspace/connector binding, and never uses the
  display name alone as authorization or ownership proof.
- Runtime-only account IDs, app IDs, client IDs, redirect URIs, endpoint URLs,
  OAuth credentials, tokens, cookies, pairing codes, and machine paths remain
  outside committed artifacts. Committed evidence contains only logical IDs,
  redacted hashes, phases, and bounded reasons.

## 3. Proposed architecture and file-level changes

### 3.1 Semantic ChatGPT surface model

Add a small adapter-level surface model (prefer a new
`src/provisioning/chatgpt-surface.ts`; keep `src/config/endpoint.ts` as the
stable endpoint/name utility) with:

- `ChatGPTSurfaceId` values for the current plugin hub custom-MCP flow, a
  verified settings/developer-app flow, and supported browser profile routes;
- route descriptors containing a semantic capability (`create_app`,
  `authorize`, `select_app`, `verify_project`, `verify_account`), route
  preference, and legacy/deprecated marker rather than a button-label contract;
- a `SurfaceObservation` record containing only route ID, origin, account and
  workspace proof status, capability status, developer/custom-app policy
  status, browser capability status, and sanitized reason;
- a deterministic selector that tries the preferred plugin-hub capability,
  verifies that the creation form is actually usable, then tries supported
  fallbacks. A stale deep-link response is `ROUTE_DRIFT`, not global
  capability absence;
- bounded outcomes `REUSED`, `CREATED`, `RECOVERED`, `HUMAN_BOUNDARY`,
  `RECOVERABLE_FAILURE`, and `REQUIRED_CAPABILITY_UNAVAILABLE`, with one next
  action and no acknowledgement-only stop for ordinary setup controls;
- an adapter interface for DOM/state-aware browser operations. The interface
  must never expose credentials or require screenshot coordinates, and it must
  leave login, CAPTCHA, unsupported 2FA, ambiguous SSO, unexpected consent,
  and security-sensitive account changes as Human Boundaries.

Keep the historical URL exports as deprecated compatibility aliases only when
callers need them; mark them as fallback candidates and never infer product
capability from their failure.

### 3.2 Exact identity and connector reconciliation

Extend `src/connection/identity.ts` and `src/connection/reconciler.ts` with a
backward-compatible schema migration (old schema remains readable) for:

- a runtime-only account/ownership fingerprint and selected ChatGPT surface;
- a read-only permission profile/capability proof and the last sanitized
  `workspace_info` verification result;
- exact Project/reviewer identity when available, without persisting private
  URLs or opaque provider IDs in committed state;
- an explicit connector record identity source and endpoint binding version.

Project display-name compatibility belongs beside this binding layer rather
than in the resource identity itself:

- validate the generated display name against the current 50-character
  surface limit before opening the creation form;
- apply one deterministic, collision-safe bounded replacement when the
  historical generated value exceeds that limit, while retaining the full
  workstream identity in the local binding record;
- reconcile by verified workspace, repository, installation, connector, and
  Project context; never treat a similar display name as equivalence.

Expand `ConnectionAdapter`/`ConnectorRecord` with optional evidence fields so
legacy adapters remain usable when the product omits a field, but a live
readiness result cannot claim proof when the product explicitly reports a
different account, workspace, repository, permission set, or app. Reuse the
existing operation key and lock. Add reconciliation phases for surface
preflight and permission/account verification rather than bypassing existing
delete/absence/create checkpoints. Preserve the connector name during endpoint
replacement and return a distinct recovery outcome.

### 3.3 Provisioning and reviewer-message state

Extend `src/provisioning/state.ts` with a versioned, migrated record for:

- selected surface and last observation status;
- bounded outcome/reason/next action and retry/reconciliation counters;
- account/workspace proof status, read-only proof status, and OAuth contract
  verification status;
- persistent reviewer binding versus current-message app-selection evidence;
- the last successful `workspace_info`/`git_status` verification hash/status.

Keep the existing phases and add only the minimal states needed to distinguish
`route_drift`, `oauth_contract_mismatch`, `browser_unavailable`,
`human_boundary`, and `capability_unavailable`. All writes continue through
`writeSecureJson`; migration must discard unknown/private fields.

Add a focused `src/conversation/app-selection.ts` (or an equivalent extension
of `src/conversation/registry.ts`) for a per-message invocation record:

- target workstream, Project/chat binding, connector label, message/event key;
- requested app identity and selection method (`mention`, composer selection,
  or product-specific equivalent);
- current-message availability, invocation success, workspace verification,
  and sanitized failure classification.

Do not overwrite the persistent conversation binding when a single message
fails to select the app. A follow-up fresh data request must create a new
selection record and cannot infer availability from a previous success.

### 3.4 MCP OAuth compatibility contract

Update `src/auth/oauth.ts`, `src/auth/store.ts`, `src/auth/middleware.ts`, and
`src/bridge/server.ts` behind an explicit `OAuthCompatibilityConfig`/adapter:

1. Resolve one canonical public issuer/resource base from the stable named
   endpoint or the current verified tunnel URL. Do not derive production
   metadata from an arbitrary `Host` header. Keep loopback request-derived
   bases for isolated tests only.
2. Continue serving protected-resource and authorization-server metadata, but
   make the advertised issuer, authorization/token endpoints, scopes, and
   supported grant/PKCE methods match the selected current ChatGPT app flow.
   Advertise issuer-response support only when the implementation returns an
   exact `iss` value on success and errors.
3. Carry the exact `resource` from the authorization request through the
   authorization code, token exchange, refresh rotation, and token record.
   Require it to match the canonical `/mcp` resource (or a configured
   equivalent) and make `verifyAccessToken` check audience/resource as well as
   workspace, expiry, revocation, and scopes.
4. Keep DCR as the current compatible path when live app discovery selects it.
   Add a registration-mode abstraction and deterministic fixtures for the mode
   actually selected by the current app; if that flow selects CIMD, implement
   a bounded HTTPS metadata resolver with redirect URI, issuer, and client-auth
   validation rather than silently falling back to DCR. Do not fetch arbitrary
   URLs or allow SSRF. CIMD is not an unconditional implementation deliverable.
5. Register and authorize only the exact redirect URI surfaced by the current
   ChatGPT app-management flow. Store it only in runtime auth state; never
   hard-code an old callback in committed configuration. Reject redirect drift
   at authorization and token exchange.
6. Make scope handling fail closed: intersect requested scopes with the
   configured read-only allowlist, reject explicit unsupported/write scopes,
   and issue `offline_access`/refresh tokens only when requested and allowed.
   Preserve rotation, revocation, and per-request server-side scope checks.

Update `tests/oauth.test.ts` with metadata issuer/resource assertions, exact
resource propagation and wrong-resource rejection, audience-bound bearer
checks, the selected registration-mode fixture (and CIMD only if live flow
selection requires it), dynamic redirect validation, scope rejection,
refresh/offline continuity, and canonical-base behavior. Preserve
the existing PKCE, one-time-code, XSS, header, revocation, and refresh tests.

### 3.5 CLI, Skill, and documentation surfaces

Update `src/cli/index.ts` so `doctor --json` reports semantic surface
observations, selected fallback, OAuth contract status, account/read-only
verification, current app-selection status, and the bounded repair outcome.
Keep `developerModeEnabled` readable as a legacy machine preference, but do not
block setup merely because it is absent or false. A current explicit policy
requirement must instead be surfaced as a capability/policy boundary.

Update `skill/SKILL.md` to:

- prefer the built-in browser and allow an officially supported authenticated
  regular-browser/profile route only when materially required;
- discover the current semantic custom-MCP/app surface instead of assuming the
  old Security/deep-link sequence;
- verify origin/account/workspace before setup and preserve all auth/security
  boundaries;
- explicitly select/mention the exact app on every fresh MCP-dependent message;
- reconcile existing exact resources before create/delete/rebind and classify
  stale routes as recoverable drift;
- keep machine-verifiable setup controls automatic under the existing C2C
  authorization without adding acknowledgement-only Human Gates.

Update `docs/troubleshooting.md`, `docs/custom-stability-patches.md`,
`docs/architecture.md`, and `docs/security.md` to separate stable semantic
requirements, current preferred/fallback routes, browser automation limits,
OAuth contract checks, app-selection behavior, machine-verifiable controls,
and genuine Human Boundaries. Keep product labels and URLs as examples or
runtime observations, not durable contracts.

## 4. Data flow and state transitions

1. Resolve the exact local workspace, canonical repository, installation
   identity, stable/ephemeral endpoint, and sanitized connector label.
2. Run the local doctor gate and verify the public HTTPS endpoint. Read any
   existing binding/checkpoint before browser or connector mutation.
3. Probe the preferred ChatGPT surface through the selected supported browser
   adapter. Verify origin, active account/workspace, custom-app policy, and
   creation/authorization capability. If the form is absent, record route
   drift and try the next supported surface.
4. Reconcile existing connector records by exact binding, account/workspace,
   endpoint, read-only profile, and `workspace_info`. Reuse an exact match;
   leave foreign names untouched; recover an owned endpoint replacement only
   after verified absence.
5. During OAuth, validate the selected metadata/registration/redirect/resource
   contract, authorize only the bounded read-only scopes, and store only
   hashed/runtime metadata.
6. Bind/reconcile the exact Project/reviewer context. Before each fresh MCP
   data request, record current-message app selection, invoke the exact app,
   and require `workspace_info`/`git_status` to match the selected workspace.
7. Persist a sanitized bounded outcome. `READY` requires all configured
   account, endpoint, read-only, OAuth, Project, current-message, and workspace
   checks. Route drift/session restart/endpoint replacement is recoverable;
   security-sensitive browser branches remain Human Boundaries; exhausted
   supported routes are genuine capability unavailability.

## 5. API/schema compatibility and migration

- Read schema version 1 identity, provisioning, auth, and conversation files;
  migrate only known fields into the new version and retain the existing
  connector name/installation/endpoint identity. Never migrate raw tokens,
  cookies, URLs, or opaque provider data into committed artifacts.
- Keep `ConnectionAdapter` optional fields compatible with current test doubles;
  make new evidence mandatory only for a live `READY` classification when the
  product exposes it.
- Keep `connectorAction`, endpoint fingerprinting, named-tunnel state, and
  existing CLI JSON fields stable. Add new fields rather than changing their
  meaning; retain deprecated page constants as labeled fallback evidence.
- If a current ChatGPT app selects a registration/redirect mode not supported
  by the local adapter, return a bounded compatibility failure with the exact
  missing capability rather than silently broadening OAuth or changing the
  endpoint.

## 6. Security, privacy, and concurrency

- The bridge remains loopback-only, public exposure remains HTTPS through the
  tunnel, and all MCP tools remain read-only with server-side scope/path/
  workspace enforcement.
- Validate OAuth issuer, resource/audience, redirect, PKCE, scopes, expiry,
  revocation, and workspace on every relevant transition. Do not treat
  `readOnlyHint` as the sole authorization boundary.
- Never persist access/refresh tokens, authorization codes, pairing codes,
  cookies, private ChatGPT URLs, client metadata bodies, or raw redirect URLs
  in repository artifacts. Logs use existing redaction and sanitized hashes.
- Serialize per binding/workspace/installation and protect OAuth token/auth-code
  stores with the existing secure-write model. App-selection records are
  keyed by message/event identity so retries cannot overwrite a different
  invocation.
- Browser automation uses semantic DOM/state controls only. Login, CAPTCHA,
  unsupported 2FA, ambiguous account/SSO, unexpected scope, and native
  security confirmation remain human/security boundaries.

## 7. Test and validation plan

### Deterministic coverage

- `tests/surface-routing.test.ts` (new): preferred plugin-hub success,
  stale deep-route fallback, supported regular-browser fallback, origin/account
  mismatch, Developer mode policy required/available, browser capability loss,
  Human Boundary, and genuine all-routes-unavailable classification.
- `tests/reliability.test.ts` (extend): account/workspace proof, explicit
  read-only proof, exact reuse, duplicate prevention, owned endpoint recovery,
  ambiguous create reconciliation, and preservation of another workstream's
  connector.
- `tests/oauth.test.ts` (extend): protected-resource/AS metadata, canonical
  issuer, PKCE S256, exact resource propagation, token audience/resource and
  scope checks, DCR/CIMD selection, dynamic redirect, refresh/offline access,
  wrong account/workspace/resource rejection, and sanitized persistence.
- `tests/app-selection.test.ts` (new or registry extension): persistent
  reviewer binding versus fresh message selection, wrong/unavailable app,
  successful selected invocation, and A2-style `workspace_info` + `git_status`
  evidence.
- `tests/provisioning-state.test.ts` and `tests/prefs.test.ts` (extend): state
  migration, bounded outcome serialization, legacy Developer mode preference,
  and absence of secrets/private metadata.
- `tests/skill-contract.test.ts` and documentation checks (extend): semantic
  route policy, supported browser fallback, per-message selection wording,
  read-only/auth boundaries, and no obsolete route-only blocker.

### Validation commands and live evidence

Run in the worktree after implementation:

```text
corepack pnpm typecheck
corepack pnpm test
```

Record any environment-only test failures separately from product regressions;
do not weaken the tests to hide them. Live acceptance must be a sanitized
artifact, not a unit-test fixture, and must include:

- exact current ChatGPT surface and account/workspace policy observation;
- one exact isolated A0 connector/project binding with no A0/A1/A2 repoint;
- current app-management redirect and selected DCR/CIMD mode;
- successful `workspace_info` and `git_status` through a message that selects
  the exact A0 app;
- read-only tool/scope evidence and token/resource/refresh checks;
- stale-route, endpoint-replacement, session-recreation, and lost-ack
  reconciliation evidence;
- sanitized bounded outcome and no private IDs/URLs/tokens in committed files.

The A2 fixture remains a later live acceptance consumer. This plan does not
implement A2 or advance its `a2-hwr-plan` checkpoint.

## 8. Implementation order and review checkpoints

1. Add surface/capability types, route selection, bounded outcomes, and
   versioned provisioning/identity evidence with deterministic tests.
2. Extend connector reconciliation and per-message app-selection records,
   preserving all existing duplicate and endpoint-recovery invariants.
3. Harden OAuth metadata/resource/audience/redirect/scope behavior and add
   tests for the selected registration mode without changing a compliant live
   flow unnecessarily. Add CIMD behavior only when the selected flow proves it
   is required.
4. Update CLI doctor JSON, Skill routing rules, recovery documentation, and
   security/architecture terminology.
5. Run typecheck/tests, then perform the bounded live A0 acceptance and A2
   regression fixture only after the implementation review authorizes it.

After each in-scope change, reconcile the current Issue and plan against the
acceptance criteria. A C2C `FIX_REQUIRED` verdict is remediated in this Step
and re-reviewed; it is not a new Human Gate. A C2C capability failure remains
`BLOCKED` with one explicit recovery action and no local-reviewer substitute.

## 9. Risks, rollback, and known limitations

- ChatGPT plan/workspace rollout differences may expose different Developer
  mode, app-management, redirect, or registration capabilities. The selector
  records what is observed and fails closed when policy requires an unsupported
  capability; it does not infer from historical screenshots or labels.
- CIMD support can introduce SSRF and client-metadata trust risks. Keep it
  behind an explicit selected mode, validate HTTPS/issuer/redirects, bound
  fetches, and retain DCR when DCR is the current compatible mode.
- OAuth state migration must retain existing authorized sessions where their
  resource/audience can be proven; otherwise require bounded reauthorization
  rather than silently reusing an unbound token.
- A rollback restores the prior source/docs and preserves runtime state. It
  never deletes foreign connectors, rewrites another workstream's binding, or
  commits runtime credentials/private product metadata.

## 10. Requirements coverage map

- Q601/Q602: semantic route selector, capability-based Developer mode policy,
  stale-route classification, and supported browser surface policy.
- Q603/Q604: identity/account/read-only evidence, reconciler invariants,
  duplicate prevention, endpoint recovery, and fail-closed scope checks.
- Q605: bounded outcome model and Human Boundary/capability classification.
- Q606: exact isolated A2 fixture, no A2 source changes, and preservation of
  A0/A1 bindings.
- Q607: OAuth metadata, issuer, PKCE/resource/audience/scope, DCR/CIMD,
  current redirect, refresh/offline behavior, deterministic/live validation.
- Q608: persistent binding versus current-message app selection and selected
  `workspace_info`/`git_status` invocation.

## Known limitations at draft time

- No source implementation has started.
- The exact A0 connector is paired and the approved replacement Project
  `codex-with-chatgpt-a0-surface-compatibility` exists with Project-only
  memory. The exact A0 app was selected for the fresh MCP-dependent review
  message and `workspace_info` matched the workstream.
- The observed current-product Project display-name limit is 50 characters.
  The old 51-character generated value is invalid; the approved bounded
  replacement is a display label only and does not replace the durable
  workstream identity.
- The exact connector initially reported `isRepo: false` for `git_status` and
  `git_diff` because Git rejected the sandbox-owned worktree as dubious
  ownership for the bridge user. One exact, reversible `safe.directory` trust
  entry for this A0 worktree was applied; no ACL, ownership, deny rule, source,
  or A2 change was made. The same connector now reports `isRepo: true`, branch
  `a0-chatgpt-surface-compatibility`, the recorded full HEAD, and an empty
  tracked HEAD diff. The remaining dirty state is limited to untracked
  planning/evidence artifacts (`.harness/` and
  `docs/current-openai-product-research.md`).
- The current `gh` CLI credential context is invalid, but the connected GitHub
  app successfully created and fetched Issue #11; no credential material is
  persisted in this worktree.

## C2C plan-review remediation (2026-10-03)

The bounded reviewer returned `PLAN_REVIEW / FIX_REQUIRED` without changing
source or A2. Before implementation, reconcile this plan and `state.yaml` with
the live Project binding and preserve these review constraints:

- READY/REUSED requires an explicit connector record or independently verified
  surface observation for account, workspace, and read-only proof. Missing
  proof remains pending/recoverable; it must not silently become READY.
- Keep the existing reconciler state machine and map its result upward:
  `READY + zero mutations → REUSED`, create-only `→ CREATED`, owned
  delete/recreate `→ RECOVERED`, transient route/session state `→
  RECOVERABLE_FAILURE`, security/user boundary `→ HUMAN_BOUNDARY`, and
  exhausted supported routes `→ REQUIRED_CAPABILITY_UNAVAILABLE`.
- Per-message app selection must reuse the existing deterministic message
  idempotency key; it must not introduce a competing event identity.
- OAuth changes remain evidence-driven. Characterize the selected live
  registration flow before implementing CIMD or changing DCR behavior.
- At the first C2C review, the `isRepo: false` result was a blocking
  verification risk for independent post-implementation diff review; it was
  not permission to switch connectors or implement source around the
  limitation. The follow-up verification below records its resolution.

## C2C plan-review remediation follow-up (2026-10-03)

The next bounded review revalidated the exact A0 connector after the minimal
Git trust repair:

- `workspace_info` matched the A0 workstream and the repository was visible
  (`isRepo: true`).
- Branch `a0-chatgpt-surface-compatibility` and the full recorded HEAD matched
  the local worktree; upstream was `origin/main` with no ahead/behind drift.
- `git_status` showed no staged, unstaged, or conflicted tracked files; only
  the untracked planning/evidence artifacts remained. `git_diff(mode=head)`
  was empty.
- The connector's nine registered tools remained read-only, and the review
  made no source or A2 changes.

The Git-visibility blocker is resolved. The next C2C cycle should review this
reconciled plan/harness state without restarting discovery or advancing into
source implementation.

## C2C Review Summary

The existing exact A0 Project/chat binding was reviewed through the explicitly
selected exact A0 app. The approved Project display name is
`codex-with-chatgpt-a0-surface-compatibility`; its memory mode is
Project-only, and the reviewer remains in Chat mode. The display-name limit
observed on the current creation surface is 50 characters; this bounded label
does not replace the durable workstream, repository, workspace, or connector
identity.

The final bounded pre-implementation review returned `PLAN_REVIEW / PASS`
at checkpoint `a0-surface-plan`:

- `workspace_info` matched
  `a0-chatgpt-surface-compatibility`.
- The repository was visible through the exact connector
  (`isRepo: true`), on branch
  `a0-chatgpt-surface-compatibility`, at recorded HEAD
  `d030a196a8cb3ed4fca4573c174ebf7fa47c720c`.
- Upstream was `origin/main` with no ahead/behind drift.
- `git_status` had no staged, unstaged, or conflicted tracked files;
  only the untracked planning/evidence artifacts remained.
- `git_diff(mode=head)` was empty.
- Read-only tool behavior was verified, with no source or A2 implementation.

The earlier Git visibility failure was resolved by one exact, reversible
`safe.directory` trust entry for this worktree. No ACL, ownership, deny
entry, connector identity, source file, or A2 artifact changed. The evidence
and rollback note remain in
`07-c2c-git-visibility-diagnostic.md`.

The reviewer confirmed that readiness proof is fail-closed, reconciler
checkpoint/mutation behavior is preserved, OAuth/CIMD changes remain
evidence-driven, per-message app selection reuses the existing deterministic
message idempotency identity, and Project display-name normalization remains
separate from durable identity and ownership proof.

### Canonical disposition

`PLAN_READY_FOR_VISUAL_REVIEW`

The Step 3 plan and C2C review are complete. No source implementation is
authorized in this step. The canonical next step is the Step 4 direct plan
approval gate because this work has no rendered UI/output whose visual
comparison would materially aid approval.

