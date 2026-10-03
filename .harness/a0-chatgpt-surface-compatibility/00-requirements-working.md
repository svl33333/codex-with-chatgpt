# A0 ChatGPT surface compatibility — requirements working document

## Problem statement

The A0 runtime already has durable workspace identity, endpoint fingerprints,
connector reconciliation, operation checkpoints, read-only MCP tools, and
machine-local provisioning state. Its setup contract still assumes a
historical ChatGPT navigation model: a deep settings URL exposes the custom
connector form, a Developer mode toggle is available on the Security page, and
the in-app setup route is the only supported browser surface. Current product
observation shows a different surface. The normal ChatGPT plugin hub exposes an
`Add` menu and a `Create custom MCP server` form, while the old deep route lands
on an installed-plugin settings list and the Security page has no Developer
mode control in this account. That absence is stale-route evidence, not proof
that the Developer mode/custom-app capability has disappeared or is never
required by an account or plan. A failed deep route therefore must not be
classified as global custom-MCP capability absence.

The compatibility layer must select a currently supported ChatGPT surface,
reconcile exact workstream identity before mutation, preserve read-only scope,
and recover boundedly across endpoint/UI/session failures. It must remain
reusable by A2 and later workstreams without implementing A2 itself.

## Goals

1. Establish current first-party product behavior from OpenAI documentation and
   direct authenticated Codex In-app Browser observation, with terminology
   mappings and redacted evidence.
2. Replace brittle single-route setup assumptions with a semantic surface
   strategy: prefer the current plugin hub custom-MCP flow, discover/use the
   currently supported Developer mode/custom-app enablement surface when the
   active account or workspace policy requires it, use a verified settings
   route only when its creation form is actually present, and keep the normal
   ChatGPT page as the reviewer/project-chat surface.
3. Reconcile exactly one connector for one selected workstream before creating,
   deleting, authorizing, or rebinding anything. Never repoint another
   workstream's connector.
4. Define one deterministic provisioning/recovery contract with bounded
   outcomes for reuse, creation, endpoint recovery, Human Boundary,
   recoverable failure, and genuine product unavailability.
5. Verify account/workspace, canonical repository, endpoint identity, project /
   reviewer context, read-only permissions, the selected current MCP OAuth
   contract, and current-message app/tool availability before declaring
   readiness.
6. Keep OAuth credentials, pairing codes, cookies, connector/app IDs, private
   URLs, installation IDs, endpoint identities, and machine paths in runtime
   state only; committed evidence is sanitized and logical.
7. Provide deterministic tests for route fallback, identity/duplicate
   prevention, endpoint replacement, ambiguous creation, scope/account
   rejection, MCP OAuth contract compatibility, per-message app selection,
   capability classification, sanitized evidence, and an isolated A2-style
   workspace verification fixture.
8. Update the Skill and recovery documentation around semantic requirements,
   preferred/fallback routes, machine-verifiable controls, and genuine Human
   Boundaries rather than a fixed button sequence.

## Non-goals

- A2 Headless Workstream Runner source or changes to its implementation scope.
- A3 scheduling, A4 full-auto orchestration, or a generalized Computer Use
  framework.
- Broader GitHub write delegation, publication, merge, or account-management
  authority.
- Weakening read-only scopes or bypassing login, CAPTCHA, 2FA, consent,
  ownership, or security-sensitive confirmation boundaries.
- Redesigning `codex-c2c-v2`; only an independently verified A0 compatibility
  defect may be addressed here.

## Verified repository/product facts

### Remote and workflow

- Remote repository: `svl33333/codex-with-chatgpt`.
- Current remote default branch: `main`.
- Remote HEAD resolved through the public GitHub repository API before the
  worktree was created: `d030a196a8cb3ed4fca4573c174ebf7fa47c720c`.
- Maintenance branch/worktree: `a0-chatgpt-surface-compatibility` at that
  HEAD.
- Canonical workflow: `codex-c2c-v2` v2.3.1,
  `60d17218c256098522e063b5bf4731cecc9c1f12`, validator `WORKFLOW_READY`.
- The existing A2 state remains Step 3 `BLOCKED` /
  `REQUIRED_CAPABILITY_UNAVAILABLE` at checkpoint `a2-hwr-plan`; its worktree
  branch is `a2-headless-workstream-runner` and no A2 source implementation
  has been started.

