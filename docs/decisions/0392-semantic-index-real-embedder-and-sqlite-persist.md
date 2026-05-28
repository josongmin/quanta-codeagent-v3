# ADR-0392 — Semantic index real embedder wiring + sqlite delta persist

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0261 (pluggable Embedder + VectorStore registry),
ADR-0265 (SearchPipeline composer), ADR-0277/0278 (search-surface wire +
codebase indexer)
**Slice:** `src/runner/assemble/search-index-backend.ts` (new) +
`src/runner/assemble/search-pipeline.ts` (wire edit) + hellgate.
**Default-OFF:** Yes — with no `QUANTA_EMBED_PROVIDER` and no
`QUANTA_INDEX_PERSIST` the wire is byte-identical to the pre-ADR-0392
`hashEmbed` + in-memory path.

## Context

The productized search wire (ADR-0277/0278) builds a semantic index when
`QUANTA_INDEX=on` selects a semantic preset. But that index was wired to a
**placeholder embedder** — a 64-dim FNV-hash bag-of-tokens (`hashEmbed`)
defined inline in `search-pipeline.ts`. Two real capabilities already
existed but were never reachable from the wire:

1. `createEmbedderFromEnv(env)` (ADR-0261) — selects a real embedder
   (openai / voyage / cohere / ollama / headless) from
   `QUANTA_EMBED_PROVIDER`, returning `null` when unset/unknown.
2. `createSqliteVssStore({ db })` (ADR-0261) — a `bun:sqlite`-backed
   `VectorStore` that persists vectors across process restarts.

The wire used neither: queries and upserts both ran `hashEmbed`, and the
index lived only in an in-memory `Map` discarded on exit.

## Decision

A new assembler primitive `search-index-backend.ts` splits the two seams:

1. **Embedder selection** — `selectIndexEmbedder(env)` returns the single
   `(text) => Promise<readonly number[]>` used for BOTH upsert vectors and
   the pipeline query embedder (they must agree or stored/query vectors
   come from different models). It calls `createEmbedderFromEnv(env)`:
   - `null` (no/unknown provider) ⇒ returns `hashEmbed` verbatim — the
     byte-identical default.
   - a real embedder ⇒ adapts `embed()`; **any** failure surface (err
     `Result`, empty vectors, thrown vendor error) degrades to `hashEmbed`
     for that call, so the wire never blocks or throws. Offline / missing
     API key therefore stays fully functional on the lexical-default path.

2. **Store selection** — `buildSemanticBackend(env, embed, db?)` returns
   the `{ port, upsert }` pair the wire feeds to the indexer + pipeline.
   Default is the legacy in-memory cosine map. When
   `QUANTA_INDEX_PERSIST=on` it persists deltas to a sqlite VectorStore
   (table `search_index_vss`); chunk text + path + line bounds ride in the
   store metadata so query hits reconstruct the pipeline `SearchHit` shape.
   The db is opened from `QUANTA_INDEX_DB_PATH` (or `:memory:` when absent)
   and is injectable for tests. A db-open failure degrades to in-memory.
   **This is the single new primitive.**

`startIndexer` in `search-pipeline.ts` now selects the embedder once and
hands the same function to both the backend (upserts) and the pipeline
`embedder` override (queries). The local `hashEmbed` / `newInMemoryIndex`
were moved into the new module (one definition, shared).

### New env knobs

```
QUANTA_INDEX_PERSIST=on        # opt-in: persist semantic index to sqlite
QUANTA_INDEX_DB_PATH=<file>    # optional db path (default :memory:)
```

The real-embedder path reuses the existing ADR-0261 `QUANTA_EMBED_PROVIDER`
knob (and its `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `COHERE_API_KEY`
siblings) — no new embedder knob is introduced.

## Consequences

- **Default-OFF byte-identical**: no `QUANTA_EMBED_PROVIDER` ⇒ `hashEmbed`;
  no `QUANTA_INDEX_PERSIST` ⇒ in-memory. Operators only opt in.
- **No-throw**: every real-embedder and sqlite failure logs + degrades;
  startup never blocks on a typo, a missing key, or an unreadable db.
- **Slice-fence honoured**: `search-index-backend.ts` is a `@/runner`
  assembler composing leaf `@/retrieval` engines/pipeline ports +
  `bun:sqlite` directly — same dependency direction as the sibling
  `./pipeline.ts` wire. No reverse edge is introduced.
- **Consistency invariant**: upsert and query share one embed function, so
  switching providers never silently mixes vector spaces.

## ADR-number note

The next free decision number at authoring time was 0391, but
`0391-mcp-transport-port-and-http-sse.md` landed in parallel. Per the
user-deference renumber policy this slice took the next free number,
0392.
