/**
 * Knob: `no-patch-force-fraction` — at what fraction of the turn budget the
 * no-patch breaker injects the "stop exploring, make the edit now" steer.
 *
 * The breaker fires when no mutating edit has landed by `fraction × maxTurns`
 * turns. The fraction was a hardcoded 0.8 with NO override path (the breaker
 * knob is a bool on/off), so the over-exploration lever — how much budget the
 * agent gets before being pushed to commit — was un-sweepable.
 *
 * Default-UNSET ⇒ 0.8 (byte-identical to the prior hardcode). Domain: float in
 * (0, 1). APPLY IS A NOOP — consumed out of band (`posture.noPatchForceFraction`
 * → `wireNoPatchBreaker` → `decideNoPatch.forceCommitAtFraction`). Only takes
 * effect when the `no-patch-breaker` knob is ON.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseNoPatchForceFraction = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^0?\.\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return undefined
  return n
}

const applyNoPatchForceFraction = (cfg: AgentConfig): AgentConfig => cfg

export const noPatchForceFractionKnob: Knob<number> = {
  id: "no-patch-force-fraction",
  envKey: "QUANTA_BENCH_NO_PATCH_FORCE_FRACTION",
  category: "agent",
  surfaces: SURFACES,
  parse: parseNoPatchForceFraction,
  apply: applyNoPatchForceFraction,
  describe:
    "Bench: no-patch breaker fires at this fraction of the turn budget (default 0.8). Domain (0,1). Only active when no-patch-breaker is on.",
  unit: "fraction",
  costMultiplier: 1,
  source: "jun-22 magic-number config-extraction (was hardcoded DEFAULT_FORCE_FRACTION=0.8)",
}

registerKnob(noPatchForceFractionKnob)
