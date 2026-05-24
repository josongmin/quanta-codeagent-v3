# ADR-0159: Retrieval SOTA stack — reranker registry, token-bucket re-chunker, commit-embedding, multi-vendor embedding port, hybrid query

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0130 (extracted-source absorption roadmap — W6), ADR-0144 (observability metrics — closed-port registry sibling), ADR-0138 (token-budget ledger — pure-primitive sibling), [[no-heuristics-only-validated]] (RRF k=60 standard, no arbitrary thresholds), [[extracted-source-novel-findings-2026-05-24]] (R3 retrieval — 13 reranker LULEA/UMEA + 4 chunk bucket + commit embed + 8 vendor)
- **References**: `src/retrieval/types.ts`, `src/retrieval/rerank-registry.ts`, `src/retrieval/rerank/{identity,bm25-secondary,tier-aware,score-fusion-rrf}.ts`, `src/retrieval/chunk-bucket.ts`, `src/retrieval/commit-embedder.ts`, `src/retrieval/embedding-port.ts`, `src/retrieval/embedders/{openai,voyage,cohere,gemini,xai,moonshot,nvidia,zai}.ts`, `src/retrieval/hybrid-query.ts`
- **Foundation (untouched)**: `src/tool/localize/index.ts` (BM25 + IDF + FrameTier — Agentless funnel, R-Phase9/10 sibling-`.js` penalty), `src/memory/ranking.ts` (vector + lexical + tag + freshness hybrid)

## Context

`.extracted_source/` R3 round revealed a 4-axis retrieval stack used by competing agents which our codebase does not encode as a named port:

1. **Reranker layer** — competing agents (Cursor 3.2 LULEA/UMEA channels, Codex 2867 reranker tier) run a SECOND-stage rerank pass over a first-stage funnel result (BM25 / embedding). The rerank kernel is itself pluggable (cross-encoder, score fusion, tier-aware penalty). quanta's BM25-only `localize` and vector-only `ranking.ts` both produce a final ordering with no rerank port — we cannot swap or stack reranker strategies.
2. **Token-bucket re-chunker** — competing agents pre-chunk source by token budget (identity / 600 / 2400 / 4000) so candidates fit downstream context windows; our `localize` returns one ranked LINE per row (no chunk-budget surface).
3. **Commit embedding** — competing agents embed git commit messages so a query like "why did we revert X" can recall the deciding commit. We have NO `git log` → embedding pipeline.
4. **Multi-vendor embedding** — Codex/Cursor speak Voyage, Cohere, Gemini, xAI, Moonshot, NVIDIA, zai in addition to OpenAI. Our only concrete `EmbedderPort` adapter is `OpenAIEmbedder` (memory slice). A new vendor cannot be wired without code change.

Adding any of these to `src/tool/localize/` or `src/memory/` would force backwards-incompatible imports and break slice isolation (`@/tool` cannot reach `@/memory`; `@/memory` cannot reach `@/llm` / OpenAI). The four axes are **retrieval primitives** — orthogonal to localization (where in the tree) and recall (what we already remember). They belong in a new `@/retrieval` slice that depends on `@/shared` only.

### Why not extend existing slices

| candidate | why no |
| --- | --- |
| `src/tool/localize/` | the foundation IS rerank-able — DO NOT mutate; rerank must compose OVER its output via a port |
| `src/memory/ranking.ts` | semantic + lexical recall over MemoryEntry — a separate domain from generic chunk retrieval |
| `src/agent/memory-embedder.ts` | concrete provider lives in `@/agent` because `@/memory` cannot import OpenAI; a multi-vendor port wants its OWN slice so new adapter files don't bloat `@/agent` |
| `src/llm/providers/` | LLM completion / streaming surface — retrieval is upstream of generation, not part of it |

### Why a new slice

`@/retrieval` is the first slice whose entire purpose is **selecting candidate text for downstream consumption** (rerank, chunk, embed, hybrid query). It depends on `@/shared` only — every external (git, OpenAI, tokenizer, clock) enters via a closed port. Concrete adapters live INSIDE the slice (because every adapter is "compose vendor X with our generic EmbeddingPort" — there is no slice-isolation conflict the way `@/memory` ↔ OpenAI had).

## Decision

Add `src/retrieval/` slice (5 axes, 8 vendor adapters):

### Axis A — Reranker port + registry

