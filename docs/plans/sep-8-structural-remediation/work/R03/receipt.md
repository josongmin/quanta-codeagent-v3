# R03 receipt — session/memory persistence

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W4-A. W7 follow-up extends the mutation fence across processes.

source HEAD snapshot: `f3a93d5fd22855951ef4f871813e2b55b0f41b0c`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `src/session/store.ts` 590 (schema/read split; left 900–999 band) |

## Findings

| ID | Result |
|---|---|
| SEP7-D-05 | per-session queue + stable flock own snapshot/delete; durable generation/tombstone; `{ create: true }` only recreates; late same-process or fresh-process autosave → `StaleSessionGenerationError` |
| SEP7-D-06 | snapshot = original, index = projection; invalid sidecar; upsert recovers from valid snapshots; unreadable index throws, not empty list |
| SEP7-D-07 | typed `found \| missing \| corrupt \| unreadable`; `loadSessionById` convenience collapse; durable resume refuses corrupt/unreadable |
| SEP7-D-10 | explicit mutable-only `MemoryPatch`; shared runtime validator; column-local UPDATE; omitted `embedding` keeps raw BLOB and own-key `undefined` clears it identically in memory/SQLite |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r03/ tests/integration/sep8-remediation/r03/
```

Parked save → delete waits → late old save refused. Fresh delete process → fresh stale-save process is refused; explicit create advances the durable generation. Corrupt index recovered on unrelated upsert. Corrupt JSON → `ResumeRehydrateRefusedError`, bytes unchanged. BLOB `00` survives text-only update.

## Unverified / out of scope

- Windows flock runtime proof
- Session repository + memory sqlite merged store
