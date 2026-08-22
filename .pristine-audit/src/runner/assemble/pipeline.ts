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
import { errMessage, logger } from "@/shared"

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

const parsePreset = (raw: string | undefined): PipelinePreset => {
  if (raw === undefined || raw === "") return "none"
  return (ALL_PRESETS as readonly string[]).includes(raw) ? (raw as PipelinePreset) : "none"
}

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

const adaptSemanticIndex = (): PipelineSemanticIndex => ({
  async query(_vec: readonly number[], _k: number): Promise<readonly PipelineSearchHit[]> {
    return []
  },
})

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
      `pipeline-wire: reranker factory failed (${errMessage(e)}); ` +
        "falling back to disabled pipeline (set QUANTA_RERANKER=identity to opt out).",
    )
    return undefined
  }
}

const PIPELINE_CACHE_MODEL_TAG = "pipeline-wire-default"

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

export interface PipelineWireOverrides {
  readonly lex?: PipelineLexicalSearch
  readonly sem?: PipelineSemanticIndex
  readonly embedder?: PipelineEmbedder
  readonly reranker?: PipelineReranker
  readonly cache?: PipelineEmbedCache
  readonly budgetProbe?: { usdSoFar(): number }
  readonly budgetMaxUsd?: number
}

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
      `pipeline-wire: ${preset} preset build failed (${errMessage(e)}); ` +
        "falling back to disabled pipeline.",
    )
    return null
  }
}
