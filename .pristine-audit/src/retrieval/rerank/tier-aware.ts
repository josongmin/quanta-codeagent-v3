/**
 * Tier-aware reranker — apply a `FrameTier`-style penalty (user > test >
 * vendored) to EXTERNAL candidates the localize foundation cannot see.
 *
 * The foundation (`src/tool/localize/index.ts`) already does this for the
 * tree-local file matrix; this reranker exists so the SAME ordering rule
 * applies to candidates that arrive from outside (an MCP search tool, a
 * git-aware embedding store, a third-party vector DB) — without forcing
 * those producers to know about the tier.
 *
 * Tier values match the foundation's penalty scale (`vendored = -50` is a
 * hard bury, never a hide). Classification is INJECTED — the reranker does
 * NOT bake in path heuristics; the caller passes a classifier that knows
 * what "vendored" means in their environment.
 *
 * Pure. Deterministic.
 */
import { byteCompare } from "@/shared"
import type { RerankInput, RerankPort, RetrievalCandidate } from "../types"

export type CandidateTier = "user" | "test" | "vendored"

/** Penalty added to the score per tier. Matches `src/tool/localize/`. */
export const DEFAULT_TIER_PENALTY: Readonly<Record<CandidateTier, number>> = {
  user: 0,
  test: -2,
  vendored: -50,
}

/** Closed port — caller knows how to classify their own candidates. */
export interface TierClassifierPort {
  classify(c: RetrievalCandidate): CandidateTier
}

export interface TierAwareOptions {
  classifier: TierClassifierPort
  /** Override the penalty table. Defaults to {@link DEFAULT_TIER_PENALTY}. */
  penalty?: Readonly<Record<CandidateTier, number>>
}

export const createTierAwareReranker = (opts: TierAwareOptions): RerankPort => {
  const penalty = opts.penalty ?? DEFAULT_TIER_PENALTY
  return {
    kind: "tier-aware",
    async rerank(input: RerankInput): Promise<readonly RetrievalCandidate[]> {
      const scored = input.candidates.map((c): RetrievalCandidate => {
        const tier = opts.classifier.classify(c)
        return { ...c, score: c.score + penalty[tier] }
      })
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : byteCompare(a.id, b.id)))
      const limit = input.limit
      if (typeof limit === "number" && limit >= 0 && limit < scored.length) {
        return scored.slice(0, limit)
      }
      return scored
    },
  }
}
