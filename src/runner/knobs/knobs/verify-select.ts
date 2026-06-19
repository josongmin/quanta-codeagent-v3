/**
 * Knob: `verify-select` — the OUTER control plane's verify-and-select executor.
 *
 * Value = N, the number of candidate patches to generate per instance. The
 * bench driver then generates N candidates (closure-localization-seeded for
 * DIVERSITY — candidate i is nudged toward the i-th ranked owner so the set
 * spans different *fix sites*, not N samples of the same anchor), scores each
 * through the {@link VerificationBundle} (hard gates AND + soft rank), and
 * submits `selectBest` (or the best-effort pick when none is admissible).
 *
 * This is the corrected north-star: no single noisy oracle holds global verdict
 * authority — bounded repair stays an INNER candidate-gen tactic; the OUTER
 * plane is verify-and-select. Motivated by the measured cause-vs-symptom
 * failure (a run fixates on the symptom site; diversity-gen + owner-coverage
 * selection lets a sibling candidate that touches the ROOT-cause file win).
 *
 * Default-OFF (unset ⇒ single-pass ⇒ byte-identical). Domain: integer N in
 * [1, 8]; anything else ⇒ `undefined`. Honest cost ≈ ×N agent invocations.
 *
 * APPLY IS A NOOP — consumed out of band by the bench driver's runInstance
 * (`posture.verifySelectN` → runSelectionPhase), not stored on `AgentConfig`.
 * NOT in any preset until the on-demand A/B measures it (no effect claim first).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelect = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 8) return undefined
  return n
}

const applyVerifySelect = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectKnob: Knob<number> = {
  id: "verify-select",
  envKey: "QUANTA_BENCH_VERIFY_SELECT",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelect,
  apply: applyVerifySelect,
  describe: "Verify-and-select: generate N candidates, score via VerificationBundle, submit the best",
  unit: "candidates",
  // Per-candidate full agent invocation; static worst case at the cap.
  costMultiplier: 8,
  source: "verify-and-select Phase 1 (jun-19) — TD selection executor",
}

registerKnob(verifySelectKnob)
