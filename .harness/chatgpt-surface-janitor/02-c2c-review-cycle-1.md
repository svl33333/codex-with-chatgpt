# C2C review evidence — cycle 1

Result: `FIX_REQUIRED` on the first revised pre-implementation draft.

The independent C2C reviewer confirmed that the strict store, digest lifecycle,
janitor capability matrix, migration direction, documentation, and broad test
matrix were materially improved. It required six further changes before
implementation: select a runnable browser process/transport/profile path and
probe it read-only; bind plans to a non-secret authenticated-account
fingerprint; close the final protection-state race with a shared writer and
finalization lease; restore explicit keep/output/rescan semantics; define
one-shot prepared-token and crash-safe lease lifecycles; and preserve the
machine-wide command convention that accepts and ignores leftover `-w`.

The revised draft selects a dedicated Playwright Chromium profile, stdio child
protocol, visible login/2FA human boundary, and bounded unsupported outcome.
It also adds account binding, shared protection-state finalization, output
contracts, token/lease lifecycle, and compatibility tests. The complete review
is retained in the C2C Project conversation, which is the canonical
independent-review record.
