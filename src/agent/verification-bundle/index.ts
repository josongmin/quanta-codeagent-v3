/**
 * VerificationBundle — verify-and-select verdict authority (barrel).
 *
 * See {@link ./types} for the contract and the `null = FAIL-OPEN` invariant,
 * and {@link ./score} for the pure `scoreCandidate` / `selectBest` core.
 */

export {
  isValidResolvedKofN,
  resolvedKofNPositive,
  resolvedKofNVoterQuorum,
} from "./resolved-kofn"
export { scoreCandidate, selectBest, selectBestEffort } from "./score"
export type {
  CandidateVerdict,
  HardGateSignals,
  ResolvedKofNSignal,
  ScoredCandidate,
  SoftScoreSignals,
} from "./types"
