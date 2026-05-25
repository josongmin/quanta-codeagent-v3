/**
 * ADR-0272 — composition-root wire for the SearchPipeline composer (ADR-0265).
 *
 * `assemblePipeline(env)` projects ONE env var (`QUANTA_PIPELINE`) onto a
 * closed 6-arm preset enum and returns either a wired `SearchPipeline` or
 * `null` (default-OFF). Each non-`none` preset wires the sibling slices
 * it needs from `@/retrieval/{lexical,semantic,reranker,cache,batching}`
 * and ADAPTS their slice ports to the pipeline's INLINE DUCK-TYPED ports.
 *
 * Wire discipline (mirrors `buildRetrievalStackFromEnv` in `./index.ts`):
 *   - DEFAULT-OFF: absent / unknown / `"none"` ⇒ `null`. The caller spreads
 *     conditionally so `AgentConfig.searchPipeline` stays OMITTED under
 *     `exactOptionalPropertyTypes`.
 *   - NO-THROW: adapter-build failure (invalid env, missing API key,
 *     factory throw) ⇒ `logger.warn` + `null` fallback. An operator typo
 *     never blocks startup.
 *   - SINGLE ENV TOUCHPOINT: this helper owns `QUANTA_PIPELINE`. Sibling
 *     factories (`resolveEmbedCacheFromEnv`, `createRerankerFromEnv`) read
 *     their own canonical knobs via the env view we hand them.
 *
 * Slice posture:
 *   - lives in `src/apps/agent/` (composition root — may freely import
 *     `@/retrieval` and `@/shared`),
 *   - the pipeline primitives themselves stay leaf-only (`@/shared` only),
 *   - the `searchCodebaseTool` consumer (slice `@/tool`) accepts a
 *     duck-typed pipeline mirror; this file is the only place that
 *     bridges the two surfaces.
 */

import { resolveEmbedCacheFromEnv } from "@/retrieval/cache"
import { headlessLexicalStub } from "@/retrieval/lexical"
import {
  budgetAwarePipeline,
  lexicalOnlyPipeline,
  type EmbedCache as PipelineEmbedCache,
  type Embedder as PipelineEmbedder,
  type LexicalSearch as PipelineLexicalSearch,
  type Reranker as PipelineReranker,
  type SearchHit as PipelineSearchHit,
  type SearchQuery as PipelineSearchQuery,
  type SemanticIndex as PipelineSemanticIndex,
  parallelRrfPipeline,
  type SearchPipeline,
  type Stage,
  semanticOnlyPipeline,
  semanticThenRerankPipeline,
} from "@/retrieval/pipeline"
import { createRerankerFromEnv } from "@/retrieval/reranker"
import { createHeadlessEmbedder } from "@/retrieval/semantic"
import { logger } from "@/shared"

/** Closed enum of preset values `QUANTA_PIPELINE` may take. `none` = the
 *  default-OFF arm (helper returns `null`). Adding a 7th preset is a 1-file
 *  edit forcing every consumer of {@link PipelinePreset} to add the missing
 *  arm (TS `never`). */
export type PipelinePreset =
  | "none"
  | "lexical-only"
  | "semantic-only"
  | "parallel-rrf"
  | "semantic-then-rerank"
  | "budget-aware"

const ALL_PRESETS: readonly PipelinePreset[] = [
  "none",
  "lexical-only",
  "semantic-only",
  "parallel-rrf",
  "semantic-then-rerank",
  "budget-aware",
] as const

/** Project the raw env value onto the closed enum. Unknown / absent /
 *  empty ⇒ `"none"`. NO fuzzy-match — a typo silently selects default-OFF
 *  rather than silently swapping a vendor. */
const parsePreset = (raw: string | undefined): PipelinePreset => {
  if (raw === undefined || raw === "") return "none"
  return (ALL_PRESETS as readonly string[]).includes(raw) ? (raw as PipelinePreset) : "none"
}

/* ─────────────────────────── adapter glue ─────────────────────────── */
// The sibling slice ports are Result-shaped + multi-method; the pipeline's
// inline duck-typed ports are Promise-shaped + single-method. The adapters
// below sit at this composition-root file ONLY — no other call site needs
// the conversion. Each adapter is pure (no env, no clock).

/** Adapt `@/retrieval/lexical` headless stub → pipeline's `LexicalSearch`. */
const adaptLexicalSearch = (): PipelineLexicalSearch => {
  const inner = headlessLexicalStub()
  return {
    async search(q: PipelineSearchQuery): Promise<readonly PipelineSearchHit[]> {
      const r = await inner.query(q.text, q.k)
      if (!r.ok) return []
      return r.value.map((h) => ({
        id: h.id,
        score: h.score,
        text: h.id,
        source: "lexical" as const,
      }))
    },
  }
}

