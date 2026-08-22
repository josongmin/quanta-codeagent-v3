/**
 * Knob: `repro-doubt` — break the `verify_loop_stuck` churn with a one-shot steer
 * that redirects the agent's suspicion from its PATCH to its REPRO TEST.
 *
 * Default-OFF. Apply sets `cfg.reproDoubt = { stuckRuns: N }`. The guard logic lives
 * in `@/agent/repro-doubt-guard`; this knob only carries the threshold.
 *
 * Motivation (jun-20-bestofn-wrong-repro-oracle-root): on synthesis-heavy fails the
 * agent edits the right site but the false-negative repro oracle keeps the test red,
 * so it re-runs the test until the turn budget dies (124 turns → FAIL). After N
 * consecutive test re-runs with no edit, the steer fires once.
 *
 * Domain (ACTIVE): integer N in [2, 12] ⇒ `{ stuckRuns: N }`.
 * Domain (INACTIVE — `parse` ⇒ undefined): absent / empty / non-integer / < 2 / > 12.
 *   - < 2 would fire after a single test run (false-positive on normal verify).
 *   - > 12 never trips on a maxTurns≈30/60 run (dead knob).
 * Closed parser: `Number(...)` + `Number.isInteger` (no parseInt partial-parse).
 * envKey: `QUANTA_BENCH_REPRO_DOUBT` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */
import type { AgentConfig } from "@/agent"
import { reproDoubtSchema } from "@/config/knob-schema/schemas/bench-repro"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

interface ReproDoubtValue {
  readonly stuckRuns: number
}

/** Non-NOOP apply — folds `cfg.reproDoubt`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applyReproDoubt = (
  cfg: AgentConfig,
  value: ReproDoubtValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, reproDoubt: { stuckRuns: value.stuckRuns } }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const reproDoubtKnob = deriveKnob(reproDoubtSchema, applyReproDoubt)
