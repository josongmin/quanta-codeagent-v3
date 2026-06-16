/**
 * Knob: `bench-in-loop-exec` — controls whether the bench agent is told to RUN
 * the repository's tests inside its own solve loop (today's behavior) or to
 * edit-and-submit in the mini-swe posture (the grader runs the tests).
 *
 * Default-ON (the byte-identical fence): when the knob is UNSET, `parse` returns
 * `undefined`, the posture defaults `inLoopExec` to `true`, and the driver emits
 * the exact SWEBENCH_DIRECTIVE + verifyGuard it does today.
 *
 * OFF (explicit "0"/"off"/"false"): the driver swaps to SWEBENCH_DIRECTIVE_NOEXEC
 * (no "run the tests" mandate), drops verifyGuard, forces single-pass, and skips
 * the host-python repro-test hint. This removes a self-defeating forcing function
 * on instances whose host test-env is incompatible (e.g. pytest-7982), where the
 * agent obeys a MANDATORY "run the tests" directive it cannot satisfy, flails,
 * and aborts → empty_patch.
 *
 * APPLY IS A NOOP — like the other bench knobs the EFFECT is delivered out of
 * band by the driver (`benchPostureFromState` projection → `opt.inLoopExec`).
 * This registry entry exists ONLY so the bench resolver / report / preset layer
 * can SEE the knob.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]
const DISABLING = new Set(["0", "off", "false"])

/**
 * Returns `false` ONLY for an explicit off token; any other (including unset)
 * resolves `undefined` so the posture default (ON) holds. Default-ON inverts the
 * usual default-OFF bench knob: the absence of the knob preserves today's
 * exact behavior, and the operator must opt OUT.
 */
const parseBenchInLoopExec = (raw: string | undefined): false | undefined => {
  if (raw === undefined) return undefined
  return DISABLING.has(raw.trim().toLowerCase()) ? false : undefined
}

const applyBenchInLoopExec = (cfg: AgentConfig): AgentConfig => cfg

export const benchInLoopExecKnob: Knob<false> = {
  id: "bench-in-loop-exec",
  envKey: "QUANTA_BENCH_IN_LOOP_EXEC",
  category: "verify",
  surfaces: SURFACES,
  parse: parseBenchInLoopExec,
  apply: applyBenchInLoopExec,
  describe:
    "Bench: in-loop test execution (default-ON). OFF ⇒ mini-swe posture (edit-and-submit; grader runs tests, no run-the-tests directive, no verifyGuard, single-pass, no repro hint).",
  source: "mini-swe posture absorption (pytest-7982 incompatible-host-env flail)",
}

registerKnob(benchInLoopExecKnob)