### Current ChatGPT product observation

On 2026-10-03 (Asia/Tokyo), the authenticated Codex In-app Browser observed:

1. `https://chatgpt.com/plugins` loads the installed-plugin hub. Its current
   terminology is `プラグイン` (plugin), with an `追加` (Add) button and a
   menu item `カスタム MCP サーバーを作成` (Create custom MCP server).
2. Selecting that menu item opens a live creation dialog with fields for name,
   description, server URL, authentication (OAuth is available), a read-risk
   acknowledgement, and a disabled-until-complete
   `プラグインとして作成` (Create as plugin) action. This is the currently
   verified custom-MCP provisioning surface.
3. The historical deep URL
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   normalizes to a settings/connectors page showing installed plugins and
   permissions; it did not expose the creation dialog in this observation.
4. `https://chatgpt.com/#settings/Security` loads `セキュリティとログイン` and
   account/security controls, including custom-app CSP and device-code settings;
   no Developer mode toggle was present. This does not establish that Developer
   mode/custom-app enablement is absent or never required: the historical page
   location is stale UI knowledge, and the active account/workspace policy is
   authoritative when the product requires an enablement step.
5. `https://chatgpt.com/` exposes a `プロジェクト` (Projects) sidebar,
   per-project `新しいチャット` actions, and a `Chat`/`Work` mode switcher.
   Reviewer conversations must be created/reused in Chat mode, not Work mode.
   Current app/tool availability is a per-message concern: a Project or prior
   MCP call does not by itself prove that the intended app is selected for the
   next fresh invocation.

Private account details, project URLs, connector IDs, endpoint URLs, and phone
numbers observed on these pages are intentionally excluded from this artifact.
The detailed first-party research record is
`docs/current-openai-product-research.md`.

### Code audit: compatibility defects

- `src/config/endpoint.ts` exposes a single deep create URL and a Security URL;
  there is no route/capability model for the plugin-hub custom-MCP dialog.
- `skill/SKILL.md` requires the deep URL, forbids starting from the plugin hub
  or following semantic Add-menu controls, treats Developer mode as a universal
  setup prerequisite, and restricts UI work to the built-in browser. These are
  historical/local assumptions that must be separated from current product
  capability and supported browser integration.
- `src/cli/index.ts` reports only the historical pages and has no preferred /
  fallback route evidence. It cannot distinguish route drift from global
  capability loss.
- `src/connection/reconciler.ts` already protects exact workspace, repository,
  installation, endpoint, and connector identity and reconciles ambiguous
  create/delete outcomes, but its adapter contract does not expose account
  context, read-only permission verification, selected surface, or the current
  message's app/tool selection.
- The bridge and OAuth implementation already contain DCR/PKCE and refresh
  behavior, but the compatibility layer has no contract-level evidence checks
  for protected-resource/authorization-server metadata, canonical issuer,
  exact `resource` propagation, token audience/resource and scope validation,
  selected DCR/CIMD client registration, or the redirect URI returned by the
  current app-management surface. The milestone must inspect the existing
  behavior first and change OAuth only if the selected current ChatGPT flow
  exposes a real mismatch.
- `src/provisioning/state.ts` persists safe phase/reason/retry data and is a
  suitable place for bounded route/repair phase evidence; secrets remain
  outside the repository.
- Existing endpoint recovery correctly preserves the connector name and only
  replaces an owned connector after endpoint identity changes. The missing
  piece is a current-product route and capability decision before that
  reconciliation is invoked.

## Canonical terminology and boundaries

| Historical term | Current observed term | Canonical meaning in this workstream |
| --- | --- | --- |
| connector / plugin / app | installed plugin or custom MCP server | One ChatGPT-side custom MCP binding selected by exact workstream identity |
| connector creation URL | plugin hub → Add → Create custom MCP server | Preferred provisioning surface; labels are not API contracts |
| Developer mode | Developer mode / custom-app enablement surface | Capability gate discovered for the active account/workspace; the historical Security-page location is not a contract, and an explicit current requirement must not be bypassed |
| Project / collection | Projects sidebar and project chat | One reviewer context per workstream; exact project binding is verified |
| reviewer chat | Chat mode conversation | ChatGPT control/review channel; Work mode is not interchangeable |
| app selection | Per-message app/tool selection | Current-message availability is distinct from persistent reviewer/workstream binding and from a successful prior MCP call |
| MCP server URL | Server URL | Current endpoint field; never persisted in committed evidence |