```ts
// src/retrieval/types.ts
interface RetrievalCandidate {
  id: string
  text: string
  score: number
  source: "bm25" | "embedding" | "lexical" | "hybrid" | "external"
  metadata?: Readonly<Record<string, unknown>>
}

interface RerankInput {
  query: string
  candidates: readonly RetrievalCandidate[]
  limit?: number
}

interface RerankPort {
  readonly kind: RerankerKind
  rerank(input: RerankInput): Promise<RetrievalCandidate[]>
}

type RerankerKind = "identity" | "bm25-secondary" | "tier-aware" | "score-fusion-rrf"
```

Four built-in reranker files (SRP — one strategy per file):

- `identity.ts` — pass-through (default, used when the operator has no rerank preference)
- `bm25-secondary.ts` — re-score candidates with BM25 against the query (composes with first-stage embedding)
- `tier-aware.ts` — apply `FrameTier` penalty (user > test > vendored) from the localize foundation, but on EXTERNAL candidates the foundation cannot see
- `score-fusion-rrf.ts` — Reciprocal Rank Fusion across multiple candidate lists, **k=60 standard from Cormack 2009** ([[no-heuristics-only-validated]] — published constant, not invented)

Registry (`rerank-registry.ts`) — keyed by `RerankerKind`, returns the `RerankPort` instance; throws `RetrievalError` on unknown kind. Default registration is closed (the assembler decides which kinds are wired).

### Axis B — Token-bucket re-chunker

```ts
// src/retrieval/chunk-bucket.ts
type ChunkBucket = "identity" | "small-600" | "medium-2400" | "large-4000"

interface TokenizerPort {
  count(text: string): number
}

interface ChunkBucketOptions {
  bucket: ChunkBucket
  overlapRatio?: number // default 0.10 (sliding-window standard)
  tokenizer: TokenizerPort // closed port — caller injects
}

function rechunk(text: string, opts: ChunkBucketOptions): readonly string[]
```

10% overlap is the **sliding-window standard** (Karpukhin et al. 2020 DPR + Lewis et al. 2020 RAG — neither paper invented the figure). `identity` returns `[text]` unchanged. Byte-deterministic for a fixed tokenizer.

### Axis C — Commit embedding

```ts
// src/retrieval/commit-embedder.ts
interface GitLogPort {
  log(opts: { limit: number; cwd: string }): Promise<readonly CommitNote[]>
}

interface CommitNote {
  sha: string
  authorISO: string
  subject: string
  body: string
}

interface CommitNoteWithEmbedding extends CommitNote {
  embedding: readonly number[]
}

interface CommitEmbedderOptions {
  git: GitLogPort
  embed: EmbeddingPort
  cache?: { maxEntries: number } // LRU
}
```

LRU cache keyed by `sha` so the same commit is not re-embedded across queries. Cache is in-process; deterministic eviction (oldest insertion).

### Axis D — Multi-vendor embedding port

```ts
// src/retrieval/embedding-port.ts
interface EmbeddingPort {
  readonly vendor: EmbeddingVendor
  readonly model: string
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

type EmbeddingVendor = "openai" | "voyage" | "cohere" | "gemini" | "xai" | "moonshot" | "nvidia" | "zai"
```

8 adapter files under `src/retrieval/embedders/`. V1 runtime: **OpenAI** + **Voyage** (`@/retrieval/embedders/openai.ts` + `voyage.ts`) — the two with stable public REST contracts. The remaining 6 (`cohere/gemini/xai/moonshot/nvidia/zai`) are **type-level adapter stubs** — typed constructors + `embed()` that throws `RetrievalError("vendor not yet wired at runtime")`. Adding runtime for any of them is a one-file change with zero ripple.

This is deliberate: the port + 8 type-level adapters lock the wire-shape across vendors NOW so any later runtime wiring is a substitution, not a re-architecture.

### Axis E — Hybrid query (3-stage funnel)

```ts
// src/retrieval/hybrid-query.ts
type QueryType = "keywords" | "embeddings" | "hybrid"

interface HybridQueryInput {
  query: string
  type: QueryType
  bm25Source: () => Promise<readonly RetrievalCandidate[]>
  embeddingSource: () => Promise<readonly RetrievalCandidate[]>
  rerank?: RerankPort
  limit?: number
}
```

Stages:

1. Run the source(s) the type asks for (`keywords` → bm25 only; `embeddings` → embed only; `hybrid` → both)
2. If both, fuse with RRF (the score-fusion-rrf reranker)
3. If `rerank` provided, run final-stage rerank pass

