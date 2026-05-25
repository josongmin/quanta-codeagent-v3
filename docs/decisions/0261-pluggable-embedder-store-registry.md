# ADR-0261: Pluggable Embedder + VectorStore provider registry

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0254 (in-memory cosine vector store — first-generation sibling),
  ADR-0159 (`@/retrieval` slice charter — leaf, depends on `@/shared` only),
  ADR-0160 (connectors REST adapter pattern, `fetch` without external libs).
- **References**:
  `src/retrieval/engines/embedder/port.ts` (closed `Embedder` port),
  `src/retrieval/engines/embedder/types.ts` (`EmbedResult`, `EmbedderCapabilities`,
   7-arm `EmbedError`),
  `src/retrieval/engines/embedder/openai-embedder.ts`,
  `src/retrieval/engines/embedder/voyage-embedder.ts`,
  `src/retrieval/engines/embedder/cohere-embedder.ts`,
  `src/retrieval/engines/embedder/ollama-embedder.ts`,
  `src/retrieval/engines/embedder/headless-stub.ts` (deterministic djb2 → Mulberry32),
  `src/retrieval/engines/embedder/registry.ts` (env-driven swap),
  `src/retrieval/engines/store/port.ts` (closed `VectorStore` port),
  `src/retrieval/engines/store/types.ts` (`StoredDoc`, `StoredHit`,
   `StoreCapabilities`, `Filter`, 5-arm `StoreError`),
  `src/retrieval/engines/store/in-memory-store.ts`,
  `src/retrieval/engines/store/sqlite-vss-store.ts`,
  `src/retrieval/engines/store/lance-store.ts`,
  `src/retrieval/engines/store/qdrant-store.ts`,
  `src/retrieval/engines/store/registry.ts`,
  `src/retrieval/engines/capabilities.ts` (negotiator),
  `src/retrieval/engines/index.ts` (barrel),
  `tests/unit/retrieval/engines-hellgate.test.ts` (25 cases).

## Context

ADR-0254 shipped a single in-memory cosine store and a single OpenAI-style
embedder. Production-grade retrieval requires the freedom to swap engines
without touching call sites:

- **Embedder**: OpenAI text-embedding-3, Voyage voyage-3, Cohere embed-v3,
  Ollama (local fallback), or a deterministic stub for tests.
- **Vector store**: in-memory (default), SQLite VSS (persistent local),
  LanceDB (managed REST), Qdrant (managed REST).

The previous slice exposed concrete classes — every consumer hardcoded
"OpenAI + in-memory". Adding a new vendor required edits at every call
site and there was no capability negotiation (dim mismatch failed at
query time with a numeric type error, not a typed `Result` arm).

This ADR introduces a **pluggable registry** for both axes with closed-port
contracts, env-driven swap, capability negotiation, and a default-OFF byte
identical landing.

## Decision

### Slice layout

```
src/retrieval/engines/
  embedder/
    port.ts                 — Embedder { embed, capabilities }
    types.ts                — EmbedResult / EmbedderCapabilities / EmbedError (7-arm closed)
    openai-embedder.ts      — POST api.openai.com/v1/embeddings
    voyage-embedder.ts      — POST api.voyageai.com/v1/embeddings
    cohere-embedder.ts      — POST api.cohere.com/v1/embed
    ollama-embedder.ts      — POST localhost:11434/api/embeddings
    headless-stub.ts        — deterministic djb2 → Mulberry32
    registry.ts             — env-driven swap (QUANTA_EMBED_PROVIDER)
  store/
    port.ts                 — VectorStore { upsert, query, delete, capabilities }
    types.ts                — StoredDoc / StoredHit / StoreCapabilities / Filter / StoreError (5-arm)
    in-memory-store.ts      — Map + cosine
    sqlite-vss-store.ts     — bun:sqlite + BLOB vector, cosine in TS
    lance-store.ts          — REST stub (LanceDB HTTP server, fetch)
    qdrant-store.ts         — REST fetch (localhost:6333)
    registry.ts             — env-driven swap (QUANTA_VECTOR_STORE)
  capabilities.ts           — negotiateCapabilities(embedder, store) → Result
  index.ts                  — barrel
```

### Embedder port

```ts
export interface Embedder {
  embed(
    input: string | readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<Result<EmbedResult, EmbedError>>
  capabilities(): Promise<EmbedderCapabilities>
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<readonly number[]>
  readonly tokenCount?: number
  readonly modelTag: string
}

export interface EmbedderCapabilities {
  readonly dim: number
  readonly maxInputBytes: number
  readonly batchSize: number
  readonly modelTag: string
}

export type EmbedError =
  | { kind: "missing-api-key"; provider: string }
  | { kind: "http-error"; status: number; body: string }
  | { kind: "rate-limited"; retryAfterMs?: number }
  | { kind: "invalid-response"; detail: string }
  | { kind: "aborted" }
  | { kind: "input-too-large"; bytes: number; cap: number }
  | { kind: "network"; detail: string }
```

