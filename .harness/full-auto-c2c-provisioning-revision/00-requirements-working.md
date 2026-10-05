# C Requirements Discovery — Full Auto pairing compatibility revision

## Workstream identity and authority

- Repository: `svl33333/codex-with-chatgpt`
- Workstream slug: `full-auto-c2c-provisioning-revision`
- Workstream kind: successor requirements workstream
- Requirements baseline: fork `main` at `c8e5a2b2ed7b56330983ecf2f5f629dea3f337db`
- Canonical workflow: `codex-c2c-v2` 2.4.0 at `0069229049099c076a74ebb0c1797328ea8f8d3a`
- Prior candidate retained as historical evidence only: `4843366ff9dc969d778aa54eb3e4e0d9fe8b925a`
- Prior candidate worktree and pairing diagnostics are not a specification and are not being modified.

The successor classification is based on live reconciliation: the prior publication candidate has no matching current `.harness` workstream state, its runtime-only handoff behavior was not accepted as a product specification, and the user explicitly required a requirements restart after A/B completion. The new worktree is clean and based directly on the current fork `main`; no implementation, Issue creation, branch publication, push, PR, or merge is part of this Step 1 artifact.

## Problem statement

The published C2C baseline already performs normal pairing automatically: Codex obtains a short-lived one-use pairing value, enters it into the verified ChatGPT OAuth pairing surface, submits Connect, and verifies the workspace. The previous C candidate made a runtime-only handoff mandatory before proving it against the real ChatGPT connector/OAuth surface. In the live environment the supported automatic handoff was not machine-confirmed and normal setup became `C2C_CAPABILITY_UNAVAILABLE:PAIRING_HANDOFF`, even though the published compatibility path was the known working behavior.

Full Auto must therefore improve security without regressing the published level of routine automation. A stronger runtime-only handoff is a preferred design candidate, not an accepted replacement until the same real product surface proves it end to end.

## Goals

1. Preserve zero routine user pairing actions in `setupMode: auto`.
2. Retain a bounded, automatic compatibility path equivalent to the published `c2c pair --json` flow until stronger handoff E2E evidence exists.
3. Make any stronger runtime-only handoff one-use, short-lived, exact-workspace/connector bound, and fail-closed on identity or scope mismatch.
4. Automate exact read-only connector reconciliation and Project creation/reconciliation without duplicate resources.
5. Keep Project creation, Project collection, Project settings, Project Instructions, reviewer-chat composer, connector configuration, and OAuth/pairing as distinct semantic surfaces.
6. Require real ChatGPT E2E evidence before claiming pairing/provisioning completion or removing the compatibility path.
7. Keep the display label deterministic and at most 50 characters while preserving durable identity independently.

## Non-goals

- Do not publish, push, create a PR, or merge this requirements workstream.
- Do not continue or retrofit the preserved candidate `4843366f…`.
- Do not make routine manual pairing the normal solution for `setupMode: auto`.
- Do not repoint A0, parent/root, generic, Local Files, or another workstream connector.
- Do not change A2 or the already merged A/B workstreams.
- Do not broaden connector scopes, ownership, or write capabilities.
- Do not persist pairing values, OAuth material, cookies, or browser session state.
- Do not treat synthetic tests, display-name equality, or a successful local doctor as E2E identity proof.

## Live facts used as requirements evidence

### Published baseline

- Current fork `main` is `c8e5a2b2…` and remains the publication authority.
- `src/pairing/manager.ts` creates an eight-character formatted pairing value, stores only a hash, expires it after five minutes by default, permits bounded attempts/rate limiting, and destroys the session on successful verification.
- The published OAuth tests exercise the complete pairing + PKCE flow by submitting `pairing_code` to the OAuth authorization surface, then exchanging the authorization code and calling MCP.
- The baseline includes rejection of wrong/expired/replayed values and security headers on the pairing page.

### Failed candidate evidence

- The preserved candidate added a runtime-only handoff and semantic automatic-authorize path, but the live setup did not expose a machine-confirmed handoff capability. The result was a bounded capability block rather than acceptable normal Full Auto behavior.
- The candidate's unit/integration tests are useful design evidence only. They do not establish real ChatGPT connector/OAuth compatibility.

### Existing compatibility contracts

- A0 ChatGPT-surface compatibility remains a separate contract and is not modified to accommodate C.
- Exact reviewer binding is proved by `workspace_info`, `git_status`, and required `git_diff`, not by Project or connector display names.

## Stable questions and captured answers

### Q401 — Workstream lineage

**Question:** Should C reset the old workstream or start a successor workstream?

**Answer:** Successor. The old candidate is preserved as historical/reference evidence, the current C worktree has no authoritative matching state, and the requirements restart must be based on the current fork `main`.

**Impact:** A new `.harness/full-auto-c2c-provisioning-revision/` state is used. No old candidate tree is treated as the desired specification.

### Q402 — Normal pairing contract

**Question:** What behavior is mandatory before the stronger runtime-only handoff is proven?

