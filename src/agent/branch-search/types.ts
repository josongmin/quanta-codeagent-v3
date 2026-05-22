/**
 * Speculative branch search — N-best verifier-prover (ADR-0083).
 *
 * Hard edits are run as N parallel candidates in ISOLATED workspaces; a closed
 * `Verifier` port produces typed `VerifierSignal`s; a pure `Scorer` folds them
 * into a 0..1 score; a pure `Selector` picks the winner. The main loop sees
 * ONLY the winner's diff — losers are surfaced only to the OTel span tree and
 * the smoke trace's `losers.jsonl` sidecar (Audit C smoke determinism: replay
 * fixtures keep the winner; live record stamps the full N).
 *
 * Slice contract: this module is `@/agent`-level. It imports `@/llm`
 * (ModelCandidate for diversification), `@/runtime/worktree-fork`
 * (`withWorktree` for fs isolation), and the existing `runAgent` orchestrator
 * — no upward import. Verifier impls live in a sibling file that may shell
 * via `@/runtime/shell`'s `runShell`; they MUST NOT import `@/tool` (which
 * would re-enter the agent graph).
 *
 * Default-OFF (RFC §1.2): every consumer treats `AgentConfig.branchSearch ===
 * undefined` as "no branch_search tool registered, no scoring overhead".
 * The byte-identical legacy single-trajectory path is preserved.
 */

import type { LLMPort, ModelCandidate } from "@/llm"

// ---------------------------------------------------------------------------
// Inputs / seeds
// ---------------------------------------------------------------------------

/**
 * Diversification axis applied to one candidate. ALL fields optional ⇒ the
 * candidate inherits the parent `AgentConfig`. Authors typically vary
 * `temperature` (Agentless §3 §3.1) AND `modelOverride` (mixed-model voting,
 * §4.2) AND a `promptHint` ("approach this differently / minimal patch /
 * conservative refactor").
 */
export interface BranchSeed {
  /** Sampling temperature override for this candidate. `undefined` ⇒ inherit. */
  temperature?: number
  /** Alternate provider+model. When set, the candidate uses this LLM instead
   *  of the parent's `config.llm`. Pulled from `AgentConfig.modelCandidates`
   *  (ADR-0066) by id so the candidate set composes with model-swap retry. */
  modelOverride?: ModelCandidate
  /** Free-form hint folded into the candidate's system prompt as
   *  `<branch-hint>${promptHint}</branch-hint>`. Used for "approach this
   *  differently": minimal-patch vs refactor vs add-feature-flag-and-skip. */
  promptHint?: string
}

// ---------------------------------------------------------------------------
// Candidate + verifier signals
// ---------------------------------------------------------------------------

/** A single attempt's running state. Filled out by `parallelPropose` and
 *  consumed by `Verifier`/`Scorer`. */
export interface BranchCandidate {
  /** Stable id within ONE `runBranchSearch` call: `cand-${i}`. */
  readonly id: string
  /** Seed that drove this candidate's variation. */
  readonly seed: BranchSeed
  /** Isolated workspace path. The candidate's `runAgent` runs with this as
   *  `cwd`; verifiers `runShell` against this. */
  readonly workspace: string
  /** Outcome of the candidate's own agent run. `kind:"completed"` means the
   *  candidate produced a coherent stop; verifiers may still find no patch
   *  or a broken patch. `kind:"failed"` short-circuits scoring to 0. */
  readonly outcome:
    | { kind: "completed"; turns: number; llmSelfConfidence?: number }
    | { kind: "failed"; reason: string }
}

/** Closed set of verifier kinds. Adding a kind here lets `Scorer` weight it
 *  via the static `SCORER_WEIGHT_KEYS` map (compile-time exhaustive). */
export type VerifierKind = "tsc" | "test" | "lint" | "lsp_diag" | "patch_size" | "llm_judge"

/** A single verifier's signed signal. `pass` is the binary outcome the
 *  default scorer adds with weight; `magnitude` is the optional 0..1 fine-
 *  grained value for verifiers that have one (e.g. lint = 1 - errors/N). */
export interface VerifierSignal {
  readonly kind: VerifierKind
  readonly pass: boolean
  /** Optional 0..1 — when present, scorers may weight by `magnitude` rather
   *  than the binary `pass`. Required to be in [0,1]. */
  readonly magnitude?: number
  /** Short human-readable detail (error count / first error / lint summary).
   *  Surfaced on OTel span + losers.jsonl. */
  readonly detail: string
  /** Wall-clock duration the verifier took. */
  readonly durationMs: number
}

