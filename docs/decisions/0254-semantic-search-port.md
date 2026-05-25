# ADR-0254: Semantic-search port — embedding-based retrieval seam (Cline-style)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0093 (retrieval sketch — `src/retrieval/`),
  ADR-0159 (retrieval SOTA stack — chunk-bucket / commit-embedder / 8-vendor
  embedding port / hybrid-query funnel),
  Cline / Cursor `CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL` absorption.
- **References**:
  `src/retrieval/semantic/port.ts` (`SemanticIndex` closed port),
  `src/retrieval/semantic/embed-port.ts` (`Embedder` closed port — separate
  injection seam from `SemanticIndex`),
  `src/retrieval/semantic/types.ts` (`Document`, `SearchHit`,
  `EmbeddingVector`, `SearchError`),
  `src/retrieval/semantic/in-memory-index.ts` (Map + cosine adapter),
  `src/retrieval/semantic/headless-embedder.ts` (deterministic test embedder),
  `src/retrieval/semantic/index.ts` (slice barrel),
  `tests/unit/retrieval/semantic-search-hellgate.test.ts` (15 adversarial
  cases).

## Context

Cline and Cursor both ship a `CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL`
capability — query the agent's workspace (docs, code, memory) by **semantic
meaning** rather than substring match. The pattern is "build an in-memory
index from a corpus of `{id, text}` documents, embed the query, return top-k
hits by cosine similarity."

quanta already has `grep` / `glob` / `lsp_nav` (lexical) and the ADR-0159
retrieval stack ships an 8-vendor `EmbeddingPort` (`openai` + `voyage` wired,
6 type-stub adapters). What we **don't** have is the *consumer* of that
embedding port — a `SemanticIndex` that turns `(documents, query, k)` into
`SearchHit[]` ordered by cosine similarity. The hybrid-query funnel
(`runHybridQuery`) presupposes an `embeddingSource` callback exists; this
slice ships the primitive that backs it.

**MVP scope.** Port + 2 adapter (in-memory cosine + headless-stub deterministic
embedder). Real embedding-model integration (OpenAI / Voyage / Cohere via
ADR-0159 `EmbeddingPort` composition), persistence to disk, and hybrid
(lexical + semantic blend) are deliberate holds — the catalog entry records
them. This round delivers the closed port + math + tests so any future
wiring is a one-file substitution, not an architecture change.

## Decision

### Slice layout

```
src/retrieval/semantic/
  types.ts             — Document, SearchHit, EmbeddingVector, SearchError
  embed-port.ts        — Embedder { embed(text): Promise<Result<EmbeddingVector, EmbedError>>; dim(): number }
  port.ts              — SemanticIndex { index(docs); query(text,k); clear(); size() }
  in-memory-index.ts   — Map<id, {doc, vec}> + cosine similarity (pure)
  headless-embedder.ts — deterministic hash → fixed-dim vector (tests)
  index.ts             — barrel
```

### Types (`types.ts`)

```ts
export interface Document {
  readonly id: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SearchHit {
  readonly id: string
  readonly score: number       // cosine in [-1, 1]
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type EmbeddingVector = readonly number[]

export type SearchError =
  | { kind: "empty-text" }
  | { kind: "invalid-k"; k: number }
  | { kind: "embed-failed"; cause: unknown }
  | { kind: "dim-mismatch"; expected: number; actual: number }
```

`SearchError` is a closed discriminated union — every consumer narrows by
`kind` and gets an exhaustive-check fail at compile time when a new branch
lands.

### Embedder port (`embed-port.ts`)

```ts
export type EmbedError =
  | { kind: "empty-text" }
  | { kind: "embed-failed"; cause: unknown }

export interface Embedder {
  embed(text: string): Promise<Result<EmbeddingVector, EmbedError>>
  /** Fixed output dimension. Index rejects vectors that disagree. */
  dim(): number
}
```

Kept **separate** from `SemanticIndex` (not a field) because the embedder is
the I/O boundary (HTTP to OpenAI, local model, etc.) while the index is pure
math. Injecting the embedder at index construction lets tests swap a
deterministic stub without touching the index implementation.

### Semantic-index port (`port.ts`)

```ts
export interface SemanticIndex {
  index(docs: readonly Document[]): Promise<Result<void, SearchError>>
  query(text: string, k: number): Promise<Result<readonly SearchHit[], SearchError>>
  clear(): void
  size(): number
}
```

