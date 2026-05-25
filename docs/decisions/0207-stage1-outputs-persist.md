# ADR-0207: Stage1 outputs 2-Phase memory persistence

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0068 (2-phase memory consolidator — the parent slice this
  extends), ADR-0131 (4-state memory outcome enum).

## Context

Codex's `stage1_outputs` sqlite table persists per-thread Phase 1
distillations across runs. The schema, verbatim from the production
dump (`/.extracted_source/userdata/codex/memories`):

```
thread_id PK, source_updated_at, raw_memory, rollout_summary,
generated_at, rollout_slug, usage_count, last_usage,
selected_for_phase2, selected_for_phase2_source_updated_at
```

quanta's ADR-0068 ships `src/memory/consolidate/phase1.ts` that
produces a `Stage1Output` row and pushes it through the existing
async-Promise `Stage1StorePort` (`upsert` / `fetchSince` /
`countSince` / `getWatermark` / `setWatermark`) — the
SQLite-watermark-oriented surface. That port has NO usage tracking,
no prune, no per-thread `get(threadId)` lookup, and no LRU eviction.
The consequence is that every Phase 2 run reads the entire watermark
window and every "is this thread still selected?" query reconstructs
the row from scratch.

The Codex `stage1_outputs` shape is the missing usage/selection layer
on top of the watermark store: it's a per-thread cache that records
how many times Phase 2 has consumed the row (`usage_count`,
`last_usage`), records which rows are queued for the NEXT phase 2
(`selected_for_phase2` + a `*_source_updated_at` snapshot so the
selection is invalidated if the source thread mutates), and supports
ranked pruning.

The two surfaces are intentionally different. Consolidating them
would couple the watermark/promotion path (async, SQLite-bound, used
by Phase 1's `store.upsert` and Phase 2's `fetchSince`) to the
usage/selection path (sync, in-memory or JSONL-backed, used by a
future scheduler that decides "which threads do we re-distill?" /
"which threads do we evict?"). They are SIBLING ports; this ADR
introduces the second one.

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** Phase 1 (`phase1.ts`) and Phase 2
  (`phase2.ts`) are UNCHANGED. Until a caller wires a
  `Stage1OutputsStore` and calls `.put()` after `runPhase1` completes
  (and `.markSelectedForPhase2()` when Phase 2 selects the entry),
  the consolidator behaves exactly as it does today — every byte of
  the existing pipeline is preserved.
- **`exactOptionalPropertyTypes: true`.** The `Stage1Entry` field
  `selectedForPhase2SourceUpdatedAt` is conditional-spread (no
  `undefined` literal slot); the optional `?` denotes
  absent-vs-present, never "present with undefined".
- **Closed-port DIP.** `Stage1OutputsStore` is the closed port.
  In-memory and JSONL-file adapters are the two default impls;
  callers receive only the port type. Adding a future
  sqlite-backed adapter never reaches into either default impl.
- **Slice boundary.** Lives at `src/memory/stage1-store/` —
  parallel to `src/memory/consolidate/`, never importing it.
  `consolidate/phase{1,2}.ts` remain READ-ONLY in this ADR (a
  separate wire-up track in `@/agent` is the only path that calls
  into both slices, per RFC §3.1 layering).
- **No silent mutation.** `get()` and `list()` return frozen rows;
  `touch()` / `markSelectedForPhase2()` produce a NEW frozen row
  rather than mutating the prior reference.

## Decision

Stand up a new sibling slice `src/memory/stage1-store/` (5 files)
exposing the Codex `stage1_outputs`-shape persistence port plus two
default-impl adapters.

```
src/memory/stage1-store/
  port.ts          — `Stage1OutputsStore` closed port
  types.ts         — `Stage1Entry` (10 fields, mirrors Codex schema)
  in-memory.ts     — Map-backed default; tests + dev default
  jsonl-file.ts    — `~/.quanta/memory/stage1.jsonl` append-only + load
  index.ts         — barrel
```

Public surface (`Stage1OutputsStore`):

```ts
interface Stage1OutputsStore {
  get(threadId: string): Stage1Entry | null
  put(entry: Stage1Entry): void
  touch(threadId: string): void
  markSelectedForPhase2(threadId: string, sourceUpdatedAt: number): void
  list(filter?: { selectedForPhase2?: boolean; minUsage?: number }):
    readonly Stage1Entry[]
  prune(opts: { olderThanMs?: number; maxEntries?: number }): number
}
```

Public shape (`Stage1Entry`, mirrors Codex column-for-column except
camelCase + TS optional for the snapshot column):

```ts
interface Stage1Entry {
  readonly threadId: string                      // PK
  readonly sourceUpdatedAt: number               // source_updated_at
  readonly rawMemory: string                     // raw_memory
  readonly rolloutSummary: string                // rollout_summary
  readonly generatedAt: number                   // generated_at
  readonly rolloutSlug: string                   // rollout_slug
  readonly usageCount: number                    // usage_count
  readonly lastUsage: number                     // last_usage
  readonly selectedForPhase2: boolean            // selected_for_phase2
  readonly selectedForPhase2SourceUpdatedAt?: number  // OMIT semantics
}
```

Semantic mapping (operation → adapter behavior):