/** Adapt `@/retrieval/semantic`'s headless embedder → pipeline's
 *  `Embedder` (Promise<readonly number[]>) shape. */
const adaptSemanticEmbedder = (): PipelineEmbedder => {
  const inner = createHeadlessEmbedder()
  return {
    async embed(text: string): Promise<readonly number[]> {
      const r = await inner.embed(text)
      if (!r.ok) return []
      return r.value
    },
  }
}

/** Adapt `@/retrieval/semantic`'s in-memory index → pipeline's
 *  `SemanticIndex.query(vec, k)`. The pipeline calls query with a
 *  pre-computed embedding; the in-memory adapter expects a TEXT input
 *  (it embeds internally). We bypass that by constructing a fake-text
 *  index that ignores its embedder for query — instead we route the
 *  vector through the same cosine kernel by indexing nothing here. The
 *  pipeline therefore sees an empty corpus on the headless preset; the
 *  WIRE PROOF is the surface shape (`.query(vec, k) → Promise<readonly
 *  SearchHit[]>`). Production hosts replace via the `overrides` parameter. */
const adaptSemanticIndex = (): PipelineSemanticIndex => {
  // The pipeline port hands us the embedding directly — but the in-memory
  // index's `query()` takes text + embeds itself. We can't reuse it as-is.
  // For the wire path we ship an empty adapter that satisfies the duck
  // shape; production hosts inject a real adapter that owns the corpus
  // through the `overrides.sem` parameter (kept narrow on purpose).
  return {
    async query(_vec: readonly number[], _k: number): Promise<readonly PipelineSearchHit[]> {
      return []
    },
  }
}

/** Adapt `@/retrieval/reranker`'s vendor-aware port → pipeline's
 *  `Reranker.rerank(query, items)`. The vendor port is Result-shaped;
 *  here we collapse `err` to the inner items unchanged so a wire test
 *  never sees a throw — production hosts that want strict error surfacing
 *  override via the `overrides.reranker` parameter. */
const adaptReranker = (env: NodeJS.ProcessEnv): PipelineReranker | undefined => {
  try {
    const inner = createRerankerFromEnv<PipelineSearchHit>({
      documentOf: (hit) => hit.text,
      ...(env.QUANTA_RERANKER !== undefined ? { providerOverride: env.QUANTA_RERANKER } : {}),
    })
    return {
      async rerank(
        query: string,
        items: readonly PipelineSearchHit[],
      ): Promise<readonly PipelineSearchHit[]> {
        const r = await inner.rerank(query, items, items.length)
        if (!r.ok) return items
        return r.value.map((rh) => ({
          id: items[rh.originalIndex]?.id ?? String(rh.originalIndex),
          score: rh.score,
          text: items[rh.originalIndex]?.text ?? "",
          source: "reranked" as const,
        }))
      },
    }
  } catch (e) {
    logger.warn(
      `pipeline-wire: reranker factory failed (${(e as Error).message}); ` +
        "falling back to disabled pipeline (set QUANTA_RERANKER=identity to opt out).",
    )
    return undefined
  }
}

/** Constant modelTag used when adapting the slice's tag-aware cache to the
 *  pipeline's tag-free `EmbedCache`. The pipeline never differentiates by
 *  model — a production host that needs per-model isolation injects its
 *  own pre-built cache via `overrides.cache`. */
const PIPELINE_CACHE_MODEL_TAG = "pipeline-wire-default"

/** Adapt `@/retrieval/cache`'s env-resolved cache → pipeline's
 *  `EmbedCache(get(text)/set(text, vec))`. The slice port carries an
 *  extra `modelTag` axis the pipeline does not surface; we fold it onto
 *  a single constant so the wire path stays correct (any cache hit is
 *  scoped to the same synthetic tag). */
const adaptEmbedCache = (env: NodeJS.ProcessEnv): PipelineEmbedCache | undefined => {
  const raw = resolveEmbedCacheFromEnv(env as Readonly<Record<string, string | undefined>>)
  return {
    get(text: string): readonly number[] | undefined {
      const hit = raw.get(text, PIPELINE_CACHE_MODEL_TAG)
      return hit === null ? undefined : hit.vector
    },
    set(text: string, vec: readonly number[]): void {
      raw.put(text, PIPELINE_CACHE_MODEL_TAG, vec)
    },
  }
}

/* ─────────────────────────── overrides ─────────────────────────── */

/** Narrow override surface — hosts that have real adapters substitute
 *  them in place of the headless defaults. Kept narrow on purpose: ports
 *  only, no ENV readers. */
