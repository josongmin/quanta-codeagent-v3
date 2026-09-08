# R12 receipt — session typed boundary

Status: **implemented**. I-stage applied protocol barrel + SDK runtime verb pin. Kernel event-log already refuses non-torn corrupt decode. Not W7 `verified`.

Lane: W3-C. Single writer on local `main`. NO COMMIT.

## Findings

### C-F2

- `HOST_ONLY_SESSION_COMMANDS = ["turn.submit"]`.
- `SessionVerbSurface` + wire `handle-verbs.ts` + in-process `handle-adapter.ts` expose `objective.mutate` / `posture.set` / `skill.setEnabled`.
- `handle.ts` 880 → **811** (verbs extracted before adding them). Not in 900–999.

### C-F11

- `assertSessionEventPayload` covers every `SESSION_EVENT_TYPES` discriminant.
- `approval:null` → `bad_event_approval_null`.
- Exhaustive valid + missing-required table in owner tests.
- Corrupt replay: `decodeSessionEvent` throws; kernel `event-log-jsonl.ts` already refuses (does not skip/rewrite). **Torn final line** still truncates — unchanged policy, recorded here.

## Tests

`bun test tests/unit/sep8-remediation/r12 tests/unit/protocol/session-codec.test.ts tests/unit/ipc/session-handle-conformance.test.ts` GREEN.

## I follow-up (outside R12 write-set)

`src/sdk/runtime/types.ts` and `session.ts` gained the three verbs so `RuntimeSession` still satisfies the surface (compile pin).
