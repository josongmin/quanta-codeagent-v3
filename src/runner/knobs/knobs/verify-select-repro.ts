/**
 * Knob: `verify-select-repro` — controls how generated repro consensus is used
 * inside verify-and-select.
 *
 * Unset preserves legacy behavior: resolved K-of-N is a hard gate. Explicit:
 *   - `hard`: votes<k rejects the candidate.
 *   - `positive` / `soft`: votes/k is a soft ranking signal only.
 *   - `off` / `0` / `false`: do not run the resolved consensus selection port.
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver
 * (`posture.verifySelectRepro`), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export type VerifySelectReproMode = "hard" | "positive" | "off"

const parseVerifySelectRepro = (raw: string | undefined): VerifySelectReproMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "hard" || s === "gate") return "hard"
  if (s === "positive" || s === "soft") return "positive"
  if (s === "off" || s === "0" || s === "false") return "off"
  return undefined
}

const applyVerifySelectRepro = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectReproKnob: Knob<VerifySelectReproMode> = {
  id: "verify-select-repro",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectRepro,
  apply: applyVerifySelectRepro,
  describe:
    "Verify-and-select generated repro consensus mode: hard gate, positive-only soft signal, or off",
  unit: "mode",
  costMultiplier: 1,
  source: "verify-and-select no-oracle repro consensus demotion",
}

registerKnob(verifySelectReproKnob)