The C2C bridge remains the read-only data plane. Browser/UI controls are the
control plane. ChatGPT account/workspace, Project, connector identity, local
workspace, repository, branch, and endpoint fingerprint are separate identity
dimensions; matching a display name alone is never ownership proof. Current
MCP OAuth metadata/PKCE/resource/registration/redirect/refresh requirements and
per-message app-selection behavior are linked in
`docs/current-openai-product-research.md` and must be rechecked against the
selected live ChatGPT surface.

## Stable design questions and decisions

### Q601 — Provisioning surface strategy

Should setup select a semantic current-product surface instead of assuming one
deep URL, preferring the observed plugin-hub custom-MCP flow and falling back to
another route only after verifying its creation form is present?

**Recommendation / recorded answer:** Yes. Route selection is observation
driven. A failed route is recoverable UI drift while a supported alternate
route remains. Only exhausted, explicitly unsupported routes produce
`REQUIRED_CAPABILITY_UNAVAILABLE`.

### Q602 — Developer mode/custom-app capability gate

Should compatibility avoid hard-coding the historical Security-page route and
discover/use the currently supported Developer mode or custom-app enablement
surface for the active account/workspace when product policy requires it, while
allowing provisioning to continue when the custom-MCP creation surface is
already available and usable?

**Recommendation / recorded answer:** Yes. The historical Security-page
location is stale UI knowledge, not proof that the capability disappeared.
Retain `developerModeEnabled` as backward-compatible data where needed, but
do not emit a blocker solely because that legacy preference is false or absent.
Conversely, do not silently bypass a Developer mode/custom-app requirement that
the current product explicitly presents; workspace/plan policy remains
authoritative.

### Q603 — Exact identity and duplicate prevention

Should existing resources be listed and verified against workspace, canonical
repository, installation/workstream binding, endpoint mode/fingerprint,
account context, Project/reviewer binding, and connector name before any create,
delete, or rebind?

**Recommendation / recorded answer:** Yes. A same-name foreign resource is a
conflict and remains untouched. Ambiguous create results reconcile before any
retry. A successful endpoint replacement preserves the supported connector
identity/name.

### Q604 — Least privilege and verification

Should readiness require an explicit read-only capability proof when the current
surface exposes permissions, rejecting unexpected write or expanded scopes?

**Recommendation / recorded answer:** Yes. Existing adapters remain compatible
when the product omits a permission field, but any explicit non-read-only or
unexpected scope is a fail-closed rejection; live acceptance must record the
observed read-only state.

### Q605 — Bounded outcome classification

Should the compatibility layer distinguish `REUSED`, `CREATED`, `RECOVERED`,
`HUMAN_BOUNDARY`, `RECOVERABLE_FAILURE`, and
`REQUIRED_CAPABILITY_UNAVAILABLE` rather than collapsing route failure into one
blocker?

**Recommendation / recorded answer:** Yes. Login/CAPTCHA/2FA/explicit
security-sensitive consent remains a Human Boundary. Browser/session restart,
route drift, and transient MCP reads remain recoverable. Genuine absence of
all supported creation surfaces is the only capability-unavailable result.

### Q606 — A2 regression fixture

Should the post-remediation live fixture provision one exact A2 connector,
verify `workspace_info`, branch/HEAD, `git_status`, read-only scope, and
preservation of A0/A1 bindings, and perform those MCP calls through a current
message that actually selects/uses the exact A2 app, then leave A2 at
`a2-hwr-plan` without source implementation?

**Recommendation / recorded answer:** Yes. A2 is a consumer acceptance
fixture, not an implementation dependency. Persistent reviewer/project binding
does not substitute for current-message app selection, and no A2 source or
workflow state is advanced by this Step 1 artifact.

### Q607 — Current MCP OAuth contract

Should the compatibility milestone validate the deployed C2C authorization
server against the current first-party ChatGPT MCP OAuth contract, including
protected-resource metadata, authorization-server metadata, canonical issuer,
PKCE S256, exact `resource` propagation, token audience/resource and scope
validation, the current client-identification/registration mode (DCR and/or
CIMD as selected by the active ChatGPT app), the exact redirect URI exposed by
the current app-management surface, and refresh-token/offline-access behavior
where persistent connectivity requires it?