/** Result of running a verifier pipeline against one candidate. */
export interface CandidateScore {
  /** Weighted total in [0..1]. Higher = better. */
  readonly total: number
  /** Per-kind signals — full audit trail for the OTel/loser sidecar. */
  readonly breakdown: ReadonlyArray<VerifierSignal>
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Verifier port: given an isolated candidate workspace, produce zero or more
 *  `VerifierSignal`s. Composed via `combineVerifiers` so callers wire the
 *  exact tier they need (CI: tsc+lint; bench: tsc+test+lsp_diag; daemon:
 *  tsc+lint+llm_judge). */
export type Verifier = (cand: BranchCandidate) => Promise<ReadonlyArray<VerifierSignal>>

/** Scorer port: pure fold from signals to a 0..1 total. Default impl uses
 *  weighted-sum; production may swap to ML-trained reward model. */
export type Scorer = (signals: ReadonlyArray<VerifierSignal>) => CandidateScore

/** Selector port: pure argmax (or tie-break) over scored candidates. */
export type Selector = (
  scored: ReadonlyArray<{ cand: BranchCandidate; score: CandidateScore }>,
) => BranchCandidate

/** Isolation port: produce a fresh, disposable workspace path for candidate
 *  `i`. Default impl wraps `runtime/worktree-fork#withWorktree`; tests may
 *  inject a plain `mkdtempSync` factory. The CALLER OWNS lifecycle — the
 *  orchestrator releases via the matching `cleanup` returned alongside. */
export interface Isolator {
  /** Create candidate `i`'s workspace. Returns the path + an idempotent
   *  cleanup. */
  acquire(i: number): Promise<{ workspace: string; cleanup: () => Promise<void> }>
}

// ---------------------------------------------------------------------------
// Orchestrator request / result
// ---------------------------------------------------------------------------

/** Trace events emitted by the orchestrator. Closed union — exhaustive switch
 *  with `never` default in any consumer. Used by OTel exporter + smoke
 *  fixture's loser sidecar. */
export type BranchTraceEvent =
  | { kind: "candidate-started"; id: string; seed: BranchSeed }
  | { kind: "candidate-finished"; id: string; turns: number; durationMs: number }
  | { kind: "candidate-failed"; id: string; reason: string }
  | { kind: "candidate-scored"; id: string; total: number; signals: ReadonlyArray<VerifierSignal> }
  | { kind: "winner-selected"; winnerId: string; total: number }

/** Inputs to `runBranchSearch`. */
export interface BranchSearchRequest {
  /** Candidate count (>=2). Hard cap at 8 — beyond that latency + cost
   *  dominates the diversity benefit (Agentless §6 ablation). */
  readonly N: number
  /** Per-candidate seeds. MUST have length === N. Authors typically build
   *  these with `buildSeeds(N, baseLlm, modelCandidates)` (see seed.ts). */
  readonly seeds: ReadonlyArray<BranchSeed>
  /** Base LLM for candidates whose seed has no `modelOverride`. Typically
   *  the parent `AgentConfig.llm`. */
  readonly baseLlm: LLMPort
  /** Task description folded into the candidate's prompt. Verbatim user
   *  message that triggered the speculative attempt. */
  readonly task: string
  /** Hard ceiling on per-candidate runtime. A timeout fails THAT candidate
   *  only — the others continue and the winner is picked among survivors. */
  readonly timeoutPerBranchMs: number
  /** Verifier pipeline (composed via `combineVerifiers`). */
  readonly verifier: Verifier
  /** Scorer (default: `defaultScorer`). */
  readonly scorer: Scorer
  /** Selector (default: `argmaxSelector`). */
  readonly selector: Selector
  /** Isolation factory. Default: `withWorktreeIsolator` (wraps
   *  `@/runtime/worktree-fork#withWorktree`). Tests inject a tmp-dir
   *  isolator. */
  readonly isolator: Isolator
  /** OTel + smoke trace sink. Calls are inline; consumer MUST NOT throw. */
  readonly onTrace?: (e: BranchTraceEvent) => void
}

/** Output of `runBranchSearch`. */
export interface BranchSearchResult {
  readonly winner: BranchCandidate
  readonly winnerScore: CandidateScore
  /** ALL scored candidates in stable input order — winner included, losers
   *  serialized to the trace's `losers.jsonl` sidecar. */
  readonly allScored: ReadonlyArray<{ cand: BranchCandidate; score: CandidateScore }>
  /** Sum of every candidate's wall-clock — for cost surfacing. */
  readonly totalWallMs: number
}

// ---------------------------------------------------------------------------
// AgentConfig opt-in shape (consumed by `branch_search` tool + mode-preset)
// ---------------------------------------------------------------------------

/** OPTIONAL slot on `AgentConfig.branchSearch`. When omitted the
 *  `branch_search` tool refuses to run (clean `ok:false` with a config-
 *  pointer message) and the legacy single-trajectory loop is byte-identical. */
export interface BranchSearchConfig {
  /** Default N when the model calls the tool without an explicit `n`. */
  readonly defaultN: number
  /** Default verifier-kind set when the model omits `verifier_kinds`. */
  readonly defaultVerifierKinds: ReadonlyArray<VerifierKind>
  /** Hard ceiling enforced on the orchestrator. */
  readonly timeoutPerBranchMs: number
  /** Scorer weight overrides — partial map; missing kinds use the default
   *  weight from `score.ts#DEFAULT_WEIGHTS`. */
  readonly weights?: Partial<Record<VerifierKind, number>>
  /** Isolation strategy ID. `"worktree"` (default): use git worktree (fast
   *  on big repos, requires git). `"tmpdir"`: `mkdtemp` + `cp -r` (slower
   *  but git-free — bench/test usage). */
  readonly isolation: "worktree" | "tmpdir"
}
