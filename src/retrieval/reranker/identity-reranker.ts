/**
 * Identity reranker — default pass-through (ADR-0262 default-OFF wiring).
 *
 * Byte-identical guarantee: the OUTPUT preserves the same hit object
 * references and original input order. `score` is uniformly `1`, so a caller
 * that sorts on `score` produces a stable list. `originalIndex` runs
 * `0..n-1` to match input order.
 *
 * Selected by default when `QUANTA_RERANKER` is absent or set to `identity`.
 * HELL-RR-01 + HELL-RR-14 seal the pass-through invariant.
 */
import { ok, type Result } from "@/shared"
import type { Reranker } from "./port"
import type { RerankError, RerankedHit, RerankerCapabilities } from "./types"

const IDENTITY_CAPS: RerankerCapabilities = {
  provider: "identity",
  model: "identity",
  // Pass-through has no real cap — pick numbers high enough that no caller
  // ever triggers `too-many-docs` on identity (the vendors have real caps).
  maxDocsPerCall: 1_000_000,
  maxInputTokens: 1_000_000,
}

export const identityReranker = <T = unknown>(): Reranker<T> => ({
  capabilities(): RerankerCapabilities {
    return IDENTITY_CAPS
  },
  async rerank(
    _query: string,
    hits: readonly T[],
    k: number,
  ): Promise<Result<readonly RerankedHit<T>[], RerankError>> {
    if (k <= 0 || hits.length === 0) return ok([])
    const limit = Math.min(k, hits.length)
    const out: RerankedHit<T>[] = []
    for (let i = 0; i < limit; i++) {
      const h = hits[i]
      if (h === undefined) continue
      out.push({ originalIndex: i, score: 1, hit: h })
    }
    return ok(out)
  },
})
