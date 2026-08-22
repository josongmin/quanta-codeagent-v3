/**
 * Public types for the SearchPipeline composer (ADR-0265).
 *
 * The composer is a pure DAG primitive: a `Stage` discriminated union, an
 * inline `compose(stages)` reducer, and a fixed `SearchPipeline` port. Every
 * sibling integration (lexical / semantic / rerank / RRF / budget-gate) is
 * received through INLINE DUCK-TYPED ports declared here — we do NOT import
 * `src/retrieval/{semantic,lexical,reranker,cache,batching}.ts` so the slice
 * fence (ADR-0159) stays honest. Callers in @/agent assemble the concrete
 * implementations and pass them in.
 */

import type { Result } from "@/shared"

/** A query into a SearchPipeline. */
export interface SearchQuery {
  readonly text: string
  /** Cap on final output length. `0` yields an empty result without running any stage. */
  readonly k: number
  /** Optional opaque metadata filter; pipelines may pass through unchanged. */
  readonly filter?: Readonly<Record<string, unknown>>
}

/**
 * One unit of retrieved evidence. `source` is the provenance of the hit, not
 * the rank position. `"fused"` is what RRF emits; `"reranked"` is what a
 * reranker emits; first-stage hits use `"lexical"` or `"semantic"`.
 */
export interface SearchHit {
  readonly id: string
  readonly score: number
  readonly text: string
  readonly source: "lexical" | "semantic" | "fused" | "reranked"
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * 6-arm closed error taxonomy. Adding a new arm forces every consumer
 * (switch / map) to add the missing branch — TS `never` at the default.
 */
export type PipelineError =
  | { kind: "empty-pipeline" }
  | { kind: "unknown-stage"; tag: string }
  | { kind: "stage-failed"; stage: string; cause: unknown }
  | { kind: "budget-exceeded"; maxUsd: number; usdSoFar: number }
  | { kind: "invalid-config"; reason: string }
  | { kind: "no-results" }

/* ────────────────────────────── INLINE PORTS ────────────────────────────── */
// Each port is duck-typed (a single method) so the composer never has to
// import a sibling slice's concrete adapter. The shape is intentionally
// MINIMAL — exactly what `compose` needs at the join point.

/** Lexical (e.g. BM25 / ripgrep) search adapter. */
export interface LexicalSearch {
  search(query: SearchQuery): Promise<readonly SearchHit[]>
}

/** Vector index probed with a pre-computed embedding. */
export interface SemanticIndex {
  query(vec: readonly number[], k: number): Promise<readonly SearchHit[]>
}

/** Vendor-neutral text embedder. */
export interface Embedder {
  embed(text: string): Promise<readonly number[]>
}

/** Cross-encoder / LLM-as-judge reranker. */
export interface Reranker {
  rerank(query: string, items: readonly SearchHit[]): Promise<readonly SearchHit[]>
}

/** Optional caller-supplied embedding cache. `get` returns `undefined` on miss. */
export interface EmbedCache {
  get(text: string): readonly number[] | undefined
  set(text: string, vec: readonly number[]): void
}

/** Optional batcher; the composer calls `embedBatched([text], embedder)` for a single query. */
export interface EmbedBatcher {
  embedBatched(
    texts: readonly string[],
    embedder: Embedder,
  ): Promise<readonly (readonly number[])[]>
}

/**
 * Budget probe — DUCK-TYPED so the composer never imports `@/agent`. The
 * adapter in @/agent (e.g. `defaultBudgetLedger()`) is wrapped at the
 * assembly site to expose `usdSoFar()`.
 */
export interface BudgetProbe {
  usdSoFar(): number
}

/* ─────────────────────────────── STAGE UNION ────────────────────────────── */

/** Discriminated union of every legal pipeline node. */
export type Stage =
  | { kind: "lexical"; impl: LexicalSearch }
  | {
      kind: "semantic"
      impl: SemanticIndex
      embedder: Embedder
      cache?: EmbedCache
      batcher?: EmbedBatcher
    }
  | { kind: "rerank"; impl: Reranker; inner: Stage }
  | { kind: "rrf"; inputs: readonly Stage[]; k?: number }
  | { kind: "budget-gate"; maxUsd: number; probe: BudgetProbe; inner: Stage }

/** Single-method port the composer returns. */
export interface SearchPipeline {
  search(query: SearchQuery): Promise<Result<readonly SearchHit[], PipelineError>>
}