**Recommendation / recorded answer:** Yes. Inspect the existing DCR/OAuth,
PKCE, resource, and refresh behavior first; do not require a new OAuth
implementation merely because a newer mechanism exists. If the existing
behavior satisfies the selected current ChatGPT flow, record that as a passing
compatibility result. If it does not, the concrete mismatch is in this A0
milestone. Fail closed on audience/resource/scope/issuer/redirect mismatches;
native login, consent, CAPTCHA, 2FA, or other security-sensitive actions remain
Human Boundaries.

### Q608 — Per-message app selection

Should the reviewer invocation contract distinguish persistent logical
reviewer/workstream binding, current-message app/tool availability, and a
successful current MCP invocation, requiring a fresh message to explicitly
select or mention the exact app whenever the product requires it?

**Recommendation / recorded answer:** Yes. A Project/reviewer-chat binding or
a previous successful MCP call is not proof that the intended app is selected
for the next fresh tool call. The compatibility layer must record and verify
the current-message selection, and A2 acceptance must obtain both
`workspace_info` and `git_status` through that selected A2 app.

## Constraints, dependencies, security, and privacy

- Keep the canonical C2C workflow and Human Gates unchanged.
- Prefer the Codex/ChatGPT built-in browser when it can safely complete the
  current-product flow. When an existing authenticated regular-browser
  profile/session is materially required and the product officially supports
  that browser integration, the supported browser route may be used as a
  fallback. In either route, verify origin, account, and workspace before
  acting; do not use screenshot-coordinate automation as the provisioning
  contract, and never weaken browser, sandbox, or authentication security.
- Do not automate or bypass CAPTCHA, unsupported 2FA, password/recovery,
  ambiguous account/SSO, unexpected scope expansion, or native security
  confirmation boundaries.
- Runtime-only exact binding data may remain in the existing secure local state
  directory. No OAuth credentials, tokens, cookies, pairing codes, private
  project/chat URLs, connector IDs, installation IDs, endpoint identities, or
  private machine paths may enter committed files.
- Do not repoint an A0/A1/A2 connector merely because it reaches the same
  repository. The selected workstream must have its own exact binding.
- The A2 worktree and checkpoint are read-only regression inputs during this
  milestone; A2 source implementation is out of scope.

## Acceptance criteria (Given / When / Then)

1. **Current-product evidence:** Given the repository and a supported
   authenticated browser route, when the audit runs, then it records current
   first-party documentation, the plugin-hub custom-MCP form, the deep-route
   behavior, the Developer mode/custom-app enablement capability if required by
   policy, the Security-page terminology, supported browser-surface evidence,
   and Chat/Work + Project behavior without private identifiers.
2. **Fallback routing:** Given the preferred surface lacks a creation form,
   when another supported surface exposes one, then provisioning selects that
   surface and does not return capability-unavailable.
3. **Exact reuse:** Given one matching connector with the same account/workspace,
   repository, endpoint identity, Project/reviewer binding, and read-only scope,
   when provisioning runs, then it returns `REUSED` with zero mutations.
4. **Creation and duplicate prevention:** Given no exact connector, when the
   selected form succeeds, then exactly one connector is created; a same-name
   foreign connector or ambiguous result blocks/reconciles without duplicate
   creation.
5. **Endpoint recovery:** Given an owned connector with a replaced endpoint,
   when recovery runs, then ownership and absence are verified before recreate,
   the logical connector identity/name is preserved, and no unrelated connector
   is changed.
6. **Identity/scope rejection:** Given wrong account/workspace/repository,
   unexpected permissions, or non-read-only scope, when verification runs, then
   provisioning fails closed with no destructive fallback.
7. **Bounded failures:** Given login/CAPTCHA/2FA/explicit security consent,
   browser capability loss, transient session/UI drift, or all supported routes
   explicitly unavailable, when provisioning runs, then the outcome is the
   corresponding Human Boundary, recoverable failure, or genuine capability
   block with one next action and sanitized evidence.
8. **Persistence hygiene:** Given any route/recovery attempt, when state/audit
   is persisted, then only bounded logical identifiers, hashes, phases, and
   sanitized reasons are written; no secret/private metadata is committed.
