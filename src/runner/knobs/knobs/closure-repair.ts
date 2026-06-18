/**
 * Knob: `closure-repair` — the EXECUTION half of the closure-driven runner.
 *
 * The closure engine (fault-evidence / verification-plan / primary-rail) builds
 * a typed ClosureBundle (evidence → owner → plan → gate) and SELECTS a primary
 * rail with a successPredicate. But selecting a rail is inert unless something
 * ACTS on it: the `gate.action === "verify"` path runs repair rounds that
 * re-run the rail and feed the failure tail back to the agent. That repair loop
 * was previously reachable ONLY via the `--repair-rounds` CLI flag / the
 * `QUANTA_REPAIR_ROUNDS` env, which is DISCONNECTED from the preset — so an
 * `agentless-v2` run selected a rail (primary_rail_present_rate ≈ 0.82) yet
 * NEVER entered the verify phase (gate_enter_rate = n=0). The rail was a
 * judgment with no executor.
 *
 * This knob lets a PRESET declare the repair budget so the closure bundle is an
 * actual EXECUTOR, not just a "smart prompt". Value = max repair rounds.
 *
 * Default-OFF (unset ⇒ no repair ⇒ byte-identical single-pass path). Domain:
 * integer N in [1, 10]; anything else ⇒ `undefined`.
 *
 * APPLY IS A NOOP — the budget is consumed out of band by the bench driver's
 * runInstance (`deps.repair ?? posture.repairRounds` → runRepairPhase), not
 * stored on `AgentConfig`. The CLI flag still wins (operator override); this is
 * the preset-level fallback.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseClosureRepair = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 10) return undefined
  return n
}

const applyClosureRepair = (cfg: AgentConfig): AgentConfig => cfg

export const closureRepairKnob: Knob<number> = {
  id: "closure-repair",
  envKey: "QUANTA_BENCH_CLOSURE_REPAIR",
  category: "validation",
  surfaces: SURFACES,
  parse: parseClosureRepair,
  apply: applyClosureRepair,
  describe: "Repair-round budget for the closure gate's verify-first path (max N rounds)",
  // Per-round LLM re-seed cost; static worst case at the cap.
  costMultiplier: 10,
  source: "closure-driven runner (jun-18) — the execution half of T-302",
}

registerKnob(closureRepairKnob)