The 7-arm closed union forces every consumer to handle each failure mode
(`assertNever` in the default branch).

### VectorStore port

```ts
export interface VectorStore {
  upsert(docs: readonly StoredDoc[]): Promise<Result<void, StoreError>>
  query(
    vec: readonly number[],
    k: number,
    filter?: Filter,
  ): Promise<Result<readonly StoredHit[], StoreError>>
  delete(ids: readonly string[]): Promise<Result<void, StoreError>>
  capabilities(): StoreCapabilities
}

export interface StoredDoc {
  readonly id: string
  readonly vector: readonly number[]
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface StoredHit {
  readonly id: string
  readonly score: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface StoreCapabilities {
  readonly distMetric: "cosine"
  readonly maxDim: number
  readonly persistent: boolean
}

export interface Filter {
  readonly equals?: Readonly<Record<string, string | number | boolean>>
}

export type StoreError =
  | { kind: "dim-mismatch"; expected: number; got: number }
  | { kind: "not-found"; id: string }
  | { kind: "http-error"; status: number; body: string }
  | { kind: "network"; detail: string }
  | { kind: "invalid-response"; detail: string }
```

`distMetric` is hardcoded to `"cosine"` for v1 — every adapter normalises
its native metric to cosine semantics so call sites get a single contract.

### Capability negotiation

```ts
export const negotiateCapabilities = (
  embCaps: EmbedderCapabilities,
  storeCaps: StoreCapabilities,
): Result<NegotiatedCaps, MismatchError>
```

Fails fast on `dim > storeCaps.maxDim` or any future incompat axis with a
typed error — never at query time.

### Registries

`QUANTA_EMBED_PROVIDER ∈ {openai, voyage, cohere, ollama, headless}` →
returns an `Embedder`. `QUANTA_VECTOR_STORE ∈ {in-memory, sqlite, lance,
qdrant}` → returns a `VectorStore`. Both default to **null** (caller-owned
construction) so byte-identical landing is guaranteed — no module
auto-instantiates anything in production paths.

### Network adapters

Per ADR-0159 (slice is a leaf) and ADR-0160 (REST adapter pattern), every
managed-vendor adapter uses `fetch` directly. No SDK install. API keys
come from env (`OPENAI_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`).
Missing key → `{ kind: "missing-api-key" }` arm of `EmbedError`.

### Headless stub

Deterministic vector synthesis via djb2 hash → Mulberry32 PRNG seed. Same
input string yields byte-identical output. Used in hellgate + any code
path that needs an `Embedder` without a network. Dim configurable (default
1536).

## Consequences

**Positive**

- Provider swap is one env var. No source edits at call sites.
- 7+5 closed error arms force exhaustive handling — no silent failures.
- Capability negotiation rejects dim mismatch before any vector is stored.
- Every managed-vendor adapter uses `fetch` only — no SDK install, no
  supply-chain expansion. Aligns with the `no-install` constraint.
- Default-OFF: registry returns `null` until env var present. Existing
  ADR-0254 store/embedder is unchanged and remains the wired default.

**Negative / accepted trade-offs**

- LanceDB and Qdrant adapters are REST-only — no streaming bulk import.
  Bulk ingest > 10k docs will pay per-doc round-trips. Acceptable for
  v1; bulk path can be added without breaking the port.
- SQLite VSS adapter computes cosine in TypeScript (the VSS extension is
  not assumed to be loaded). This is O(n) per query. For corpora > 100k
  docs the right answer is to switch to Qdrant/Lance, not to optimise
  SQLite-VSS.
- The 4 managed adapters are wired with shape-only contracts — they
  hit real endpoints but we cannot pin a vendor SLA. The hellgate uses
  injected `fetch` stubs to keep tests offline.

## Rejected alternatives

- **Single `Embedder` interface across all 8 ADR-0254 vendors at once.**
  ADR-0254's `EmbeddingPort` already covers 8 vendors but its shape is
  the older "raw `embed(texts)` → vectors" — no capabilities, no typed
  errors, no batch caps. Re-using it would force every consumer of the
  new registry to wrap the old port. Instead, the new `Embedder` is a
  *sibling* with a richer contract; the old port is unchanged and
  remains in use by its existing call sites.
- **Default-ON registry that picks "in-memory + headless" when env is
  empty.** Tempting for ergonomics but violates the byte-identical
  landing rule — every existing caller would silently get a new
  collaborator. Caller-owned construction is the safer landing; the
  follow-up wiring round will introduce a composition-root helper.
- **Auto-install vendor SDKs on first use.** Blocked by the `no-install`
  constraint of this codebase. The REST/fetch pattern (ADR-0160) is
  the only allowed integration shape.
