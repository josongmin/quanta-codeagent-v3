# R12 integration delta — APPLIED (W3-I)

Status: **applied**.

## Protocol barrel (`src/protocol/session/index.ts`, reserved basename)

Export `HOST_ONLY_SESSION_COMMANDS`.

## Kernel event-log (`src/kernel/session/event-log-jsonl.ts`)

No code change required. `decodeSessionEvent` now validates payloads; `session.state.updated` and snapshot decode require `state.status`. Existing `loadAndRecover` already throws `JsonlSessionEventLogCorruptionError` on non-torn decode failure (does not skip). Torn-final-line truncate remains.

## SDK runtime (pin)

`src/sdk/runtime/types.ts` / `session.ts` implement the three verbs so in-process `RuntimeSession` matches `SessionVerbSurface`.