**Answer:** In `setupMode: auto`, pairing remains fully automatic with zero routine user copy/paste or manual code entry. The implementation must retain an automatic compatibility path equivalent to the published `c2c pair --json` flow.

**Impact:** A missing or incompatible stronger handoff automatically selects the bounded compatibility path; it does not silently become manual setup.

### Q403 — Stronger handoff acceptance

**Question:** When may runtime-only handoff replace the compatibility path?

**Answer:** Only after real ChatGPT connector/OAuth E2E validation proves the same production path. Synthetic tests alone are insufficient.

**Impact:** Until that evidence is recorded, the compatibility path remains mandatory and tested.

### Q404 — Pairing-value custody

**Question:** May the compatibility value transiently cross a Codex/tool execution boundary?

**Answer:** Yes, when required by the proven automatic path, provided custody is short-lived and explicitly threat-modeled. It must never be persisted in files, state, logs, screenshots, fixtures, Living Spec, or normal user-visible chat.

**Impact:** Security hardening minimizes exposure without eliminating the only proven automatic path.

### Q405 — Project identity and display label

**Question:** Which identity is authoritative when a display name is shortened?

**Answer:** The durable workspace/connector binding is authoritative. A deterministic normalized display label must be `<=50` characters and is only a UI label. The previous accepted example `codex-with-chatgpt-full-auto-prov-publication` demonstrates the limit; user-provided manual shortening is not required in Full Auto.

**Impact:** Reconciliation fails closed on durable-identity ambiguity and never treats a matching label as proof.

### Q406 — Human boundary

**Question:** Which cases may stop for a person?

**Answer:** Login wall, CAPTCHA, unsupported 2FA, password/recovery, ambiguous or wrong account, unexpected SSO/org approval, unexpected permission/scope expansion, or unverified ownership/security-sensitive consent. Routine provisioning, pairing, Connect/Authorize, Project setup, and reviewer-chat creation remain automation tasks.

**Impact:** No acknowledgement-only or routine-manual gate is introduced.

### Q407 — Exact reviewer binding

**Question:** What must every fresh MCP-dependent reviewer message prove?

**Answer:** The exact dedicated read-only connector resolves to the intended repository, workspace root, branch, current HEAD, connector identity, and read-only capability. `WORKSPACE_MISMATCH` is fail-closed.

**Impact:** A same-name Project/chat/connector cannot substitute for machine-observable identity evidence.

## Mandatory product requirements

### R1 — Automatic normal pairing and bounded compatibility

Given `setupMode: auto`, a verified OAuth/pairing surface, and a healthy exact connector runtime, when normal setup is run, then Codex completes pairing, Connect/Authorize, and workspace verification without routine user copy/paste or manual pairing-code entry.

If the stronger runtime-only handoff is unavailable or incompatible, auto mode must select the safe bounded compatibility path automatically. The compatibility value is short-lived, one-use, bound to the exact workspace/connector/origin/request, immediately submitted to the verified OAuth surface, and never persisted or shown to normal chat.

### R2 — Runtime-only handoff is a preferred design, not a premature mandatory dependency

The stronger handoff may be selected only when machine-observable capability and exact binding are available. Its E2E success must be proven against the real ChatGPT product surface before the compatibility path can be removed or weakened.

### R3 — OAuth and connector security

All pairing and OAuth flows use the verified HTTPS surface, exact request/client/redirect binding, least-privilege read-only scopes, one-use authorization, bounded retries, and fail-closed identity/ownership checks. Tokens, pairing values, cookies, and session material remain runtime-only.

### R4 — Automated Project reconciliation

Full Auto must reconcile an existing exact Project or create one when no valid exact Project exists. Settings drift must be repaired idempotently without duplicate Projects or connectors. Project-only memory is required; Library/source additions are disabled and must be machine-verified absent.

### R5 — Semantic UI destination separation

The implementation must distinguish Project creation form, Project collection, Project settings, Project Instructions field, reviewer-chat composer, connector configuration, and OAuth/pairing form. Project Instructions are written only through Project settings and never through the reviewer-chat composer, even when the composer is visible.

### R6 — Deterministic display-name limit

Every generated Project display label is deterministic and `<=50` characters. Durable workspace/connector identity is stored and verified separately; truncation or normalization cannot cause identity collisions. Ambiguity fails closed.

### R7 — Fresh reviewer binding and verification

After setup, Full Auto creates or reconciles a fresh reviewer chat in the exact Project, explicitly selects the exact app on the first MCP-dependent message, and verifies `workspace_info`, `git_status`, required `git_diff`, repository, root, branch, HEAD, connector identity, and read-only capability before review evidence is accepted.

### R8 — Real ChatGPT E2E acceptance

Before claiming C completion, at least one fresh-workspace E2E run on the actual ChatGPT connector/OAuth surface must demonstrate exact workspace setup, dedicated read-only connector create/reconcile, automatic pairing with no routine user pairing action, successful authorization, exact Project reconciliation/creation, Project-only memory, no Library/source upload, settings-only Project Instructions, fresh reviewer chat, current-message app selection, `workspace_info`, `git_status`, required `git_diff`, exact repository/root/branch/HEAD, and no `WORKSPACE_MISMATCH`. The tested path must be the production path.

