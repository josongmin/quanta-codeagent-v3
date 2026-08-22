/**
 * Candidate seed builder (ADR-0084) — Agentless §3.1 temperature diversification
 * + §4.2 mixed-model voting.
 */

import type { ModelCandidate } from "@/llm"
import type { BranchSeed } from "./types"

/** Spread temperatures across [0.2 .. 1.0] for N candidates. N=1 ⇒ [0.2];
 *  N=3 ⇒ [0.2, 0.6, 1.0]; deterministic so replay is reproducible. */
const spreadTemperatures = (n: number): number[] => {
  if (n <= 1) return [0.2]
  const lo = 0.2
  const hi = 1.0
  return Array.from({ length: n }, (_, i) => Number((lo + ((hi - lo) * i) / (n - 1)).toFixed(2)))
}

/** Per-candidate prompt hints, cycled. The first candidate gets no hint
 *  (faithful baseline); the rest get diversification nudges. */
const PROMPT_HINTS: ReadonlyArray<string | undefined> = [
  undefined,
  "Prefer the MINIMAL patch — change as few lines as possible.",
  "Consider a more thorough refactor if it makes the fix cleaner.",
  "Be conservative — guard the change behind the smallest safe edit.",
]

/**
 * Build N seeds. Temperatures spread; prompt hints cycled; models round-robin
 * over `modelCandidates` when provided (mixed-model voting). When no candidates
 * are given, every seed uses the base model (temperature-only diversity).
 */
export const buildSeeds = (
  n: number,
  modelCandidates: ReadonlyArray<ModelCandidate> = [],
): BranchSeed[] => {
  const temps = spreadTemperatures(n)
  return Array.from({ length: n }, (_, i) => {
    const hint = PROMPT_HINTS[i % PROMPT_HINTS.length]
    const model =
      modelCandidates.length > 0 ? modelCandidates[i % modelCandidates.length] : undefined
    const seed: BranchSeed = { temperature: temps[i] ?? 0.5 }
    if (hint !== undefined) seed.promptHint = hint
    if (model !== undefined) seed.modelOverride = model
    return seed
  })
}