- `index()` is idempotent over `id` — re-indexing the same id overwrites the
  prior vector (HELL-SS-07).
- `query()` returns `[]` for `k=0` (HELL-SS-03) and `[]` against an empty
  index (HELL-SS-04).
- `clear()` resets `size()` to 0 (HELL-SS-06).
- All errors flow through `Result` — no throws cross the port boundary.

### In-memory adapter (`in-memory-index.ts`)

- Backing store: `Map<string, { doc: Document; vec: EmbeddingVector }>`.
- Cosine similarity:
  `cos(a, b) = dot(a, b) / (norm(a) * norm(b))`. Vectors of zero norm
  return score 0 (degenerate but typed — no NaN leak).
- Sort by score descending, then by id ascending for deterministic ties.
- Top-k by partial sort (full sort is fine at MVP scale; the catalog notes
  HNSW / IVF as a deliberate hold).
- Dim mismatch (HELL-SS-11) detected at `index()` time against the embedder's
  declared `dim()` and at `query()` time if the embedder ever returns a
  shorter/longer vector than declared.

### Headless embedder (`headless-embedder.ts`)

- Deterministic: `embed(text)` returns a fixed-dim vector seeded from a hash
  of the text. Same text ⇒ byte-identical vector (HELL-SS-15).
- No I/O; no clock; safe to use in `bun test` without network.
- Configurable dim (default 64). The mapping is documented in the file
  header — a small Bernstein-style hash mixed into a Mulberry32-shaped
  deterministic PRNG seeded per-coordinate, then L2-normalized.

### Default-OFF discipline

- No `src/` consumer constructs a `SemanticIndex` at composition root yet.
- The slice exports its types/factories through the barrel; only tests
  reach for them today.
- A future wiring round can substitute an OpenAI-backed `Embedder` and
  inject the index into the hybrid-query `embeddingSource` callback — that
  is the one-file substitution this ADR exists to make safe.

## Consequences

**Positive**

- Closed `SemanticIndex` port unblocks the missing piece of ADR-0159's
  hybrid-query funnel — `embeddingSource` callbacks can now be `(q) =>
  semanticIndex.query(q, k)`.
- The `Embedder` port is **separate** from `SemanticIndex`. The I/O boundary
  (HTTP) and the math (cosine) compose without leaking either concern into
  the other — tests can use the deterministic stub even when wiring a
  production index.
- Cosine math is verified by a hellgate case that checks the *numerical*
  value (not just ordering) — protects against silent regression from a
  refactor that re-derives the formula.

**Negative / accepted trade-offs**

- O(N) query (linear scan of the index) — adequate at MVP scale; HNSW / IVF
  are deliberate holds (catalog entry).
- No persistence — restart loses the index. Persistence is a deliberate
  hold; sibling ADR for an on-disk format (e.g. `~/.quanta/semantic/
  {sessionId}.bin`) will land separately if usage justifies it.
- The headless embedder is hash-based, NOT semantic. It satisfies
  determinism and dim contracts only; tests that need semantic similarity
  must inject a fake embedder with hand-crafted vectors (HELL-SS-05 does
  exactly this).
- Default-OFF byte-identical landing: a user who never enables semantic
  search pays zero runtime cost (no allocation, no import side-effect).

## Rejected alternatives

- **Single port that combines embedder + index.** Couples HTTP I/O with
  pure math; every index test would need a network mock. Splitting the two
  is the OCP / DIP idiom — same pattern as ADR-0159 `EmbeddingPort` (vendor
  HTTP) vs the rest of `src/retrieval/` (pure transformations).
- **Throw on errors instead of `Result`.** Inconsistent with the rest of
  `src/retrieval/` (`RetrievalError` is constructed for *unexpected*
  failures only; routine `query` failure surfaces as data, not exception).
  Closed `SearchError` union forces every caller to handle each case.
- **Default-ON.** Violates RFC §1.2 byte-identical landing. A composition
  root with an `embeddingSource` it never invokes would still pay the
  import cost.
- **Hash-only stub at the index layer.** Pushing the hash trick into the
  index would couple the math to a specific test embedder. Keeping it at
  the `Embedder` layer means a real production embedder slots in unchanged.
