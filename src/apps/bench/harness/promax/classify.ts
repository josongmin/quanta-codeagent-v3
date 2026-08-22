/**
 * PMX-03 — the ONE classification table: pinned-evaluator verdicts → the
 * generic four-state official-grade outcome.
 *
 * TWO RULES, and everything else follows from them.
 *
 * 1. GOLDEN AUTHORITY FIRST. The evaluator runs the reference patch through the
 *    same image and eval script as the model patch. If the REFERENCE did not
 *    pass, the row says nothing about the model — the environment/image/eval
 *    script is broken, and calling that a model failure would silently deflate
 *    the score while looking like an honest miss. So the model side is read
 *    only when golden is `success`.
 *
 * 2. `passed` IS NEVER CONSULTED. Upstream computes it as
 *    `model.final_result == "success" and golden.final_result == "success"`,
 *    which is derivable from the two states we already read — and a drifted,
 *    forged, or legacy-format document could set it independently. Retaining it
 *    for audit is useful; trusting it is not.
 *
 * EXHAUSTIVENESS: both tables are `Record<OfficialFinalResult, …>`, so a state
 * added to the pinned union fails to COMPILE until it is classified. A runtime
 * drift guard (run at module load) pins the other direction, catching a table
 * built from a widened `string` key at some future refactor.
 */
import type { OfficialGradeReason, OfficialGradeState } from "@/runner/batch/eval/official-grade"
import { OFFICIAL_GRADE_STATE_BY_REASON } from "@/runner/batch/eval/official-grade"
import type { OfficialFinalResult } from "./official-result"
import { OFFICIAL_FINAL_RESULTS } from "./official-result"

/** What the classifier concluded about one instance. */
export interface ModelOutcome {
  readonly state: OfficialGradeState
  readonly reason: OfficialGradeReason
}

/**
 * What the GOLDEN side permits. Either the model may be scored, or the golden
 * side has already decided the outcome by itself.
 */
export type GoldenAuthority =
  | { readonly kind: "model_scored" }
  | { readonly kind: "blocked"; readonly outcome: ModelOutcome }

const blocked = (state: OfficialGradeState, reason: OfficialGradeReason): GoldenAuthority => ({
  kind: "blocked",
  outcome: { state, reason },
})

/**
 * GOLDEN verdict → authority. Only `success` unlocks model scoring.
 *
 * `need_human_review` is `ambiguous`, not `infra_invalid`: upstream reaches it
 * when model and golden failed the SAME way, which is a genuinely undecided
 * row, not a known-broken one. Collapsing it into either scored bucket would
 * invent a verdict the evaluator explicitly refused to give.
 */
export const GOLDEN_AUTHORITY_TABLE: Record<OfficialFinalResult, GoldenAuthority> = {
  success: { kind: "model_scored" },
  apply_failed: blocked("infra_invalid", "golden_apply_failed"),
  test_patch_apply_failed: blocked("infra_invalid", "golden_test_patch_apply_failed"),
  timeout_apply: blocked("infra_invalid", "golden_timeout_apply"),
  timeout_eval: blocked("infra_invalid", "golden_timeout_eval"),
  "non zero exit": blocked("infra_invalid", "golden_non_zero_exit"),
  need_human_review: blocked("ambiguous", "upstream_need_human_review"),
}

/**
 * MODEL verdict → outcome, applied ONLY under golden success.
 *
 * Every model-side failure here is a MODEL MISS, timeouts included: the
 * reference proved the environment works within the same budget, so the model's
 * patch is what failed to get there. Treating a model timeout as infrastructure
 * would let a slow or looping candidate quietly leave the denominator.
 */
export const MODEL_OUTCOME_TABLE: Record<OfficialFinalResult, ModelOutcome> = {
  success: { state: "resolved", reason: "official_resolved" },
  apply_failed: { state: "model_miss", reason: "patch_apply_failed" },
  test_patch_apply_failed: { state: "model_miss", reason: "test_patch_apply_failed" },
  timeout_apply: { state: "model_miss", reason: "model_apply_timeout" },
  timeout_eval: { state: "model_miss", reason: "model_eval_timeout" },
  "non zero exit": { state: "model_miss", reason: "test_failed" },
  need_human_review: { state: "ambiguous", reason: "upstream_need_human_review" },
}

export interface ClassificationTables {
  readonly goldenAuthority: Record<OfficialFinalResult, GoldenAuthority>
  readonly modelOutcome: Record<OfficialFinalResult, ModelOutcome>
}

export const PRODUCTION_CLASSIFICATION_TABLES: ClassificationTables = {
  goldenAuthority: GOLDEN_AUTHORITY_TABLE,
  modelOutcome: MODEL_OUTCOME_TABLE,
}

/**
 * Classify against EXPLICIT tables. This seam exists so the table itself can be
 * proven load-bearing: a test runs the whole fixture suite against a corrupted
 * copy and requires it to go red (see the red-on-injection tests).
 */
export const classifyWithTables = (
  golden: OfficialFinalResult,
  model: OfficialFinalResult,
  tables: ClassificationTables,
): ModelOutcome => {
  const authority = tables.goldenAuthority[golden]
  if (authority.kind === "blocked") return authority.outcome
  return tables.modelOutcome[model]
}

/** Classify one (golden, model) pair with the production tables. */
export const classifyOfficialPair = (
  golden: OfficialFinalResult,
  model: OfficialFinalResult,
): ModelOutcome => classifyWithTables(golden, model, PRODUCTION_CLASSIFICATION_TABLES)

const keyDrift = (label: string, table: Record<string, unknown>): string | null => {
  const expected = new Set<string>(OFFICIAL_FINAL_RESULTS)
  const actual = new Set(Object.keys(table))
  const absent = [...expected].filter((k) => !actual.has(k))
  const extra = [...actual].filter((k) => !expected.has(k))
  if (absent.length === 0 && extra.length === 0) return null
  return `${label} drifted from the pinned evaluator states — absent: [${absent.join(", ")}], unexpected: [${extra.join(", ")}]`
}

/**
 * Runtime drift guard. `Record<Union, …>` proves the table has no HOLES at
 * compile time; this proves it has no EXTRAS and that its keys are still the
 * pinned state list, which type-level exhaustiveness cannot see once a key type
 * widens to `string`. It also checks every emitted reason still belongs to the
 * state it is emitted with, so the two modules cannot drift apart.
 */
export const assertClassificationTablesInSync = (
  tables: ClassificationTables = PRODUCTION_CLASSIFICATION_TABLES,
): void => {
  const problems = [
    keyDrift("GOLDEN_AUTHORITY_TABLE", tables.goldenAuthority),
    keyDrift("MODEL_OUTCOME_TABLE", tables.modelOutcome),
  ].filter((p): p is string => p !== null)

  const outcomes: ModelOutcome[] = Object.values(tables.modelOutcome)
  for (const authority of Object.values(tables.goldenAuthority)) {
    if (authority.kind === "blocked") outcomes.push(authority.outcome)
  }
  for (const outcome of outcomes) {
    const owner = OFFICIAL_GRADE_STATE_BY_REASON[outcome.reason]
    if (owner !== outcome.state) {
      problems.push(
        `classification emits reason "${outcome.reason}" with state "${outcome.state}", ` +
          `but the runner contract owns it under "${String(owner)}"`,
      )
    }
  }
  if (problems.length > 0) throw new Error(`PMX-03 classification drift: ${problems.join(" | ")}`)
}

assertClassificationTablesInSync()
