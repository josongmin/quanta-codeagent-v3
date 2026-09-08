# W4-I receipt

Status: **W4 implemented on local `main`**. Findings implemented. **Not** W7 `verified` 39/39. Push 없음. 제품 커밋은 별도 요청.

Merge order: **R03 → R06 → R10**, then reserved/I wiring. Single writer.

source HEAD snapshot (W3 land, W4 uncommitted on top): `f3a93d5fd22855951ef4f871813e2b55b0f41b0c`

## Findings

| ID | Result |
|---|---|
| SEP7-D-05..D-10 | session generation/index recovery/typed read/column-local BLOB |
| G-F4 | ticker reclaim + same-token heartbeat |
| E-SEARCH-01 / E-EMBED-01 | typed unavailable + EmbeddingSpace + persist bind |

## I applied

R03: `persist-turn.ts` swallows `StaleSessionGenerationError` (turn survives, no resurrection). `src/session/index.ts` exports `readSessionByIdTyped`, `StaleSessionGenerationError`, `SaveSessionOptions`. `session-ops` already calls owner `deleteSession`. `runtime.ts` already throws on rehydrate refuse before session assembly — no fresh autosave.

R06: ticker defaults reach live rail without agent-slot edits. CLI `automation-banner` observes `ownership-lost`. Completion is not inferred from a raw `engine.claim`.

R10: `mention-symbol-deps.ts` rethrows `SemanticBackendUnavailableError` (hellgate E3). Empty index remains null no-hit.

## Remaining (not W4)

- G-F5.4 EC2 실기 OPEN
- G-F9.4 live Docker/Lima daemon / F-13.2 two-process (W3 leftover, excluded)
- W5–W7
- Windows flock, Lance/Qdrant space sidecar
- Global `prepush` not claimed as W4 closeout
- No W7 verified 39/39 claim
