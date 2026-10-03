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

## Boundary decisions

- Similar Project display labels are not equivalent resources.
- A stale UI route is route drift, not global capability loss.
- Reconciliation preserves the existing mutation checkpoints; compatibility
  outcomes are a higher-level classification.
