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
 */
import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

interface ReproDoubtValue {
  readonly stuckRuns: number
}

const parseReproDoubt = (raw: string | undefined): ReproDoubtValue | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 2) return undefined
  if (n > 12) return undefined
  return { stuckRuns: n }
}

const applyReproDoubt = (
  cfg: AgentConfig,
  value: ReproDoubtValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, reproDoubt: { stuckRuns: value.stuckRuns } }
}

export const reproDoubtKnob: Knob<ReproDoubtValue> = {
  id: "repro-doubt",
  envKey: "QUANTA_BENCH_REPRO_DOUBT",
  category: "agent",
  surfaces: SURFACES,
  parse: parseReproDoubt,
  apply: applyReproDoubt,
  describe: "After N test re-runs with no edit, steer the agent to doubt its repro test (break verify_loop_stuck)",
  unit: "runs",
  source: "jun-20-bestofn-wrong-repro-oracle-root",
}

registerKnob(reproDoubtKnob)
