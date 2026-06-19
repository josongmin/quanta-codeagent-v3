/**
 * Knob: `verify-select-concurrency` — how many verify-and-select candidates
 * are GENERATED concurrently (the {@link runSelection} `concurrency` cap).
 *
 * Companion to `verify-select` (which sets N, the candidate count). Value = the
 * max candidates whose agent run is in flight at once. Default-UNSET ⇒ the
 * executor runs candidates SEQUENTIALLY (one shared sandbox, byte-identical to
 * the pre-concurrency path). A value >1 requires the driver's candidate
 * generator to ISOLATE each candidate (its own sandbox + deadline) — otherwise
 * concurrent agent runs corrupt one shared git tree.
 *
 * ⚠️ THROTTLE: total in-flight agents ≈ instance-concurrency × this. Keep it
 * SMALL (2-3) so the product stays under the LLM rate-limit ceiling — naive
 * full parallelism (e.g. 6 instances × 8 candidates = 48 agents) is the
 * concurrent-run throttle that has repeatedly killed bench infra.
 *
 * Default-OFF (unset ⇒ sequential). Domain: integer in [1, 8]. APPLY IS A NOOP
 * — consumed out of band by runInstance (`posture.verifySelectConcurrency` →
 * runSelection.concurrency), not stored on `AgentConfig`.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseVerifySelectConcurrency = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 8) return undefined
  return n
}

const applyVerifySelectConcurrency = (cfg: AgentConfig): AgentConfig => cfg

export const verifySelectConcurrencyKnob: Knob<number> = {
  id: "verify-select-concurrency",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY",
  category: "validation",
  surfaces: SURFACES,
  parse: parseVerifySelectConcurrency,
  apply: applyVerifySelectConcurrency,
  describe: "Verify-and-select: max candidates generated concurrently (requires isolated generate)",
  unit: "concurrent",
  costMultiplier: 1,
  source: "verify-and-select Phase 1 (jun-19) — bounded-parallel candidate gen",
}

registerKnob(verifySelectConcurrencyKnob)