9. **A2 isolated regression:** Given the existing A2 worktree, when live
   acceptance runs after remediation, then a fresh reviewer message explicitly
   selects/uses exactly one A2-specific read-only app and obtains both
   `workspace_info` and `git_status` through that invocation. The response must
   identify the A2 workspace, branch `a2-headless-workstream-runner`, and the
   actual A2 HEAD, while A0/A1 connectors remain unchanged and A2 resumes
   checkpoint `a2-hwr-plan` without source implementation.
10. **MCP OAuth compatibility:** Given the deployed C2C authorization server
    and the current ChatGPT app configuration, when deterministic contract
    fixtures and bounded live checks run, then protected-resource and
    authorization-server metadata, canonical issuer, PKCE S256, exact
    `resource` propagation, token audience/resource and scope validation,
    selected DCR/CIMD registration, the current app-surface redirect URI, and
    refresh/offline access where required are verified. Existing compliant
    DCR/OAuth behavior is accepted without a rewrite; a concrete mismatch is a
    compatibility failure, and no historical redirect or unvalidated scope is
    silently accepted.
11. **Per-message app selection:** Given a persistent Project/reviewer binding
    and a prior successful MCP call, when a fresh message requests MCP data,
    then the invocation records whether the exact app was selected/mentioned as
    required by the product and rejects an unavailable or different app instead
    of inferring availability from the conversation history.

## Edge cases, failure behavior, and rollback

- A stale route that redirects to an installed list is a route-drift signal;
  rediscover the semantic Add → custom MCP action before blocking.
- If the custom-MCP form is unavailable or gated, discover the current
  Developer mode/custom-app enablement surface and apply the active
  account/workspace policy; never infer a global capability result from the
  historical Security-page location.
- A page that requires login, CAPTCHA, 2FA, or explicit security confirmation
  is a Human Boundary, not a technical retry loop.
- An OAuth metadata, issuer, `resource`, audience, scope, registration, or
  redirect mismatch is a fail-closed compatibility result; it must not be
  papered over by a broader scope or a historical redirect. Refresh-token
  failure is recoverable only when the selected flow supports reauthorization
  without changing the workstream binding.
- When the next fresh reviewer message does not have the exact app selected,
  treat the app as unavailable for that invocation even if the Project or a
  previous message used it successfully.
- A browser/session recreation reuses the same workstream binding and route
  evidence; it never creates a second connector merely because the UI tab was
  lost.
- An endpoint replacement uses the existing ownership/delete/absence/create
  checkpoint; an unknown mutation result is reconciled before retry.
- A same-name connector with a different binding is left untouched and is
  reported as a conflict.
- Reverting this branch must not delete or rewrite runtime bindings, prior A0/A1
  records, or the A2 worktree.

## Assumptions and impact

- The observed plugin hub remains a supported first-party surface; button
  labels may drift, so implementation will model semantics/capabilities rather
  than exact text or DOM coordinates. The built-in browser is preferred, while
  a materially necessary officially supported authenticated regular-browser
  integration remains an allowed fallback under the same origin/account/
  workspace checks.
- The account observed in this audit did not show a Developer mode toggle on
  the historical Security page. This is not evidence that no account or plan
  requires Developer mode/custom-app enablement; the current product policy
  determines that capability gate.
- The read-only MCP bridge and existing OAuth/pairing protocol remain the data
  plane; this milestone changes only provisioning/surface selection and its
  evidence contract, unless the OAuth compatibility checks identify a concrete
  mismatch with the selected current ChatGPT flow.
- Current ChatGPT app selection may be per message, so persistent reviewer
  binding is not treated as proof of current-message tool availability.
- Product-side account/workspace identity may be exposed only at runtime. If a
  live connector cannot provide an account/workspace proof, readiness remains
  pending rather than inferred from a display name.

## Requirements approval gate

- Resolved Q-IDs: Q601–Q608 (recorded recommendations above)
- Open Q-IDs: none identified from the supplied task and current observations
- Human Gate: explicit requirements approval is still required by
  `codex-c2c-v2` Step 1 before Issue conversion, planning, implementation, or
  C2C review.
- Terminal marker to emit: `REQUIREMENTS_READY_FOR_APPROVAL`
