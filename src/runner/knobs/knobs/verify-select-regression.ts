/**
 * Knob: `verify-select-regression` — selects the regression hard-signal source
 * used by the verify-and-select executor.
 *
 * Unset preserves the existing verify-select behavior (eval-only PASS_TO_PASS
 * when available). Explicit values:
 *   - `discovered` / `repo` / `native`: no-oracle impacted repo-test discovery.
 *   - `gold` / `pass-to-pass`: eval-only hidden PASS_TO_PASS regression set.
 *   - `off` / `0` / `false`: disable the regression hard signal (A/B ablation).
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver
 * (`posture.verifySelectRegression`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export type VerifySelectRegressionMode = "discovered" | "gold" | "off"

const parseVerifySelectRegression = (
  raw: string | undefined,
): VerifySelectRegressionMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "discovered" || s === "repo" || s === "native") return "discovered"
  if (s === "gold" || s === "pass-to-pass" || s === "passtoppass") return "gold"
  if (s === "off" || s === "0" || s === "false") return "off"
  return undefined
}

const applyVerifySelectRegression = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectRegressionKnob: Knob<VerifySelectRegressionMode> = {
  id: "verify-select-regression",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectRegression,
  apply: applyVerifySelectRegression,
  describe:
    "Verify-and-select regression source: discovered repo tests, eval-only gold PASS_TO_PASS, or off",
  unit: "mode",
  costMultiplier: 1,
  source: "verify-and-select no-oracle regression gate",
}

registerKnob(verifySelectRegressionKnob)
