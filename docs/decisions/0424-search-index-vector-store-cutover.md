# ADR-0424 — Search-index VectorStore consumer cutover + LanceDB wire

- **Status**: Accepted
- **Date**: 2026-05-29
- **Companion to**: ADR-0261 (pluggable Embedder + VectorStore registry),
  ADR-0392 (semantic index real embedder + sqlite persist),
  ADR-0277/0278 (codebase indexer + search surface wire)
- **References**:
  `src/runner/assemble/search-index-backend.ts`,
  `src/runner/assemble/search-pipeline.ts`,
  `src/host/runtime/internal/mention-symbol-deps.ts`,
  `tests/unit/runner/search-index-backend.test.ts`,
  `tests/integration/search-pipeline-lance-wire.test.ts`,
  `tests/contract/lance-real-wire.test.ts`

## Context

ADR-0261 landed the sealed `Embedder` / `VectorStore` registries, including
`lance-store.ts`, but no production retrieval consumer actually called
`createStoreFromEnv()`. ADR-0392 wired only the embedder side plus a
sqlite-only persist branch:

- `QUANTA_EMBED_PROVIDER` affected the semantic index wire.
- `QUANTA_VECTOR_STORE` was still inert on live search paths.
- Real-embedder runtime failure degraded to `hashEmbed` (64-dim), which is
  dimensionally incompatible with any already-initialised fixed-dim store.
- Search-index retrieval emitted no embed/query latency metrics.

The result was partial landing: Lance/Qdrant adapters existed, but search
indexing could not select them structurally at the composition root.

## Decision

`search-index-backend.ts` becomes the owner consumer of the ADR-0261 store
registry.

### 1. Store selection

`buildSemanticBackend(env, embed, opts?)` now resolves:

- `QUANTA_VECTOR_STORE=in-memory|sqlite|lance|qdrant` via
  `createStoreFromEnv()`
- legacy fallback: when `QUANTA_VECTOR_STORE` is unset,
  `QUANTA_INDEX_PERSIST=on` still selects sqlite
- no store knob + no persist knob: legacy in-memory backend remains the
  byte-identical default

Provider-specific deps are projected from env at the same composition seam:

- `QUANTA_LANCE_BASE_URL`, `QUANTA_LANCE_TABLE`,
  `QUANTA_LANCE_API_KEY`, `QUANTA_LANCE_MAX_DIM`
- `QUANTA_QDRANT_BASE_URL`, `QUANTA_QDRANT_COLLECTION`,
  `QUANTA_QDRANT_API_KEY`, `QUANTA_QDRANT_MAX_DIM`

Explicit `QUANTA_VECTOR_STORE=...` requests now fail closed when the provider
name is unknown, required deps are missing, or capability negotiation rejects
the pair. The semantic backend is disabled for that explicit request instead of
silently aliasing back to the legacy in-memory path. Legacy implicit sqlite
selection through `QUANTA_INDEX_PERSIST=on` still degrades to legacy in-memory
when sqlite wiring is unavailable.

### 2. Fixed-dimension fallback

`resolveIndexEmbedder(env)` wraps the ADR-0261 embedder registry and exposes:

- the shared `embed(text)` function used by BOTH query-time embedding and
  index upserts
- async capabilities for store negotiation

Behavior:

- no/unknown provider ⇒ legacy `hashEmbed` (64-dim) default
- real provider selected ⇒ use the provider normally
- provider `embed()` failure / empty vector / throw ⇒ degrade to a
  deterministic headless embedder with the **same dimension** as the selected
  provider
- if provider capabilities themselves cannot be resolved ⇒ degrade to the
  legacy hash path

This removes dimensional drift when a real provider flakes while a fixed-dim
sqlite/Lance/Qdrant store is already active.

### 3. Stale-chunk reconciliation

Vector-backed stores do not expose "delete every chunk for this path" on the
sealed port, only `delete(ids)`. The search-index backend therefore owns a
chunk-id manifest:

- in-memory manifest for ephemeral backends
- sqlite manifest when a sqlite handle is available

The search wire tracks the exact path/chunk-id mutations that flowed through
the indexer’s `upsert/delete` stream for each scan batch and then calls
`backend.reconcileChanges(batch)`:

- remove manifest rows for deleted paths
- delete stale chunk ids that disappeared after file shrink / rechunk
- replace only the touched paths' manifest rows with the exact current chunk ids

This eliminates the prior full-corpus reconcile pass on every successful delta
scan.

Manifest updates are now delete-ack gated:

- if remote/vector delete fails, the manifest is left unchanged
- the next delete/reconcile attempt reuses the same stale ids
- stale chunk ids are never forgotten before the backing store confirms deletion

For remote persistent stores (Lance/Qdrant), restart-safe stale-chunk cleanup
requires a persistent manifest DB (`QUANTA_INDEX_DB_PATH`). Without it, the
wire stays functional but logs that stale-chunk cleanup is process-local only.

### 4. Metrics

An optional structural sink
`{ observe(name, value, labels?) }` records:

- `search.index.embed.latency_ms`
- `search.index.query.latency_ms`

CLI bootstrap adapts its legacy `Metrics` timer registry onto this sink.
Callers without metrics remain byte-identical.

### 5. Proof boundary

The Lance contract tier is split deliberately:

- `tests/integration/search-pipeline-lance-wire.test.ts` uses a stateful
  in-proc HTTP fixture to prove the live search/index consumer wire,
  restart-safe manifest cleanup, and stale-delete sequencing deterministically.
- `tests/contract/lance-real-wire.test.ts` uses real `python+lancedb`
  table/storage semantics behind a compatible REST shim. This proves the
  adapter/search wire against a real Lance backing store, including restart-safe
  stale cleanup when `QUANTA_INDEX_DB_PATH` is set.

The current contract proof does **not** claim a vendor-owned Lance daemon
binary. The sealed adapter remains shape-based by design; the contract tier
proves that shape against a real Lance persistence engine plus an HTTP bridge.

## Consequences

**Positive**

- LanceDB is now reachable from the real search/index consumer path.
- Embedder/store capability negotiation happens before the store is used.
- Provider flakiness no longer forces 64-dim fallback into a 1536/3072-dim
  store.
- Search/index latency becomes observable without importing observability into
  retrieval slices.
- Delete/reconcile retries are now structurally possible because manifest state
  no longer advances past failed remote deletes.
- Delta scans reconcile only touched paths instead of rebuilding the entire
  corpus manifest on every successful interval.

**Trade-offs**

- Remote persistent stores need a persistent manifest DB for restart-safe
  stale-chunk cleanup; otherwise cleanup is process-local only.
- The consumer cutover lives in `@/runner` assembly, not in the sealed
  retrieval leaf slices. That is intentional: leaf slices stay pure ports +
  adapters, composition owns env + fallback policy.
- Official Lance daemon/runtime behaviour can still diverge from the compatible
  shim used in tests. That risk is now explicit instead of being overstated as
  a stronger proof level than the repo actually has.
