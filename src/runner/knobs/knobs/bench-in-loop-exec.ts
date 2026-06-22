/**
 * Knob: `bench-in-loop-exec` — controls how much execution authority the bench
 * agent gets inside its own solve loop.
 *
 * Default-ON/FULL (the byte-identical fence): when the knob is UNSET, `parse`
 * returns `undefined`, the posture defaults the mode to `"full"`, and the
 * driver emits the exact SWEBENCH_DIRECTIVE + verifyGuard it does today.
 *
 * FULL (explicit "1"/"on"/"true"/"full"): run the repository tests in-loop
 * (today's behavior).
 *
 * REPRO-ONLY (explicit "repro-only"/"repro"): allow ONLY narrow issue
 * reproduction in-loop. The driver emits a focused directive that permits a
 * small reproducer or issue script but still forbids broad repo-test / pytest /
 * tox execution, keeps verifyGuard OFF, and keeps the repair loop OFF. This
 * splits "run a tiny reproducer" from "run the full regression suite" so the
 * bench can keep executable issue evidence without reintroducing host-env flail.
 *
 * OFF (explicit "0"/"off"/"false"): the driver swaps to SWEBENCH_DIRECTIVE_NOEXEC
 * (no execution), drops verifyGuard, forces single-pass, and skips the
 * repro-test hint entirely. This removes a self-defeating forcing function on
 * instances whose host test-env is incompatible (e.g. pytest-7982), where the
 * agent obeys a MANDATORY "run the tests" directive it cannot satisfy, flails,
 * and aborts → empty_patch.
 *
 * APPLY IS A NOOP — like the other bench knobs the EFFECT is delivered out of
 * band by the driver (`benchPostureFromState` projection → `opt.inLoopExecMode`).
 * This registry entry exists ONLY so the bench resolver / report / preset layer
 * can SEE the knob.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const OFF = new Set(["0", "off", "false"])
const FULL = new Set(["1", "on", "true", "full"])

export type BenchInLoopExecModeKnob = "full" | "repro-only" | "off"

/**
 * Closed tri-state parser. Unset / empty ⇒ `undefined` so the posture default
 * (`"full"`) holds. Explicit tokens map to canonical modes.
 */
const parseBenchInLoopExec = (raw: string | undefined): BenchInLoopExecModeKnob | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (OFF.has(s)) return "off"
  if (s === "repro-only" || s === "repro") return "repro-only"
  if (FULL.has(s)) return "full"
  return undefined
}

const applyBenchInLoopExec = (cfg: AgentConfig): AgentConfig => cfg

export const benchInLoopExecKnob: Knob<BenchInLoopExecModeKnob> = {
  id: "bench-in-loop-exec",
  envKey: "QUANTA_BENCH_IN_LOOP_EXEC",
  category: "verify",
  surfaces: SURFACES,
  parse: parseBenchInLoopExec,
  apply: applyBenchInLoopExec,
  describe:
    "Bench: execution authority mode (default full). full = repo tests in-loop; repro-only = focused issue reproduction only; off = edit-and-submit with no execution.",
  unit: "mode",
  source: "mini-swe posture absorption (pytest-7982 incompatible-host-env flail)",
}

registerKnob(benchInLoopExecKnob)
