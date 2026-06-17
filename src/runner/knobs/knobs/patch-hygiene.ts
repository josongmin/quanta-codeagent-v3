/**
 * Knob: `patch-hygiene` (T-401) — run the typed `PatchHygieneReport` over the
 * candidate diff to flag stray/out-of-scope files structurally (stray added
 * files deny; owner-outside is telemetry-only).
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`patchHygiene` field).
 * Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parsePatchHygiene = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyPatchHygiene = (cfg: AgentConfig): AgentConfig => cfg

export const patchHygieneKnob: Knob<true> = {
  id: "patch-hygiene",
  envKey: "QUANTA_BENCH_PATCH_HYGIENE",
  category: "tool",
  surfaces: SURFACES,
  parse: parsePatchHygiene,
  apply: applyPatchHygiene,
  describe: "T-401 patch hygiene gate (stray-file deny, owner-outside telemetry)",
  source: "jun-17 proof-driven bench closure (T-401)",
}

registerKnob(patchHygieneKnob)
