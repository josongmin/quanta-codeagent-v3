/**
 * Speculative branch search — N-best verifier-prover (ADR-0084).
 *
 * Hard edits run as N parallel candidates in ISOLATED workspaces; a closed
 * `Verifier` port produces typed `VerifierSignal`s; a pure `Scorer` folds them
 * into a 0..1 score; a pure `Selector` picks the winner. The main loop sees
 * ONLY the winner — losers go to the OTel span tree + the smoke trace sidecar.
 *
 * Slice: `@/agent`-level. Imports `@/llm` (ModelCandidate), `@/runtime` (shell
 * + worktree-fork for isolation), and the existing `runAgent` via a port — no
 * upward import. Default-OFF (RFC §1.2): `AgentConfig.branchSearch === undefined`
 * ⇒ tool unregistered, byte-identical legacy single-trajectory path.
 */

import type { LLMPort, ModelCandidate } from "@/llm"
import type { BranchSearchAnchor, DeltaMeasurement } from "./anchor"

export interface BranchSeed {
  /** Sampling temperature override. `undefined` ⇒ inherit parent config. */
  temperature?: number
  /** Alternate provider+model (mixed-model voting, Agentless §4.2). Pulled
   *  from `AgentConfig.modelCandidates` (ADR-0066) so the set composes with
   *  model-swap retry. */
  modelOverride?: ModelCandidate
  /** Free-form hint folded into the candidate's system prompt for "approach
   *  this differently" diversification. */
  promptHint?: string
}

export interface BranchCandidate {
  /** Stable id within ONE search: `cand-${i}`. */
  readonly id: string
  readonly seed: BranchSeed
  /** Isolated workspace path (candidate cwd; verifiers shell against it). */
  readonly workspace: string
  readonly outcome:
    | { kind: "completed"; turns: number; llmSelfConfidence?: number }
    | { kind: "failed"; reason: string }
  /** ADR-0116 delta-from-anchor (Shadow ODB). Set by the orchestrator when a
   *  `BranchSearchAnchor` is wired AND this candidate completed AND the
   *  anchor returned a non-null measurement. OMITTED otherwise (never set
   *  to `undefined` — exactOptionalPropertyTypes). */
  readonly delta?: DeltaMeasurement
}

/** Closed set of verifier kinds — adding one is a compile error at the scorer.
 *  `llm_voter_quorum` (ADR-0433) is the adversarial multi-voter aggregate; it
 *  is ADDITIVE/orthogonal — a signal of this kind is produced ONLY when a
 *  caller explicitly composes a multi-voter run in, so absent that wiring the
 *  scorer never reads its weight and the score is byte-identical. */
export type VerifierKind =
  | "tsc"
  | "test"
  | "lint"
  | "lsp_diag"
  | "patch_size"
  | "llm_judge"
  | "llm_voter_quorum"

export interface VerifierSignal {
  readonly kind: VerifierKind
  readonly pass: boolean
  /** Optional 0..1 graded value — when present, scorers weight by this rather
   *  than the binary `pass`. MUST be in [0,1] (scorer clamps defensively). */
  readonly magnitude?: number
  /** Short human detail (error count / first error). Surfaced on OTel + sidecar. */
  readonly detail: string
  readonly durationMs: number
}

export interface CandidateScore {
  /** Weighted total in [0..1]; higher is better. */
  readonly total: number
  readonly breakdown: ReadonlyArray<VerifierSignal>
}

export type Verifier = (cand: BranchCandidate) => Promise<ReadonlyArray<VerifierSignal>>
export type Scorer = (signals: ReadonlyArray<VerifierSignal>) => CandidateScore
export type Selector = (
  scored: ReadonlyArray<{ cand: BranchCandidate; score: CandidateScore }>,
) => BranchCandidate

/** Isolation port — produce a fresh disposable workspace + idempotent cleanup. */
export interface Isolator {
  acquire(i: number): Promise<{ workspace: string; cleanup: () => Promise<void> }>
}

export type BranchTraceEvent =
  | { kind: "candidate-started"; id: string; seed: BranchSeed }
  | { kind: "candidate-finished"; id: string; turns: number; durationMs: number }
  | { kind: "candidate-failed"; id: string; reason: string }
  | { kind: "candidate-scored"; id: string; total: number; signals: ReadonlyArray<VerifierSignal> }
  | { kind: "candidate-delta"; id: string; delta: DeltaMeasurement }
  | { kind: "winner-selected"; winnerId: string; total: number }

export interface BranchSearchRequest {
  readonly N: number
  readonly seeds: ReadonlyArray<BranchSeed>
  readonly baseLlm: LLMPort
  readonly task: string
  readonly timeoutPerBranchMs: number
  readonly verifier: Verifier
  readonly scorer: Scorer
  readonly selector: Selector
  readonly isolator: Isolator
  readonly onTrace?: (e: BranchTraceEvent) => void
  /** ADR-0116 anchor seam — pluggable "register a starting point + measure
   *  per-candidate delta from it" port. Absent ⇒ no anchor; orchestrator
   *  byte-identical to pre-ADR-0116 behaviour (`delta` OMITTED on every
   *  candidate). Wired by `branch-search-runner` when
   *  `AgentConfig.shadowOdb` is set. */
  readonly anchor?: BranchSearchAnchor
  /** Injection seam for tests: clock used for `totalWallMs` and threaded
   *  through `parallelPropose`. Default `Date.now`. The value is reported on
   *  the `BranchSearchResult` only — it never affects routing or scoring. */
  readonly now?: () => number
}

export interface BranchSearchResult {
  readonly winner: BranchCandidate
  readonly winnerScore: CandidateScore
  readonly allScored: ReadonlyArray<{ cand: BranchCandidate; score: CandidateScore }>
  readonly totalWallMs: number
}

/** OPTIONAL `AgentConfig.branchSearch` slot. Absent ⇒ `branch_search` tool
 *  refuses cleanly and the legacy loop is byte-identical. */
export interface BranchSearchConfig {
  readonly defaultN: number
  readonly defaultVerifierKinds: ReadonlyArray<VerifierKind>
  readonly timeoutPerBranchMs: number
  readonly weights?: Partial<Record<VerifierKind, number>>
  readonly isolation: "worktree" | "tmpdir"
}
