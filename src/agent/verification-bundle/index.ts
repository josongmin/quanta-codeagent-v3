/**
 * VerificationBundle — verify-and-select verdict authority (barrel).
 *
 * See {@link ./types} for the contract and the `null = FAIL-OPEN` invariant,
 * and {@link ./score} for the pure `scoreCandidate` / `selectBest` core.
 */

export { scoreCandidate, selectBest, selectBestEffort } from "./score"
export type {
  CandidateVerdict,
  HardGateSignals,
  ScoredCandidate,
  SoftScoreSignals,
} from "./types"
