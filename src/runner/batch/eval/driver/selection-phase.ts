/**
 * Verify-SELECT phase shared LIBRARY (pure code motion from `driver.ts`,
 * byte-identical). Owns the repro-consensus selection POLICY resolution
 * (`selectionReproPolicy` / `computeEffectiveProofRequired`), the candidate
 * sandbox cleanup (`cleanupSelectionCandidateSandbox`), and the cross-vendor
 * lane routing (`resolveLaneLlm`). The sole per-instance orchestrator that CALLS
 * these helpers is the app driver (`src/apps/bench/eval/driver.ts`); the runner
 * core is now purely the shared library. The shared vocabulary comes from
 * `./context-types`. No cycle back into the driver orchestration root.
 */

import { evictLspWorkspaces } from "@/agent/lsp-bridge"
import type { LLMPort } from "@/llm"
import { gateOn } from "@/shared"
import type { ReproOracleCalibration } from "../../types"
import type { BenchPosture } from "../knobs-bench"
import { cleanupSandbox } from "../sandbox"
import type { RunInstanceDeps } from "./context-types"
import { makeCalibratedReproConsensusPort } from "./selection-port-factories"

export interface SelectionReproPolicy {
  readonly enabled: boolean
  readonly goldCalibrate: boolean
  readonly resolvedKofNMode: "hard" | "soft"
}

/** Live-like no-oracle rule for verify-select repro use:
 *  - `positive` keeps the generated repro signal as SOFT-ONLY and MUST NOT peek
 *    at gold calibration.
 *  - unset / `hard` preserves the legacy eval-only gold-calibrated hard gate.
 *  - `off` removes the selection signal entirely. */
export const selectionReproPolicy = (
  mode: BenchPosture["verifySelectRepro"],
): SelectionReproPolicy => {
  if (mode === "off") {
    return { enabled: false, goldCalibrate: false, resolvedKofNMode: "hard" }
  }
  if (mode === "positive") {
    return { enabled: true, goldCalibrate: false, resolvedKofNMode: "soft" }
  }
  return { enabled: true, goldCalibrate: true, resolvedKofNMode: "hard" }
}

/**
 * P4 PROOF-GATE FAIL-OPEN decision (THE structural fix for Defect 2) — pure +
 * exported for direct mutation-grade testing of the EXACT decision the selection
 * phase makes.
 *
 * A proof-required submit gate built on a CONFIRMED gold false-negative canonical
 * oracle would WITHHOLD the canonical-correct fix forever: the broken oracle can
 * never report a resolved sidecar, so `applyProofRequiredHardGate` rejects every
 * candidate. A proven-broken oracle must NOT hold hard submit authority ⇒ LIFT
 * proofRequired for this instance (mirror of the soft-port fail-open in
 * {@link makeCalibratedReproConsensusPort}). When the oracle is trustworthy
 * (not gold-FN) OR proof was never required, the gate is unchanged.
 *
 * `proofCalibration.falseNegative` is gold-derived telemetry (EVAL-ONLY) — it
 * flips a HARNESS submit gate only; it never reaches the agent or any prompt.
 */
export const computeEffectiveProofRequired = (
  verifySelectProofRequired: boolean,
  proofCalibration: ReproOracleCalibration,
): { effectiveProofRequired: boolean; proofGateFailOpen: boolean } => {
  // A proven-broken canonical oracle must NOT hold hard submit authority. Two
  // gold-calibrated failure modes both fail the gate OPEN (lift proofRequired):
  //   - `falseNegative` (P4): the oracle stays RED on the canonical-correct GOLD
  //     fix ⇒ it would withhold every correct candidate (too strict).
  //   - `vacuous` (P3): the oracle reports GREEN on the un-patched BASE tree ⇒ its
  //     "green" is meaningless and would false-GREEN a wrong candidate (too loose);
  //     a meaningless proof can't be trusted to gate, so don't require it.
  const proofGateFailOpen =
    verifySelectProofRequired &&
    (proofCalibration.falseNegative || (proofCalibration.vacuous ?? false))
  return {
    effectiveProofRequired: verifySelectProofRequired && !proofGateFailOpen,
    proofGateFailOpen,
  }
}

export const familyCoverageCoeditEnabled = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_BENCH_FAMILY_COVERAGE_COEDIT")

/**
 * G1 cross-vendor diversity — resolve the LLM port that should GENERATE
 * verify-select candidate `index`. Pure (no I/O), so the lane→provider routing
 * is unit-testable in isolation.
 *
 * Routing rule: `lanes[index mod lanes.length]` — index-modulo only, NO issue /
 * gold / answer-key inspection. Diversity comes from the structural fan-out, not
 * from peeking at the task. The mapping is the SAME stable round-robin every run.
 *
 * Returns `deps.llm` UNCHANGED (the single-vendor path) whenever:
 *   - the `model-lane-diversity` posture is OFF, OR
 *   - `deps.llmLanes` is absent / has fewer than 2 distinct lanes
 * so an unconfigured environment is byte-identical to the pre-feature driver.
 */
export const resolveLaneLlm = (
  deps: Pick<RunInstanceDeps, "llm" | "llmLanes">,
  modelLaneDiversity: boolean,
  index: number,
): LLMPort => {
  if (!modelLaneDiversity) return deps.llm
  const lanes = deps.llmLanes
  if (lanes === undefined || lanes.length < 2) return deps.llm
  const lane = lanes[((index % lanes.length) + lanes.length) % lanes.length]
  return lane ?? deps.llm
}

export const cleanupSelectionCandidateSandbox = async (
  sandbox: string,
  deps: {
    readonly evictLspWorkspaces?: (cwd: string) => Promise<void>
    readonly cleanupSandbox?: (sandbox: string) => Promise<void>
  } = {},
): Promise<void> => {
  const evict = deps.evictLspWorkspaces ?? evictLspWorkspaces
  const cleanup = deps.cleanupSandbox ?? cleanupSandbox
  await evict(sandbox).catch(() => undefined)
  await cleanup(sandbox)
}
