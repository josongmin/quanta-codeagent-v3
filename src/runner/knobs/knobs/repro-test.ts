/**
 * Knob: `repro-test` — Agentless §3.3.1 reproduction-test K-sample
 * generation.
 *
 * Default-OFF. Migrated verbatim from `parseBenchReproTestK` in
 * `src/runner/batch/eval/driver.ts`. The K value drives an LLM K-stream that
 * writes `reproduce_issue.py` into the sandbox before the agent runs.
 *
 * Domain (ACTIVE):
 *   - integer K in [1, 40] ⇒ `{ samples: K }`.
 *
 * Domain (INACTIVE):
 *   - absent / empty / whitespace
 *   - `"0"` / negative
 *   - non-integer / NaN / garbage
 *   - K > 40 (paper cap; bounds LLM cost)
 *
 * APPLY IS A NOOP — like `issue-hint`, the K value is consumed by the bench
 * driver out of band (`installReproTestHint` → `prepareReproTest` →
 * `REPRO_HINT_MESSAGE` threaded as a separate `reproHint` string into
 * `buildConfig`). It is NOT a field on `AgentConfig`. Registry knob status is
 * still required so the matrix / cost-multiplier / surface gating sees it.
 *
 * `costMultiplier: K` — explicit matrix budget contract (per-K LLM calls).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

interface ReproTestValue {
  readonly samples: number
}

const parseReproTest = (raw: string | undefined): ReproTestValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 40) return undefined
  return { samples: n }
}

const applyReproTest = (
  cfg: AgentConfig,
  _value: ReproTestValue,
  _ctx: { surface: Surface },
): AgentConfig => {
  // Intentional noop — repro-test is consumed by the bench driver out of
  // band (installReproTestHint), not stored on AgentConfig.
  return cfg
}

export const reproTestKnob: Knob<ReproTestValue> = {
  id: "repro-test",
  envKey: "QUANTA_BENCH_REPRO_TEST",
  category: "validation",
  surfaces: SURFACES,
  parse: parseReproTest,
  apply: applyReproTest,
  describe: "Agentless §3.3.1 reproduction-test K-sample generation",
  unit: "samples",
  // Static worst case (max K=40). The registry uses the per-instance parsed
  // value when scheduling matrix budget.
  costMultiplier: 40,
  source: "Agentless paper §3.3.1",
}

registerKnob(reproTestKnob)
