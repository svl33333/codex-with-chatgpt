# C2C Transport Context

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
