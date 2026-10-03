# Project display-name compatibility evidence

- Observed surface: current ChatGPT Project creation form.
- Product constraint: display names are limited to 50 characters on the
  currently observed surface.
- Rejected historical value: the previously requested
  `codex-with-chatgpt-a0-chatgpt-surface-compatibility` value is 51 characters
  and cannot be submitted there.
- Approved bounded replacement:
  `codex-with-chatgpt-a0-surface-compatibility`.

## Identity and normalization contract

This is display-name compatibility normalization only. The durable workstream
identity remains `a0-chatgpt-surface-compatibility`; repository, local
workspace, branch, connector identity, and workflow checkpoint are separate
records and remain unchanged.

The provisioning layer should validate a generated Project display name before
opening/submitting the form. If it exceeds the observed limit, it applies one
deterministic, collision-safe bounded replacement selected from the workstream
policy. Reconciliation still requires the verified workspace, repository,
installation, connector, and Project context. A display name alone is never
authorization, ownership, or equivalence proof.

## Deterministic test cases for the permitted implementation stage

1. A generated name of exactly 50 characters is accepted unchanged.
2. The historical 51-character value is rejected or normalized before form
   submission, and repeated normalization returns the same approved value.
3. The approved replacement is at most 50 characters and retains a stable
   mapping to the full logical workstream identity.
4. Two workstreams whose normalized labels would otherwise collide remain
   distinct through their workspace/connector binding; no display-name-only
   lookup reuses either Project.
5. A similar display name with a different workspace, repository, or connector
   is classified as non-equivalent and is not mutated.
6. Project-only memory and disabled unrelated sources are asserted for the
   exact reconciled Project without changing another Project.

This artifact records design and acceptance-test intent only. No A0 source,
A2 source, connector, or workflow checkpoint is changed by this note.
