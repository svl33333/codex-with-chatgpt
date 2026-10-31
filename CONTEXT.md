# Workspace compatibility glossary

## Terms

- **Workstream identity**: The durable logical identity of one Codex task. It
  is independent from any ChatGPT Project label, chat URL, connector title, or
  temporary endpoint.
- **Workspace binding**: The verified relationship among a workstream, local
  workspace, canonical repository, installation identity, endpoint identity,
  and the exact read-only ChatGPT connector.
- **Project display label**: A bounded human-facing ChatGPT Project name. It
  is validated and normalized for the current product surface, but it is never
  ownership proof or a substitute for the workspace binding.
- **Surface observation**: A sanitized observation of a supported ChatGPT
  route, its origin/account/workspace verification, policy status, browser
  availability, and semantic capabilities.
- **Current-message app selection**: Evidence that the exact connector/app was
  selected for one fresh MCP-dependent message. It is keyed by the same
  delivery idempotency identity as that message and is not inferred from a
  persistent Project binding or an earlier successful call.
- **Readiness proof**: Explicit account, workspace, repository, permission,
  Project, and current-message evidence required before a live binding can be
  classified as ready. Missing proof remains pending/recoverable.
- **Consent guard**: A structured, machine-verifiable decision for the expected
  ChatGPT connector warning. Warning text alone is never authority; automatic
  confirmation requires explicit C2C/automatic context, the exact workspace
  binding, resolved account and ownership, the runtime-owned read-only scope
  set, and no login, CAPTCHA, unsupported-2FA, destructive, or ambiguous-account
  boundary.
- **Immutable runtime release**: A validated reviewed commit published under a
  new non-rewritable custom tag. Its package version, provenance, and Skill
  digest identify the same release; a TeamAI pin update is a separate action.

## Boundary decisions

- Similar Project display labels are not equivalent resources.
- A stale UI route is route drift, not global capability loss.
- Reconciliation preserves the existing mutation checkpoints; compatibility
  outcomes are a higher-level classification.
- A mutable custom-fork branch is not an approved runtime update; immutable tag
  and review evidence are required before adoption.

## C2C transport and delegation vocabulary

This context defines the vocabulary for reliable active-session control-message
transport between ChatGPT and Codex. It describes domain meaning and trust
boundaries, not implementation details.

## Work and identity

**Workstream identity**:
The stable identity of one development stream, including its exact repository
and workspace checkout.
_Avoid_: task name, chat title

**C2C task identity**:
The identity of one protocol loop, including its task/checkpoint, canonical
workflow step/stage, iteration, and logical message event.
_Avoid_: conversation memory, latest message

**Workspace identity**:
The exact workspace, repository, root, and checkout identity to which a C2C
connector is authorized.
_Avoid_: project display name, current folder guess

**Project/chat/session identity**:
The exact ChatGPT Project, conversation, and Codex session binding for one
active transport route.
_Avoid_: Project or chat display name alone

**Connector/binding identity**:
The exact connector and its verified workspace, repository, installation,
endpoint, account, and ownership binding.
_Avoid_: connector label alone

## Transport authority

**Control-message envelope**:
A small structured C2C event containing state, identifiers, bounded metadata,
and instructions to fetch evidence through MCP.
_Avoid_: pasted diff, log, source body

**Delivery authorization**:
A durable permission for one allowlisted logical outbound event bound to all
required work, workflow, workspace, chat, connector, and idempotency identities.
_Avoid_: C2C enabled flag, user acknowledgement

**Delivery receipt**:
The durable lifecycle and evidence record for one authorized event, including
whether it was prepared, sent, observed remotely, awaiting a response, or
reconciled.
_Avoid_: browser call result alone

**Remote delivery evidence**:
Sanitized observable evidence that the exact event appeared once in the exact
bound chat and, when applicable, that its response belongs to the expected
checkpoint and stage.
_Avoid_: generic page text, model memory

**Routine bounded transport**:
An allowlisted INIT, HANDOFF, PLAN, EXECUTED, REVIEW, or re-review event whose
durable authorization and identities still match.
_Avoid_: arbitrary browser automation

**Transport defect**:
Partial, multiply delivered, ambiguous, or otherwise non-atomic transport of
one logical event; it is recorded separately from review correctness.
_Avoid_: a reason to send a continuation fragment

**Delegation grant**:
A durable, versioned, least-authority predicate for one closed action class.
It records exact scope, grant-specific approval provenance, a time window, and
a finite-use budget. A grant is not an A0 delivery authority and cannot
approve a Human Gate.

**Delegation reservation**:
A grant-scoped durable `RESERVED → CONSUMED` or `RESERVED → RELEASED`
transaction. Transport commits at persisted A0 authority; local reads and
known-operation reconciliation commit at their durable proof/result boundary.

**Decision proof**:
A bounded serializable allow/deny record containing digests, expiry, and typed
reasons. It is evidence for a later consumer, never an authority token or a
substitute for the canonical A0 issuer.

**Action-specific provider evidence**:
TeamAI `github-cli-auth` account/capability evidence is required only when the
classified operation path depends on it. `workspace_read`, current
provider-free `c2c_transport`, and local persisted-evidence reconciliation do
not resolve or require GitHub authentication.

## Boundaries

**Rehydration**:
Reconstruction of transport authority from the canonical workflow, durable
workstream/session state, exact identities, and typed delivery records after a
session or browser lifecycle interruption.
_Avoid_: restoring authority from summarized prose

**Genuine Human Gate**:
A canonical requirements/visual/push/merge decision or an authentication,
consent, ownership, or security-sensitive boundary that must stop automation.
_Avoid_: routine bounded message delivery