Returns `RetrievalCandidate[]`. Pure — no I/O of its own; the sources are injected callbacks.

## Discipline & invariants

1. **SRP** — one reranker strategy per file (4 files), one chunk-bucket module, one commit-embedder module, one vendor adapter per file (8 files)
2. **OCP** — `RerankerKind` is a union, registry returns the right adapter; new reranker = new file + one registry entry, zero edits to existing files
3. **LSP** — every `RerankPort` accepts the same `RerankInput`, returns the same shape; every `EmbeddingPort` ditto
4. **ISP** — `TokenizerPort` exposes ONLY `count`; `GitLogPort` exposes ONLY `log`; `EmbeddingPort` exposes ONLY `embed` + `vendor` + `model`
5. **DIP** — every external dep (git, OpenAI/Voyage HTTP, tokenizer, clock) is a closed port injected by the assembler
6. **[[no-heuristics-only-validated]]** — RRF k=60 (Cormack 2009), 10% chunk overlap (DPR/RAG standard), LRU eviction (textbook). NO new invented thresholds.
7. **Backward compat 100%** — `src/tool/localize/` and `src/memory/ranking.ts` are untouched; the new slice is opt-in via assembler wiring
8. **typed-envelope superset** — `RetrievalError` extends our `BaseError` taxonomy; events propagate via the existing `AgentEvent` channel when wired
9. **biome 0 + tsc 0** — new slice must satisfy strict mode + biome on first landing
10. **Hellgate for every axis** — 5 hellgate batteries × 12+ adversarial cases (rerank ordering / chunk-bucket determinism / commit-embedder cache poisoning / multi-vendor wire / hybrid-query stage interleaving)

## Negative invariants (NOT absorbed in this slice)

1. **Cross-encoder reranker (e.g. monoT5)** — requires a hosted model + GPU; we encode this as `bm25-secondary` (lexical re-score over first-stage embedding hits) which is the deterministic cheap alternative. A cross-encoder adapter is a one-file addition LATER, not now.
2. **Late-interaction (ColBERT)** — same reason. Future ADR if telemetry shows demand.
3. **Per-query learned chunk size** — adds a training loop and offline data dependency, no clear signal in our corpora. We ship the 4 published buckets.
4. **Multi-hop retrieval** — requires a planner; covered by `src/agent/follow-up-queue.ts` at a different layer (turn / message), not chunk.

## Tradeoffs

- 8 vendor adapters with only 2 wired at runtime is **deliberate over-shape** — locks the API surface across vendors so later wiring is type-checked at boundary day-zero. The cost is ~50 lines of typed stub × 6 = ~300 lines of code that throws.
- A new slice = new biome `noRestrictedImports` block + new tsconfig path. One-time tax.
- The 4 reranker files could collapse to one strategy-table file. We chose 4 files for SRP (a strategy that grows constraints over time stays bounded to its own file).

## Test plan

- **Hellgate** (12+ adversarial cases each): `tests/unit/retrieval-rerank-hellgate.test.ts`, `tests/unit/retrieval-chunk-bucket-hellgate.test.ts`, `tests/unit/retrieval-commit-embedder-hellgate.test.ts`, `tests/unit/retrieval-embedding-multi-vendor-hellgate.test.ts`, `tests/unit/retrieval-hybrid-query-hellgate.test.ts`
- **Unit** (8+ each): `tests/unit/retrieval-rerank-registry.test.ts`, `tests/unit/retrieval-chunk-bucket.test.ts`, `tests/unit/retrieval-commit-embedder.test.ts`, `tests/unit/retrieval-hybrid-query.test.ts`
- Coverage: every reranker kind has a happy-path + at least one adversarial test (ordering, dup ids, empty input, limit boundary).

## Feature-catalog entries

`tools/feature-catalog/features/05-memory/` (L4 — retrieval is in the recall domain):

- `rerank-registry.yaml`
- `chunk-bucket.yaml`
- `commit-embedder.yaml`
- `multi-vendor-embedding.yaml`
- `hybrid-query.yaml`

## Composition-root wire (2026-05-25 follow-up — Phases A-F)

The primitives shipped without a composition-root wire — `grep -rE
"runHybridQuery|RerankRegistry|HybridQueryInput|from \"@/retrieval\"" src/runner/ src/apps/`
returned ZERO hits, meaning the slice was dead code from the agent loop's
perspective. The wire adds:

- `src/runner/assemble/retrieval.ts` — `buildRetrievalStackCore(input)`.
  Surface-agnostic assembler returning a `RetrievalStack` (registry +
  `defaultReranker` + optional `embedding` / `commitEmbedder`). Default-OFF:
  `input.enabled !== true` ⇒ `undefined` ⇒ AgentConfig slot omitted (byte-
  identical for every legacy caller). Builds with strict OCP closure: the
  3 builtin rerankers (identity / bm25-secondary / score-fusion-rrf) are
  always wired; `tier-aware` is wired only when `tierClassifier` is supplied;
  promoting an unregistered kind throws `RetrievalError` (loud).
- `src/runner/assemble/retrieval-memory-bridge.ts` — `rankWithRetrievalStack
  (candidates, query, now, stack?)`. Memory↔retrieval bridge. Stack absent
  ⇒ `rankEntries(...)` verbatim. Stack present ⇒ two-stage funnel using
  rank ordinal as the neutral base score (avoids letting the weighted-sum
  dominate the rerank). `@/memory` is UNTOUCHED — bridge lives in `@/runner`
  so the memory slice fence (memory MUST NOT import @/retrieval) is
  respected.
- `src/runner/assemble/retrieval-localize-bridge.ts` — `runLocalizeHybrid
  ({query, type, bm25Source, embeddingSource?, stack?, limit?})`.
  Localize↔retrieval bridge. Stack absent ⇒ identity (lexical hits as
  candidates). Stack present ⇒ 3-stage funnel (BM25 / embedding / hybrid+RRF)
  with the stack's `defaultReranker` as final stage. `@/tool/localize/`
  is UNTOUCHED.
- `src/agent/types.ts` — `AgentConfig.retrievalStack?: { registry, default
  Reranker, embedding?, commitEmbedder? }`. Typed against `@/retrieval` (the
  conventional direction — `@/retrieval` forbidden from importing `@/agent`
  per the slice fence above; the reverse is fine).
- `src/runner/assemble/config.ts` — `SessionDeps.retrievalStack` + the
  conditional spread `...(d.retrievalStack !== undefined ? { retrievalStack:
  d.retrievalStack } : {})` (preserves `exactOptionalPropertyTypes` ⇒ the
  slot is omitted entirely when undefined).
- `src/apps/agent/index.ts` — `QUANTA_RETRIEVAL_HYBRID="1"` (strict-equals
  "1") env knob → `buildRetrievalStackCore({enabled: true})` → attached to
  `AssembleRequest.base.retrievalStack`. Every mode runner (headless /
  batch / ci-bot / interactive / daemon / ide) inherits the stack.

### Validation

- `grep -rE "buildRetrievalStackCore|runHybridQuery|RerankRegistry|retrievalStack" src/runner/ src/apps/`
  goes from 0 → 21+ hits (wire confirmed).
- `tests/unit/retrieval-composition-wire-hellgate.test.ts`: 25 adversarial
  cases on the builder + bridges (default-OFF strict-equals, opt-in shape,
  unregistered-kind throw, bridge identity, malformed reranker output,
  concurrent isolation, bm25Alpha / commitCacheMax threading).
- `tests/integration/retrieval-composition-root.test.ts`: 16 e2e cases
  covering env-projected build → AgentConfig slot → consumer reads back,
  runAgent never touches the slot, cross-cut (memory + localize via the
  same stack), abort safety, structural assignability sentinel.
- `bun test tests/unit/retrieval-*.test.ts tests/integration/retrieval-*.test.ts`:
  151 pass / 0 fail / 269 expects.
- Regression: `bun test tests/unit/agent-*.test.ts tests/unit/runner-*.test.ts
  tests/unit/memory-*.test.ts` ⇒ 365 pass / 0 fail (no regression).

## Out of scope (still — post-wire)

- Runtime wiring for cohere/gemini/xai/moonshot/nvidia/zai (each is a one-file
  follow-up; type-level wire is in this ADR — the composition root accepts
  any concrete `EmbeddingPort` via DI).
- Cross-encoder + ColBERT reranker — future ADR if demand surfaces in
  telemetry.
- Loop-side consumption of the stack: `runAgent` does NOT read
  `AgentConfig.retrievalStack`. The wire is caller-side composition only
  (memory recall + future hybrid_localize tool). Adding loop-side consumers
  is a separate ADR if needed.
- Per-mode default reranker promotion (e.g. ci-bot promotes
  `score-fusion-rrf` by default). Today the builder uses `identity` as
  the safe default; per-mode promotion is a follow-up tweak in the
  mode-preset files.
