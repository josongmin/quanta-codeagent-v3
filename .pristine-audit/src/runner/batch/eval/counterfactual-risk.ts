/**
 * Counterfactual candidate risk facts — the deterministic, typed evidence set
 * derived from candidate 0's structural patch-budget analysis.
 *
 * This is NOT a heuristic verdict. It is a stable fact object that BOTH the
 * counterfactual seed builder (T-202) and the counterfactual contract selector
 * (T-301) consume, so neither has to re-parse risk-gate reason strings.
 *
 * Source of truth: {@link PatchBudgetVerdict} (`@/agent/patch-budget`), already
 * computed by the strict risk gate — we forward it instead of recomputing.
 */

import type { PatchBudgetVerdict } from "@/agent/patch-budget"

export interface CandidateRiskFacts {
  /** distinct non-test SOURCE files cand0 touched (budget.sourceFiles). */
  readonly touchedSourceFiles: number
  /** closure-ranked owner files for this instance. */
  readonly ownerFiles: readonly string[]
  /** touched source files NOT in the owner set (the cross-file escape gate). */
  readonly filesOutsideOwner: readonly string[]
  /** files cand0 created (`new file mode`). */
  readonly newFiles: number
  /** added `def`/`class`/`async def` lines (new helper/method/class). */
  readonly newDefs: number
  /** added runtime-expanding calls (compiler/IO/DB/subprocess). */
  readonly runtimeExpandingCalls: number
  /** cand0 touched more than one source file. */
  readonly crossFile: boolean
  /** cand0 produced an empty (no-op) diff. */
  readonly emptyPatch: boolean
  /** cheap-validation applyability of cand0 (null ⇒ not probed / fail-open). */
  readonly applyClean: boolean | null
  /** issue-declared expected-behavior match (null ⇒ no public-issue evidence). */
  readonly declaredExpectedMatch: boolean | null
  /** stable machine-readable structural reasons (from the patch-budget verdict). */
  readonly structuralReasons: readonly string[]
  /** OPTIONAL LLM shadow gate advisory reasons — telemetry only, never authority. */
  readonly llmShadowReasons?: readonly string[]
}

/**
 * Project a candidate-0 {@link PatchBudgetVerdict} (+ cheap validation results)
 * into the shared {@link CandidateRiskFacts} contract. Pure, deterministic, and
 * free of reason-string parsing: every field comes from typed budget counts.
 */
export const extractCandidateRiskFacts = (args: {
  readonly verdict: PatchBudgetVerdict
  readonly ownerFiles: readonly string[]
  readonly emptyPatch: boolean
  readonly applyClean?: boolean | null
  readonly declaredExpectedMatch?: boolean | null
  readonly llmShadowReasons?: readonly string[]
}): CandidateRiskFacts => {
  const b = args.verdict.budget
  return {
    touchedSourceFiles: b.sourceFiles,
    ownerFiles: args.ownerFiles,
    filesOutsideOwner: b.filesOutsideOwner,
    newFiles: b.newFiles,
    newDefs: b.newDefs,
    runtimeExpandingCalls: b.runtimeExpandingCalls,
    crossFile: b.crossFile,
    emptyPatch: args.emptyPatch,
    applyClean: args.applyClean ?? null,
    declaredExpectedMatch: args.declaredExpectedMatch ?? null,
    structuralReasons: args.verdict.overBudgetReasons,
    ...(args.llmShadowReasons !== undefined ? { llmShadowReasons: args.llmShadowReasons } : {}),
  }
}
