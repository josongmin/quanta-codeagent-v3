/**
 * Knob: `repro-exec-timeout` — per-repro-script execution timeout (ms).
 *
 * The repro/consensus path runs up to N candidate repro scripts (the
 * `repro-test` sample count) on the candidate tree. Each script's exec was
 * hardcoded to 60s (`DEFAULT_EXEC_TIMEOUT_MS`), with NO override path — so a slow
 * repo whose legitimate repro script takes >60s had every sample killed,
 * silently degrading the oracle, regardless of the (larger) per-instance budget.
 *
 * This knob makes the per-script cap tunable. Default-UNSET ⇒ 60000ms
 * (byte-identical to the prior hardcode). It is deliberately the PER-SCRIPT cap,
 * NOT the per-instance budget: the sample loop runs up to N scripts, so coupling
 * it to the full instance deadline would let N×deadline blow the budget.
 *
 * Default-UNSET ⇒ 60s. Domain: integer ms in [5_000, 600_000]. APPLY IS A NOOP —
 * consumed out of band (`posture.reproExecTimeoutMs` → `ReproTestConfig.execTimeoutMs`).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

/** Per-script repro exec timeout floor: below 5s even a trivial Python import +
 *  assert can't reliably finish under load, so a smaller value is a misconfig. */
const MIN_EXEC_TIMEOUT_MS = 5_000
/** Ceiling: 10min. The sample loop runs up to N scripts, so a per-script cap
 *  above the typical per-instance budget would let the repro phase blow it. */
const MAX_EXEC_TIMEOUT_MS = 600_000

const parseReproExecTimeout = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < MIN_EXEC_TIMEOUT_MS || n > MAX_EXEC_TIMEOUT_MS) return undefined
  return n
}

const applyReproExecTimeout = (cfg: AgentConfig): AgentConfig => cfg

export const reproExecTimeoutKnob: Knob<number> = {
  id: "repro-exec-timeout",
  envKey: "QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS",
  category: "validation",
  surfaces: SURFACES,
  parse: parseReproExecTimeout,
  apply: applyReproExecTimeout,
  describe:
    "Bench: per-repro-script exec timeout (ms, default 60000). Raise for slow repos whose repro scripts exceed 60s; it is the PER-SCRIPT cap, not the per-instance budget.",
  unit: "ms",
  costMultiplier: 1,
  source: "jun-22 magic-number config-extraction (was hardcoded DEFAULT_EXEC_TIMEOUT_MS=60000)",
}

registerKnob(reproExecTimeoutKnob)
