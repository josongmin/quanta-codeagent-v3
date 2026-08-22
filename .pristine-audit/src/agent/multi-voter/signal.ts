/**
 * Branch-search composition seam (ADR-0433). Turns a `VoteOutcome` into ONE
 * additive `VerifierSignal` of kind `llm_voter_quorum`, so an adversarial
 * multi-voter run can be folded into the existing ADR-0084 scorer ALONGSIDE
 * `tsc`/`test`/`lint`/`llm_judge` etc.
 *
 * ORTHOGONAL / DEFAULT-OFF: the branch-search scorer only ever sees this
 * signal when a caller explicitly produces it and concatenates it onto the
 * candidate's signal list (e.g. via a custom verifier). Absent that wiring NO
 * `llm_voter_quorum` signal exists, so `scoreWith` never reads the
 * `llm_voter_quorum` weight and the score is byte-identical to pre-ADR-0433.
 */

import type { BranchCandidate, Verifier, VerifierSignal } from "@/agent/branch-search"
import type { LLMPort } from "@/llm"
import type { VoteOutcome, Voter } from "./types"
import { runMultiVoter } from "./voter"

/** Build the additive `llm_voter_quorum` signal from a `VoteOutcome`. `pass`
 *  mirrors the quorum verdict; `magnitude` is the graded pass-fraction so the
 *  scorer can reward "9 of 10 passed" above "6 of 10 passed". */
export const voterQuorumSignal = (outcome: VoteOutcome, durationMs = 0): VerifierSignal => {
  const fraction = outcome.totalVotes > 0 ? outcome.passVotes / outcome.totalVotes : 0
  return {
    kind: "llm_voter_quorum",
    pass: outcome.verdict,
    magnitude: fraction,
    detail: `${outcome.passVotes}/${outcome.totalVotes} voters passed (quorum ${outcome.quorumMet ? "met" : "unmet"})`,
    durationMs,
  }
}

/** Default diverse lenses cycled across voters (Agentless §4.2). Cycling — not
 *  random selection — keeps the voter set DETERMINISTIC for a fixed count. */
const DEFAULT_LENSES: readonly string[] = ["correctness", "security", "performance", "regression"]

/** Refute-biased claim built from a completed candidate. A FAILED candidate
 *  never reaches the verifier (search.ts short-circuits to FAILED_SCORE), so
 *  the claim always describes a completed attempt. */
const candidateClaim = (task: string, cand: BranchCandidate): string =>
  `Candidate ${cand.id} claims it correctly accomplished the task: ${task}`

/**
 * ADR-0433 composition: a `Verifier` that, per candidate, fans out to `voters`
 * INDEPENDENT refute-biased voters built from one injected `LLMPort`, runs the
 * quorum aggregate, and emits ONE additive `llm_voter_quorum` `VerifierSignal`.
 *
 * Voters are distinguished only by a cycled diverse-lens label (deterministic
 * for a fixed count). `quorum` is forwarded verbatim to `runMultiVoter`: absent
 * ⇒ strict-majority default (refute bias, a tie fails-closed); explicit ⇒ the
 * `>=` fraction rule. The clock is injected for deterministic `durationMs`.
 *
 * Default-OFF: a caller produces this verifier ONLY when `voterQuorum` is set,
 * so absent that config no `llm_voter_quorum` signal exists and the candidate
 * score is byte-identical to pre-ADR-0433.
 */
export const voterQuorumVerifier = (opts: {
  readonly llm: LLMPort
  readonly task: string
  readonly voters: number
  readonly quorum?: number
  readonly lenses?: readonly string[]
  readonly now?: () => number
}): Verifier => {
  const lensPool = opts.lenses && opts.lenses.length > 0 ? opts.lenses : DEFAULT_LENSES
  const buildVoters = (): Voter[] =>
    Array.from({ length: Math.max(0, opts.voters) }, (_unused, i) => ({
      id: `voter-${i}`,
      port: opts.llm,
      lens: lensPool[i % lensPool.length] as string,
    }))
  return async (cand: BranchCandidate): Promise<readonly VerifierSignal[]> => {
    const now = opts.now ?? Date.now
    const t0 = now()
    const outcome = await runMultiVoter({
      claim: candidateClaim(opts.task, cand),
      voters: buildVoters(),
      ...(opts.quorum !== undefined ? { quorum: opts.quorum } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    })
    return [voterQuorumSignal(outcome, Math.max(0, now() - t0))]
  }
}
