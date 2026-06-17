/**
 * Knob: `no-patch-breaker` (T-501) — post-localization commit rail + no-patch
 * exhausted verdict: force a best-edit commit when budget is mostly spent with no
 * edit (the `#9296`-class over-exploration collapse), and record an explicit
 * `exhausted` verdict at budget end instead of a silent empty patch.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`noPatchBreaker`
 * field). Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseNoPatchBreaker = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyNoPatchBreaker = (cfg: AgentConfig): AgentConfig => cfg

export const noPatchBreakerKnob: Knob<true> = {
  id: "no-patch-breaker",
  envKey: "QUANTA_BENCH_NO_PATCH_BREAKER",
  category: "tool",
  surfaces: SURFACES,
  parse: parseNoPatchBreaker,
  apply: applyNoPatchBreaker,
  describe: "T-501 post-localization commit rail + no-patch exhausted verdict",
  source: "jun-17 proof-driven bench closure (T-501)",
}

registerKnob(noPatchBreakerKnob)
