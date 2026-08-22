/**
 * Speculative branch search (ADR-0084) — barrel. Closed-port N-best
 * verifier-prover: propose (parallel, isolated) → verify → score → select.
 */
export type { BranchSearchAnchor, DeltaMeasurement } from "./anchor"
export { parseDiffMeasurement, shadowOdbAnchor } from "./anchor"
export {
  type TmpdirIsolatorOptions,
  tmpdirIsolator,
  type WorktreeIsolatorOptions,
  worktreeIsolator,
} from "./isolate"
export { formatBranchTrace, type ProgressFormatOpts, type ProgressLine } from "./progress"
export {
  type ProposeRequest,
  type ProposeResult,
  parallelPropose,
  type RunCandidate,
} from "./propose"
export {
  argmaxSelector,
  DEFAULT_WEIGHTS,
  defaultScorer,
  makeScorer,
  minimalChangeSelector,
} from "./score"
export { runBranchSearch } from "./search"
export { buildSeeds } from "./seed"
export { type BranchSearchToolDeps, branchSearchTool } from "./tool"
export type {
  BranchCandidate,
  BranchSearchConfig,
  BranchSearchRequest,
  BranchSearchResult,
  BranchSeed,
  BranchTraceEvent,
  CandidateScore,
  Isolator,
  Scorer,
  Selector,
  Verifier,
  VerifierKind,
  VerifierSignal,
} from "./types"
export {
  combineVerifiers,
  type DiagnosePort,
  lintVerifier,
  lspDiagVerifier,
  patchSizeVerifier,
  testVerifier,
  tscVerifier,
} from "./verify"
