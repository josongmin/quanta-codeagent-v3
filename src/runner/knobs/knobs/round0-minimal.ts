/**
 * Knob: `round0-minimal` (WS1 mini-parity) — thin the ROUND-0 prompt to the
 * minimum signal the model needs, deferring scaffold prose to repair rounds.
 *
 * Motivation (measured): on the easy-django tail, quanta's round-0 prelude
 * accumulates `issueHint + closureHint + reproHint + baseText`, yet the closure
 * signal is one line (`First edit candidate: <file>`) while the repro directive
 * is bulky prose. mini-swe-agent — with a clean round-0 prompt — matched quanta
 * 1:1 on the tail and beat agentless-v1 on #10914. This knob removes that
 * baseline penalty: at round 0 (the agent's FIRST attempt, `seedMsg===undefined`)
 * the repro directive prose is SUPPRESSED; it re-attaches on repair rounds ≥1
 * (i.e. only once the primary rail has actually gone red and a repair seed is
 * built). The one-line `closureHint` (first-edit candidate) is KEPT.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`round0Minimal`
 * field) consumed in `buildConfig` (round-0 reproHint suppression). Exists here
 * so the resolver / report / preset layer can SEE the knob. Strict truthy gate:
 * `"1"`/`"on"`/`"true"` ⇒ enabled (byte-identical when unset/false).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const ENABLING = new Set(["1", "on", "true"])

const parseRound0Minimal = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING.has(raw.trim().toLowerCase()) ? true : undefined
}

const applyRound0Minimal = (cfg: AgentConfig): AgentConfig => cfg

export const round0MinimalKnob: Knob<true> = {
  id: "round0-minimal",
  envKey: "QUANTA_BENCH_ROUND0_MINIMAL",
  category: "tool",
  surfaces: SURFACES,
  parse: parseRound0Minimal,
  apply: applyRound0Minimal,
  describe: "WS1 mini-parity: thin round-0 prompt (defer repro prose to repair rounds)",
  source: "jun-18 mini-parity baseline-penalty removal (WS1)",
}

registerKnob(round0MinimalKnob)