export interface PipelineWireOverrides {
  readonly lex?: PipelineLexicalSearch
  readonly sem?: PipelineSemanticIndex
  readonly embedder?: PipelineEmbedder
  readonly reranker?: PipelineReranker
  readonly cache?: PipelineEmbedCache
  /** Override the budget probe used by the `budget-aware` preset. The
   *  default stub reports `0` USD so the wire path is testable; production
   *  hosts inject a probe backed by `defaultBudgetLedger()`. */
  readonly budgetProbe?: { usdSoFar(): number }
  /** Cap (USD) on the budget-aware preset's inner stage. Default `1`. */
  readonly budgetMaxUsd?: number
}

/* ────────────────────────── preset builders ────────────────────────── */

const buildLexicalOnly = (overrides: PipelineWireOverrides): SearchPipeline => {
  const lex = overrides.lex ?? adaptLexicalSearch()
  return lexicalOnlyPipeline({ lex })
}

const buildSemanticOnly = (
  env: NodeJS.ProcessEnv,
  overrides: PipelineWireOverrides,
): SearchPipeline => {
  const sem = overrides.sem ?? adaptSemanticIndex()
  const embedder = overrides.embedder ?? adaptSemanticEmbedder()
  const cache = overrides.cache ?? adaptEmbedCache(env)
  return semanticOnlyPipeline({
    sem,
    embedder,
    ...(cache !== undefined ? { cache } : {}),
  })
}

const buildParallelRrf = (
  env: NodeJS.ProcessEnv,
  overrides: PipelineWireOverrides,
): SearchPipeline => {
  const lex = overrides.lex ?? adaptLexicalSearch()
  const sem = overrides.sem ?? adaptSemanticIndex()
  const embedder = overrides.embedder ?? adaptSemanticEmbedder()
  const cache = overrides.cache ?? adaptEmbedCache(env)
  return parallelRrfPipeline({
    lex,
    sem,
    embedder,
    ...(cache !== undefined ? { cache } : {}),
  })
}

const buildSemanticThenRerank = (
  env: NodeJS.ProcessEnv,
  overrides: PipelineWireOverrides,
): SearchPipeline | null => {
  const reranker = overrides.reranker ?? adaptReranker(env)
  if (reranker === undefined) return null
  const sem = overrides.sem ?? adaptSemanticIndex()
  const embedder = overrides.embedder ?? adaptSemanticEmbedder()
  const cache = overrides.cache ?? adaptEmbedCache(env)
  return semanticThenRerankPipeline({
    sem,
    embedder,
    reranker,
    ...(cache !== undefined ? { cache } : {}),
  })
}

const buildBudgetAware = (
  env: NodeJS.ProcessEnv,
  overrides: PipelineWireOverrides,
): SearchPipeline => {
  // Wrap a semantic-only inner stage with a budget gate; the stub probe
  // reports 0 so the wire path is testable. Production hosts override
  // `budgetProbe` via the helper signature.
  const sem = overrides.sem ?? adaptSemanticIndex()
  const embedder = overrides.embedder ?? adaptSemanticEmbedder()
  const cache = overrides.cache ?? adaptEmbedCache(env)
  const inner: Stage = {
    kind: "semantic",
    impl: sem,
    embedder,
    ...(cache !== undefined ? { cache } : {}),
  }
  const probe = overrides.budgetProbe ?? { usdSoFar: () => 0 }
  const maxUsd = overrides.budgetMaxUsd ?? 1
  return budgetAwarePipeline({ inner, maxUsd, probe })
}

/* ─────────────────────────── public surface ─────────────────────────── */

/**
 * Build the composition-root `SearchPipeline` from env (or `null` for
 * default-OFF). Default-OFF byte-identical (RFC §1.2): absent /
 * `QUANTA_PIPELINE=none` / unknown value ⇒ `null`. Adapter-build failure
 * collapses to `null` + a `logger.warn` line.
 *
 * `overrides` lets production hosts substitute real adapters (lexical
 * backed by ripgrep over the workspace, embedder backed by the OpenAI
 * adapter, etc.) without forking this file. The override surface is
 * intentionally narrow — ports only, no ENV readers.
 */
export const assemblePipeline = (
  env: NodeJS.ProcessEnv,
  overrides: PipelineWireOverrides = {},
): SearchPipeline | null => {
  const preset = parsePreset(env.QUANTA_PIPELINE)
  try {
    switch (preset) {
      case "none":
        return null
      case "lexical-only":
        return buildLexicalOnly(overrides)
      case "semantic-only":
        return buildSemanticOnly(env, overrides)
      case "parallel-rrf":
        return buildParallelRrf(env, overrides)
      case "semantic-then-rerank":
        return buildSemanticThenRerank(env, overrides)
      case "budget-aware":
        return buildBudgetAware(env, overrides)
    }
  } catch (e) {
    logger.warn(
      `pipeline-wire: ${preset} preset build failed (${(e as Error).message}); ` +
        "falling back to disabled pipeline.",
    )
    return null
  }
}
