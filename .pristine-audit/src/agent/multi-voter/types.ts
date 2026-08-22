/**
 * Adversarial multi-voter verification (ADR-0433). Orthogonal/additive to the
 * speculative branch search (ADR-0084) scorer.
 *
 * For a given candidate fix/claim, run N INDEPENDENT voters — each an
 * `LLMPort` (a `ScriptedLLM` test double in tests) prompted to REFUTE the
 * claim and to DEFAULT TO FAIL under uncertainty — and aggregate their typed
 * `Verdict`s by quorum/majority into a single `VoteOutcome`. The refute bias
 * means ties and abstentions fail-closed, and a voter that THROWS is counted
 * as a refute so the loop survives a flaky provider.
 *
 * Slice: `@/agent`-level, imports DOWN to `@/llm` only. Default-OFF: the
 * branch-search scorer never sees a voter signal unless `llm_voter_quorum`
 * weight + a voter signal are explicitly composed in (see `./signal.ts`), so
 * absent config the branch-search score is byte-identical.
 */

import type { LLMPort } from "@/llm"

/** One voter's typed judgement on a claim. `pass:false` ⇒ refute. */
export interface Verdict {
  readonly pass: boolean
  /** Voter's self-reported confidence, clamped to [0,1] on ingest. */
  readonly confidence: number
  readonly reason: string
}

/** A single voter — an `LLMPort` plus an optional diverse-lens label that is
 *  folded into its system prompt for diversification (Agentless §4.2). */
export interface Voter {
  readonly id: string
  readonly port: LLMPort
  /** Optional diverse-lens hint ("security", "perf", "correctness", …) folded
   *  into the refute prompt. Absent ⇒ generic refuter. */
  readonly lens?: string
}

/** One voter's resolved vote: its `Verdict` plus the source voter id and how
 *  the verdict was obtained (parsed | unparseable-fail-closed | threw). */
export interface VoteRecord {
  readonly voterId: string
  readonly verdict: Verdict
  readonly source: "parsed" | "unparseable" | "threw"
  readonly durationMs: number
}

/** Quorum-aggregated outcome over all voters. */
export interface VoteOutcome {
  /** Final verdict — true IFF the pass-votes meet the quorum threshold. */
  readonly verdict: boolean
  readonly votes: ReadonlyArray<VoteRecord>
  /** Number of `pass:true` votes. */
  readonly passVotes: number
  readonly totalVotes: number
  /** True IFF `passVotes / totalVotes >= quorum`. Mirrors {@link verdict}. */
  readonly quorumMet: boolean
}

export interface MultiVoterRequest {
  /** The claim / candidate fix description the voters must REFUTE. */
  readonly claim: string
  readonly voters: ReadonlyArray<Voter>
  /** Pass-fraction needed for the aggregate to PASS. Default `> 0.5` (strict
   *  majority) via {@link DEFAULT_QUORUM}. A tie at exactly `0.5` FAILS
   *  (refute bias) because the comparison is `>=` against a quorum that the
   *  caller sets above `0.5` by default. */
  readonly quorum?: number
  /** Injection seam for tests: clock for per-voter `durationMs`. Default
   *  `Date.now`. Never affects the verdict. */
  readonly now?: () => number
}
