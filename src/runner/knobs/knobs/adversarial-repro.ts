/**
 * Knob: `adversarial-repro` — repro-quality lever (jun-19 #10999 under-fix class,
 * RE-PURPOSED jun-23 canonical/hardening split).
 *
 * ⚠️ SEMANTICS SHIFT (jun-23): this knob NO LONGER makes the single submit repro
 * adversarial. Folding the over-strict "every incidental case must pass" demand
 * into the SUBMIT oracle made it a 75% gold false-NEGATIVE (the canonical-correct
 * gold fix could not satisfy the many incidental cases), and with
 * `verify-select-proof-required` the proof gate then WITHHELD the correct patch —
 * structurally unwinnable. So the adversarial coverage is now a SEPARATE ADVISORY
 * `hardening` repro set, never the submit gate.
 *
 * ON ⇒ the driver ALSO generates the advisory HARDENING repro set (boundary /
 * must-reject / consistency, "do NOT copy the issue's proposed fix") alongside
 * the plain CANONICAL submit-gate set. Hardening reproes stay RED on a shallow
 * fix — useful for tie-break / repair seeding — but they NEVER block submit /
 * withhold. The canonical submit oracle keeps the plain core-symptom contract,
 * so a minimal correct fix can still flip it green. Default-OFF ⇒ canonical-only
 * (byte-identical reproducing set for the submit gate).
 *
 * APPLY IS A NOOP — the EFFECT is delivered out of band by the bench driver:
 * `benchPostureFromState` projects `adversarialRepro`, which the driver threads
 * into `generateReproCandidateTests` (it ALSO generates the advisory hardening
 * set alongside the canonical submit set). Registry status is required
 * for resolver/report/preset. Strict truthy gate: unset/`0`/`off`/`false` ⇒ off.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseAdversarialRepro = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}

const applyAdversarialRepro = (cfg: AgentConfig): AgentConfig => cfg

export const adversarialReproKnob: Knob<boolean> = {
  id: "adversarial-repro",
  envKey: "QUANTA_BENCH_ADVERSARIAL_REPRO",
  category: "tool",
  surfaces: SURFACES,
  parse: parseAdversarialRepro,
  apply: applyAdversarialRepro,
  describe:
    "ALSO generate an advisory HARDENING repro set (boundary/must-reject/no-copy-suggested-fix) for tie-break/repair — NEVER the submit gate (jun-23 canonical/hardening split; #10999 under-fix class)",
  source:
    "jun-19 repro-quality domino (10999 RCA); jun-23 split: advisory hardening, submit gate stays canonical (75% gold-FN fix)",
}

registerKnob(adversarialReproKnob)
