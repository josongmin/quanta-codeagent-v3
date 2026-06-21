/**
 * Knob: `selector-mode` — selector authority mode for verify-and-select.
 *
 * Chooses which gate authority the selector is allowed to exercise:
 *   - `clean`: only executable/structural hard gates decide selection.
 *   - `research`: legacy heuristic gates are additionally allowed (default).
 *
 * Unset ⇒ undefined ⇒ projected to `"research"` by `benchPostureFromState`
 * (`posture.selectorMode`) so existing presets/runs stay byte-identical.
 *
 * APPLY IS A NOOP — consumed out of band by the bench selection executor
 * (`posture.selectorMode`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export type SelectorModeKnob = "clean" | "research"

const parseSelectorMode = (raw: string | undefined): SelectorModeKnob | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "clean") return "clean"
  if (s === "research") return "research"
  return undefined
}

const applySelectorMode = (cfg: AgentConfig): AgentConfig => cfg

export const selectorModeKnob: Knob<SelectorModeKnob> = {
  id: "selector-mode",
  envKey: "QUANTA_BENCH_SELECTOR_MODE",
  category: "validation",
  surfaces: SURFACES,
  parse: parseSelectorMode,
  apply: applySelectorMode,
  describe:
    "Selector authority mode: clean (only executable/structural hard gates) vs research (legacy heuristic gates allowed)",
  unit: "mode",
  costMultiplier: 1,
  source: "jun-21 heuristic authority cleanup",
}

registerKnob(selectorModeKnob)
