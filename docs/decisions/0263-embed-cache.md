# ADR-0263: EmbedCache — idempotent content-hash + model-tag embed cache

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0159 (`@/retrieval` slice — embedding port lives there),
  ADR-0249 (sibling under `~/.quanta/...` with 0600/0700 mode discipline),
  ADR-0238 (Bun adapter idiom this slice mirrors for the sqlite backend).
- **References**:
  `src/retrieval/cache/types.ts` (typed `EmbedCacheHit`, `CacheKey`, `CacheError`),
  `src/retrieval/cache/port.ts` (closed `EmbedCache` port — 5 methods),
  `src/retrieval/cache/hash.ts` (Web Crypto SHA-256, `makeCacheKey`,
  `isCanonicalModelTag`),
  `src/retrieval/cache/in-memory-lru.ts` (`Map`-backed LRU adapter,
  default cap 10000, configurable),
  `src/retrieval/cache/sqlite-cache.ts` (`bun:sqlite` durable adapter,
  `~/.quanta/embed-cache.db` 0600, default TTL 30 days),
  `src/retrieval/cache/none-cache.ts` (default-OFF byte-identical "no cache"),
  `src/retrieval/cache/registry.ts` (env-driven swap —
  `QUANTA_EMBED_CACHE=in-memory|sqlite|none`),
  `src/retrieval/cache/index.ts` (slice barrel),
  `tests/unit/retrieval/embed-cache-hellgate.test.ts` (15 hellgate cases + 2
  extra invariant proofs).

## Context

The embedding port (ADR-0159 Axis D) re-embeds every text on every call:
no cache, no de-dup. A long-running retrieval session can re-embed the
same chunk dozens of times against the same provider/model, and a
provider/model swap silently invalidates nothing — there's nothing
keyed to provider/model to invalidate. Embeddings are pure functions of
(text, model) so the cache key MUST include the model identity.

Existing competitor pattern (Codex / Claude) keys cache entries by
`hash(text) + ":" + modelTag` so a provider/model swap automatically
invalidates every stale entry. quanta has no equivalent — every embed
hits the network even on identical re-queries.

This ADR ships the slice primitive (closed port + 3 adapters + env-driven
swap + 15-case hellgate). Wiring into `commit-embedder` / `hybrid-query`
and into the composition root is a separate ADR — that's why this slice
ships **default-OFF**: the `none` adapter is the wire by default, so until
a caller flips `QUANTA_EMBED_CACHE=in-memory|sqlite`, the embed pipeline
is byte-identical to the pre-ADR behaviour.

## Decision

Closed `EmbedCache` port at `src/retrieval/cache/port.ts` with 5 methods
(`get / put / invalidate / size / clear`); three adapters (`in-memory`
LRU, `sqlite` durable, `none` default-OFF); env-driven wire swap; hellgate
15 cases.

### Key shape

`CacheKey = "{sha256(text)}:{modelTag}"` — `modelTag` is part of the key
so a provider/model swap automatically misses every old entry. The async
SHA-256 helper (`hashText`) is exported for callers that want the
external API; adapters use a sync fast-hash internally (FNV-1a-mix) for
hot-path latency, with a collision guard that compares the original
`text + modelTag` before returning a hit (so a sync-hash collision
costs at most a re-embed, never a wrong vector).

### `modelTag` canonical format

`{provider}-{modelPart}-v{version}-d{dim}` — `provider` and `modelPart`
are `[a-z0-9]+` segments (`modelPart` may span multiple `-` segments,
e.g. `text-embedding-3-small`), `version` is `v\d+`, `dim` is `d\d+`.
The version segment MUST precede the dim segment. `isCanonicalModelTag`
is a user-callable check; adapters do NOT validate on every call (cache
correctness doesn't depend on the tag being canonical — it depends on
the tag being CONSISTENT across put/get).

### Adapter wire (env)

`QUANTA_EMBED_CACHE` ∈ `in-memory | sqlite | none`. Unset defaults to
`none`. Unknown values fall back to `none` (default-OFF posture).

### sqlite layout

`~/.quanta/embed-cache.db` (dir 0700, file 0600). Single table
`embed_cache(key TEXT PK, text TEXT, model_tag TEXT, vector BLOB,
cached_at INTEGER)`. Vector is packed Float64 little-endian
(8 bytes/dim) — byte-exact round-trip, no JSON quantisation. Indexed
on `model_tag` (for `invalidate(tag)`) and `cached_at` (for future
TTL sweep). Default TTL 30 days; expired rows are filtered on `get`
AND lazily deleted so disk doesn't accumulate stale embeddings.

### `none` adapter

Every `get` returns `null`, every `put` is a no-op, `size()` is always
`0`. Wiring this when no env override is set keeps the cache feature
byte-identical to "no cache" — embed calls bypass the cache lookup
entirely.

## Invariants (hellgate-enforced)

1. **Round-trip purity** — `put(text, tag, v)` then `get(text, tag)`
   returns a vector `deepEqual` to `v`, NOT aliased (caller mutation
   does not poison cache).
2. **Tag isolation** — same text different `modelTag` is a miss; never
   a cross-model false hit.
3. **LRU bound** — `size() <= capacity` always; oldest entry evicted
   first.
4. **Tag-scoped invalidate** — `invalidate(tag)` returns count removed
   and touches ONLY that tag's entries.
5. **0600 + TTL + persistence** — sqlite file mode is `0600`; entries
   past `ttlMs` return null on read; entries survive process restart.
6. **Surface parity** — in-memory and sqlite expose the IDENTICAL
   `EmbedCache` surface (LSP).
7. **Default-OFF** — `none` adapter is the wire by default; byte-identical
   to no-cache.
8. **Canonical tag** — `isCanonicalModelTag` accepts well-formed tags
   and rejects mis-ordered / missing segments.

## Consequences

**Positive.** Provider/model swap is now a one-call invalidation
(`cache.invalidate(oldTag)`) instead of a silent corruption hazard.
Idempotent embed pipelines stop re-paying for identical (text, model)
pairs. The sqlite backend survives `--continue` resume flows. Default-OFF
means no behaviour change until callers explicitly opt in.

**Negative.** Adds a slice that downstream code MUST eventually wire
through. Until the wire ADR lands, the cache exists but is dead-code
in production (the chosen safety net — see "default-OFF" above).

**Neutral.** The sync fast-hash trades cryptographic key uniqueness for
hot-path latency; the collision guard preserves correctness at the cost
of a re-embed on rare collisions. The public `hashText` (Web Crypto
SHA-256) is available for callers that need the cryptographic guarantee.

## Out of scope (explicit non-goals)

- **Embed pipeline wiring** — `commit-embedder` / `hybrid-query` keep
  re-embedding until a follow-up ADR threads the cache through.
- **Composition root wiring** — the env-driven swap exists; nothing
  in `src/apps/` consults it yet (callers wire it in their assembly).
- **Cross-process locking** — sqlite WAL provides cross-process safety
  for the durable adapter; the in-memory adapter is per-process by
  construction.
- **TTL sweep job** — expired rows are deleted on read; no background
  sweep yet (the index on `cached_at` is the seam a future sweep would
  use).
- **Multi-vendor key collision** — `modelTag` is the disambiguator; if
  two vendors happen to ship the same `provider-model-vN-dD` string the
  cache will conflate them (operators MUST keep tags unique, and the
  canonical-format check is the first line of defence).

## Catalog

`tools/feature-catalog/features/04-context-management/embed-cache.yaml`
(`adrs: [263, 254]` — 254 is the embedding-pipeline ADR this cache is
wired to in a follow-up).