### R9 — Narrow Human Boundaries and no regression

Human involvement is restricted to the genuine boundaries in Q406. Compared with the current published C2C baseline, Full Auto normal setup must not increase routine user actions for connector pairing or Project provisioning. A security hardening that produces `C2C_CAPABILITY_UNAVAILABLE` is unacceptable when the safe automatic compatibility path remains available.

## Security, privacy, and operational constraints

- Read-only C2C connectors only; exact worktree scope is mandatory.
- No unrelated connector repointing, no connector ownership expansion, and no write-capable MCP scope.
- Pairing material may exist only in bounded runtime memory/tool custody and must be destroyed after use or expiry.
- Logs, test fixtures, screenshots, state files, repository artifacts, Project memory, and ordinary chat must contain no pairing value, OAuth credential, cookie, token, or private endpoint.
- Browser automation must use semantic controls and the supported ChatGPT/IAB surface; screenshot coordinates and hidden endpoints are not contracts.
- Local runtime health is not remote binding proof; verification must come from the exact connector/reviewer route.

## Acceptance criteria (Given / When / Then)

1. **Baseline automation:** Given auto mode and the published-compatible OAuth form, when setup runs, then pairing and Connect complete with zero routine user pairing actions and a verified exact workspace.
2. **Compatibility fallback:** Given runtime-only handoff is unavailable or incompatible, when setup runs in auto mode, then the bounded automatic compatibility path is used; no manual mode is inferred and no user is asked to paste a code.
3. **Handoff security:** Given the stronger handoff is selected, when an exact authorized OAuth request consumes it, then it succeeds once only; mismatched workspace, connector, origin, redirect, client, replay, expiry, or generic untrusted client is rejected without consuming an unrelated handoff.
4. **Project reconciliation:** Given no valid exact Project, when setup runs, then one Project is created with project-only memory, no sources, deterministic <=50 display label, and durable identity. Given settings drift, when setup runs again, then the same Project is repaired without duplication.
5. **Instruction routing:** Given Project settings and reviewer composer are simultaneously visible, when instructions are written, then only the Project Instructions settings control receives them; a navigation failure produces bounded recoverable failure and never falls back to the composer; saved settings can be re-read and verified.
6. **Reviewer binding:** Given a fresh reviewer chat, when its first MCP-dependent message runs, then exact app selection and `workspace_info`/`git_status`/`git_diff` evidence match repository, root, branch, HEAD, connector identity, and read-only capability; mismatch stops the review.
7. **E2E proof:** Given a fresh workspace on the actual ChatGPT product surface, when the production path is exercised, then all R1/R4/R5/R7 evidence is captured without routine user pairing action and without `WORKSPACE_MISMATCH`.
8. **No regression:** Given the published baseline succeeds automatically, when the redesigned Full Auto path is compared, then the number of routine user actions does not increase.

## Edge cases and failure behavior

- Missing handoff capability: automatically use compatibility path; only classify `C2C_CAPABILITY_UNAVAILABLE` if no safe automatic path is available.
- Expired, rejected, replayed, or `no_active_session` value: mint one fresh bounded value and retry once within the canonical retry bound; never loop indefinitely.
- Generic client, wrong callback, mismatched binding, or unexpected scope: fail closed and preserve the existing exact connector.
- Project name collision, shortened-label collision, wrong collection, or ambiguous owner: fail closed; do not choose by display name.
- Composer visible during settings navigation: never use it as fallback.
- Login/CAPTCHA/2FA/password/recovery/SSO/ownership ambiguity: stop at the named human boundary with one precise action.
- Existing polluted/partial reviewer chat: create a fresh chat in the same exact Project; never reinterpret old messages as settings.
- Local doctor green but remote connector stale: verify through the connector; do not accept local health alone.
- Candidate cleanup or reconstruction changes source semantics: return to the applicable canonical review stage; do not assume old C2C evidence.

## Rollback and migration concerns

- Keep `4843366f…`, its worktree, tests, and pairing diagnostics as recovery evidence; do not publish or delete them in this requirements step.
- Preserve the published baseline compatibility path until real E2E acceptance is recorded.
- If the stronger handoff fails E2E, disable it for auto mode and retain compatibility fallback; do not convert auto mode to routine manual setup.
- A future implementation must be based on this successor workstream's approved Issue and plan, not by cherry-picking the old candidate wholesale.

## Open questions and deferred implementation choices

- **Q408 (non-blocking implementation choice):** choose the deterministic normalization algorithm (for example, stable truncation plus collision-resistant suffix) while preserving the `<=50` contract and durable identity. The product invariant is settled; the algorithm belongs in the approved plan.
- **Q409 (operational E2E detail):** select the exact fresh-workspace fixture and live ChatGPT Project/account session at Step 3/5 setup time. The acceptance surface and no-routine-user-action rule are settled here; account ownership and any login/2FA boundary remain runtime facts.

No implementation, Issue creation, connector mutation, or publication is authorized by this artifact. The next canonical transition is the Step 1 Requirements approval Human Gate.
