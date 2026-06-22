/**
 * Knob: `regression-max-tests` — how many discovered keep-green regression
 * witnesses are EXECUTED per candidate.
 *
 * The discovered-regression port ranks the repo's own tests impacted by a
 * candidate's changed files, then runs the top `maxTests` of them. That cap was
 * a hardcoded 12 (duplicated across two adapter files) with NO override path, so
 * a regression-bearing test ranked 13th never ran — bounding regression-gate
 * recall in a way a researcher could not sweep.
 *
 * Default-UNSET ⇒ the discovery port's own `DEFAULT_MAX_TESTS` (the single
 * runtime SSOT in `@/runner/batch/eval/impacted-test-discovery`; byte-identical
 * to the prior hardcode). This knob does NOT redeclare that literal — it cannot
 * import the batch slice (cross-slice fence, see cross-slice-cycle hellgate), so
 * the unset default is supplied where the value is consumed (the bench driver
 * passes `posture.regressionMaxTests` through to `makeDiscoveredRepoRegression-
 * Witness.maxTests`, which falls back to `DEFAULT_MAX_TESTS` when undefined).
 * Domain: integer in [1, 200]. APPLY IS A NOOP — consumed out of band.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseRegressionMaxTests = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) return undefined
  return n
}

const applyRegressionMaxTests = (cfg: AgentConfig): AgentConfig => cfg

export const regressionMaxTestsKnob: Knob<number> = {
  id: "regression-max-tests",
  envKey: "QUANTA_BENCH_REGRESSION_MAX_TESTS",
  category: "validation",
  surfaces: SURFACES,
  parse: parseRegressionMaxTests,
  apply: applyRegressionMaxTests,
  describe:
    "Bench: max discovered keep-green regression witnesses executed per candidate (default 12). Domain [1,200]. Raise for higher regression-gate recall.",
  unit: "tests",
  costMultiplier: 1,
  source: "jun-22 magic-number config-extraction (was hardcoded/duplicated DEFAULT_MAX_TESTS=12)",
}

registerKnob(regressionMaxTestsKnob)
