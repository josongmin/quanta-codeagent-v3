/**
 * Headless deterministic reranker — for tests / replay (ADR-0262).
 *
 * Scores by a stable FNV-1a hash of `query + documentOf(hit)` so the same
 * (query, hits) pair produces the same ordering across instances and
 * processes. Useful as a "neither identity nor vendor" stand-in for
 * scheduler tests that want a reranker that REORDERS without network.
 *
 * Never calls out — `Result` only carries domain errors that originate
 * inside the boundary contract (empty-query, too-many-docs).
 */
import { err, ok, type Result } from "@/shared"
import type { Reranker } from "./port"
import type { RerankError, RerankedHit, RerankerCapabilities } from "./types"

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

const hashU32 = (s: string): number => {
  let h = FNV_OFFSET
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return h >>> 0
}

const DEFAULT_CAPS: RerankerCapabilities = {
  provider: "headless",
  model: "headless-fnv1a",
  maxDocsPerCall: 1_000_000,
  maxInputTokens: 1_000_000,
}

export interface HeadlessRerankerOptions<T> {
  readonly documentOf?: (hit: T) => string
}

export const headlessReranker = <T = unknown>(
  opts: HeadlessRerankerOptions<T> = {},
): Reranker<T> => {
  const documentOf = opts.documentOf ?? ((h: T) => JSON.stringify(h))
  return {
    capabilities: () => DEFAULT_CAPS,
    async rerank(
      query: string,
      hits: readonly T[],
      k: number,
    ): Promise<Result<readonly RerankedHit<T>[], RerankError>> {
      if (k <= 0 || hits.length === 0) return ok([])
      if (query.trim().length === 0) return err({ kind: "empty-query" })
      const scored: RerankedHit<T>[] = hits.map((h, i) => ({
        originalIndex: i,
        score: hashU32(`${query}|${documentOf(h)}`) / 0xffffffff,
        hit: h,
      }))
      scored.sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.originalIndex - b.originalIndex,
      )
      return ok(scored.slice(0, Math.min(k, scored.length)))
    },
  }
}