| op                          | in-memory                                        | jsonl-file                                                 |
|-----------------------------|--------------------------------------------------|------------------------------------------------------------|
| `get(id)`                   | `Map.get`                                        | `Map.get` over hydrated map                                |
| `put(entry)`                | replace (overwrite) under `threadId`             | replace + append `{op:"put",entry}` line                   |
| `touch(id)`                 | `usageCount+=1`, `lastUsage = now`               | replace + append `{op:"touch",threadId,lastUsage}` line    |
| `markSelectedForPhase2`     | `selectedForPhase2 = true`, snapshot SUA         | replace + append `{op:"mark",threadId,sua}` line           |
| `list(filter)`              | `Array.from(map.values()).filter`                | same over hydrated map                                     |
| `prune({olderThanMs})`      | drop where `now - generatedAt > olderThanMs`     | rewrite jsonl with surviving rows on next compact          |
| `prune({maxEntries})`       | LRU drop by ascending `lastUsage`                | same                                                       |

`touch` and `markSelectedForPhase2` accept a missing key as a no-op
(the entry was pruned out from under the caller; the contract is
fire-and-forget); `get` is the only read path that signals absence
(returns `null`).

The jsonl-file adapter:

- File path: `~/.quanta/memory/stage1.jsonl` (created on first put;
  `0700` for the dir, `0600` for the file).
- On construction it reads the entire file, applies each operation
  in order to rebuild the map (`put` replaces, `touch` and `mark`
  mutate the current entry-if-any), skipping any line that fails
  `JSON.parse` or fails the shape guard. Skipped lines emit ONE
  warning via the injected logger sink (default no-op) — never throw.
- Writes are append-only one-line JSON. There is no fsync barrier;
  durability is best-effort at this tier (memory cache layer, not a
  source-of-truth ledger). A future sqlite adapter is the durability
  story when needed.
- `prune` does NOT rewrite the file in-place (no compaction). The
  on-disk representation is allowed to grow until a deliberate
  compaction pass (out of scope here) consolidates it; the in-memory
  hydrated map IS the source of truth after construction.

Default-OFF wiring posture:

- No barrel re-export from `@/memory` in this ADR. The slice is
  reachable as `src/memory/stage1-store/index.ts` directly by the
  composition root (apps layer) and by tests. A future ADR adds the
  `@/memory` re-export when a caller in `@/agent` wires it.
- No mutation to `phase1.ts` / `phase2.ts` / `store.ts` /
  `types.ts` of the consolidate slice. The wire is a one-liner the
  caller adds AFTER `runPhase1` returns `kind:"distilled"`:
  `stage1Out.put({...mapStage1OutputToEntry(outcome.stage1), generatedAt: now()})`.

## Hellgate (15 cases, all default-OFF)

`tests/unit/memory/stage1-store-hellgate.test.ts`:

| id           | seal                                                                        |
|--------------|-----------------------------------------------------------------------------|
| HELL-S1-01   | `put` + `get` round-trips an entry verbatim (frozen)                        |
| HELL-S1-02   | `get` of unknown threadId → `null`                                          |
| HELL-S1-03   | `touch` increments `usageCount` and stamps `lastUsage` to clock             |
| HELL-S1-04   | `markSelectedForPhase2` sets the flag AND snapshots `sourceUpdatedAt`       |
| HELL-S1-05   | `list({selectedForPhase2:true})` returns only the marked subset             |
| HELL-S1-06   | `list({minUsage:5})` returns only `usageCount >= 5`                         |
| HELL-S1-07   | `prune({olderThanMs:X})` evicts entries whose `generatedAt` is older than X |
| HELL-S1-08   | `prune({maxEntries:N})` evicts LRU by ascending `lastUsage` until `<= N`    |
| HELL-S1-09   | `put` of duplicate `threadId` overwrites (replace semantics)                |
| HELL-S1-10   | jsonl-file: `put` → instantiate fresh adapter over same file → identical    |
| HELL-S1-11   | jsonl-file: corrupted line skipped + warned; subsequent valid lines applied |
| HELL-S1-12   | jsonl-file: backing file is `0600` (owner-only RW)                          |
| HELL-S1-13   | returned entries are frozen; mutation attempt throws in strict mode         |
| HELL-S1-14   | `prune` over 1000 entries completes within an order-of-magnitude budget     |
| HELL-S1-15   | `selectedForPhase2SourceUpdatedAt` is OMITTED (not `undefined`-property)    |

## Consequences

- **+ Parity** with Codex's `stage1_outputs` usage/selection layer —
  the missing "which threads do we re-distill / evict" surface.
- **+ Sibling-port shape** keeps the watermark-oriented
  `Stage1StorePort` single-purpose; future scheduler that wants both
  selection AND watermark composes the two ports, neither one carries
  the other's complexity.
- **+ Default-OFF until wired.** Until the apps layer constructs a
  `Stage1OutputsStore` and threads it into the session-end hook, the
  consolidator is byte-identical.
- **−** Two write paths to memory state until a future ADR
  consolidates: existing watermark-store sqlite + new
  jsonl-file stage1-store. Acceptable trade-off — the two paths
  encode different domains (watermark vs usage cache) and the read
  paths never overlap.
- **−** JSONL grows monotonically until a compaction pass exists.
  Mitigated by `prune` reducing the in-memory map; the on-disk
  growth is bounded by the rate at which Phase 1 emits.

## Follow-up

- `@/agent` wire-up in a separate ADR: call `stage1Out.put(...)`
  after `runPhase1` returns `kind:"distilled"`; call
  `stage1Out.markSelectedForPhase2(threadId, sourceUpdatedAt)` when
  Phase 2 picks the row; call `stage1Out.touch(threadId)` when Phase
  2 reads the row.
- Sqlite-backed adapter for durability + indexed `list({...})`
  queries — same closed port, no caller-visible change.
- Periodic compaction job that rewrites the jsonl with the current
  hydrated map (no longer append-only) when on-disk size exceeds a
  cap.
