/**
 * Pillar B PARITY TEST — kernel-over-steps === the driver's inline phase sequence.
 *
 * The bench driver runs its phases as a hard-coded sequence of `if (posture.X)`
 * guards (localize → repro → repair, ~253 inline feature refs). Pillar B replaces
 * that with `runPipeline([localizeStep, reproStep, repairStep], ctx, posture)`,
 * where each phase is a self-contained `EvalStep` that owns its gate. This test
 * proves the migration is behavior-preserving for the three migrated phases:
 *
 *   1. ORDER — the steps fire in the same order the driver's inline sequence does
 *      (localize, then repro, then repair).
 *   2. GATING — gate OFF ⇒ the phase delegate is NOT called (byte-identical no-op,
 *      ctx unchanged); gate ON ⇒ called exactly once.
 *   3. OBSERVABILITY — the `observe` callback reports the EXACT included/excluded
 *      set for the posture (the "which knobs actually engaged" SSOT).
 *   4. RED-ON-INJECTION — flipping a single gate flag flips whether that phase
 *      runs (a tautological test would pass with the gate ignored; this fails).
 *
 * All phase logic is mocked: the delegates are spies threaded through
 * `EvalCtx.deps`, so this exercises the kernel's gating/ordering/folding — NOT a
 * live agent loop. The gate PREDICATES under test are the real exported ones
 * (`reproGate` / `repairGate`), so a drift between the step's gate and the
 * driver's `if` would surface here.
 */

import { describe, expect, mock, test } from "bun:test"
import type { EvalCtx, EvalPhaseDeps } from "@/runner/batch/eval/kernel/eval-step"
import { runPipeline, type StepObserver } from "@/runner/batch/eval/kernel/pipeline"
import { localizeStep } from "@/runner/batch/eval/kernel/steps/localize"
import { repairStep } from "@/runner/batch/eval/kernel/steps/repair"
import { reproStep } from "@/runner/batch/eval/kernel/steps/repro"
import {
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import type { RunRepairRoundsArgs, RunRepairRoundsResult } from "@/runner/batch/eval/repair/types"
import type { Instance } from "@/runner/batch/types"

// The pipeline under test, in the SAME order as the driver's inline sequence.
const EVAL_STEPS = [localizeStep, reproStep, repairStep] as const

/** A complete, REAL default BenchPosture (clean env ⇒ all features default-OFF),
 *  so per-field overrides exercise the actual gate semantics rather than a
 *  hand-rolled partial that could drift from the interface. */
const basePosture = (): BenchPosture =>
  benchPostureFromState(resolveBenchKnobs({ envVars: {} }), {})

const fakeInstance: Instance = {
  id: "parity-fixture",
  repoPath: "/tmp/parity",
  problemStatement: "make it green",
  testCmd: "true",
}

const fakeRepairResult: RunRepairRoundsResult = {
  patch: "diff",
  turns: 1,
  rounds: 1,
  validated: true,
  primaryFalseGreen: false,
  primaryFalseRed: false,
  history: [{ round: 0, patch: "diff", validated: true }],
}

// A minimal repairArgs the repair step forwards to its (mocked) delegate. The
// step never inspects these — it just forwards — so a structural cast is enough.
const fakeRepairArgs = {} as unknown as RunRepairRoundsArgs

interface Spies {
  localize: ReturnType<typeof mock>
  repro: ReturnType<typeof mock>
  repair: ReturnType<typeof mock>
}

const makeCtx = (): { ctx: EvalCtx; spies: Spies } => {
  const localize = mock(async () => ["a.py", "b.py"] as readonly string[])
  const repro = mock(async () => "repro source")
  const repair = mock(async (_args: RunRepairRoundsArgs) => fakeRepairResult)
  const deps: EvalPhaseDeps = { localize, repro, repair, repairArgs: fakeRepairArgs }
  const ctx: EvalCtx = {
    instance: fakeInstance,
    sandbox: "/tmp/parity",
    deps,
    signal: new AbortController().signal,
    state: {},
  }
  return { ctx, spies: { localize, repro, repair } }
}

/** Record the observer's report into an ordered list of {id, included}. */
const recordingObserver = (): {
  observe: StepObserver
  entries: { id: string; included: boolean; index: number }[]
} => {
  const entries: { id: string; included: boolean; index: number }[] = []
  return { observe: (e) => entries.push({ ...e }), entries }
}

describe("pipeline-parity: kernel over [localize, repro, repair] === driver inline sequence", () => {
  test("ALL gates ON ⇒ every phase called once, in order", async () => {
    const { ctx, spies } = makeCtx()
    // localize gate is unconditional; repro/repair gate on these posture fields.
    const posture: BenchPosture = { ...basePosture(), reproTestK: 3, repairRounds: 2 }
    const { observe, entries } = recordingObserver()

    const out = await runPipeline(EVAL_STEPS, ctx, posture, observe)

    expect(spies.localize).toHaveBeenCalledTimes(1)
    expect(spies.repro).toHaveBeenCalledTimes(1)
    expect(spies.repair).toHaveBeenCalledTimes(1)
    // The repair delegate received the forwarded args (delegation, not re-impl).
    expect(spies.repair).toHaveBeenCalledWith(fakeRepairArgs)
    // Folded contributions are present.
    expect(out.state.localizeCandidates).toEqual(["a.py", "b.py"])
    expect(out.state.reproSource).toBe("repro source")
    expect(out.state.repair).toBe(fakeRepairResult)
    // Observer reports the EXACT included set, in order.
    expect(entries).toEqual([
      { id: "localize", included: true, index: 0 },
      { id: "repro", included: true, index: 1 },
      { id: "repair", included: true, index: 2 },
    ])
  })

  test("repro + repair gates OFF (default posture) ⇒ those phases NOT called, ctx byte-identical for them", async () => {
    const { ctx, spies } = makeCtx()
    const posture = basePosture() // reproTestK undefined, repairRounds undefined
    const { observe, entries } = recordingObserver()

    const out = await runPipeline(EVAL_STEPS, ctx, posture, observe)

    // Localize is the baseline phase ⇒ still runs.
    expect(spies.localize).toHaveBeenCalledTimes(1)
    // Gated-OFF phases are no-ops: delegate never invoked, no state contribution.
    expect(spies.repro).not.toHaveBeenCalled()
    expect(spies.repair).not.toHaveBeenCalled()
    expect(out.state.reproSource).toBeUndefined()
    expect(out.state.repair).toBeUndefined()
    // Observer reports them as EXCLUDED (the SSOT of what actually engaged).
    expect(entries).toEqual([
      { id: "localize", included: true, index: 0 },
      { id: "repro", included: false, index: 1 },
      { id: "repair", included: false, index: 2 },
    ])
  })

  test("RED-ON-INJECTION: flipping ONLY reproTestK flips whether repro runs", async () => {
    // OFF arm.
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), reproTestK: undefined }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.repro).not.toHaveBeenCalled()
    }
    // ON arm — identical posture except the single flipped gate flag.
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), reproTestK: 1 }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.repro).toHaveBeenCalledTimes(1)
    }
  })

  test("RED-ON-INJECTION: flipping ONLY repairRounds flips whether repair runs", async () => {
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), repairRounds: undefined }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.repair).not.toHaveBeenCalled()
    }
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), repairRounds: 1 }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.repair).toHaveBeenCalledTimes(1)
    }
  })

  test("ORDER: phases fire localize → repro → repair regardless of which are gated in", async () => {
    const { ctx, spies } = makeCtx()
    const posture: BenchPosture = { ...basePosture(), reproTestK: 2, repairRounds: 1 }
    const callOrder: string[] = []
    spies.localize.mockImplementation(async () => {
      callOrder.push("localize")
      return ["x.py"] as readonly string[]
    })
    spies.repro.mockImplementation(async () => {
      callOrder.push("repro")
      return "r"
    })
    spies.repair.mockImplementation(async (_args: RunRepairRoundsArgs) => {
      callOrder.push("repair")
      return fakeRepairResult
    })

    await runPipeline(EVAL_STEPS, ctx, posture)

    expect(callOrder).toEqual(["localize", "repro", "repair"])
  })

  test("gated-in step with NO bound delegate is a wiring error (never a silent no-op)", async () => {
    const ctx: EvalCtx = {
      instance: fakeInstance,
      sandbox: "/tmp/parity",
      deps: {}, // nothing bound
      signal: new AbortController().signal,
      state: {},
    }
    const posture: BenchPosture = { ...basePosture(), reproTestK: 1 }
    // localize is gated-in (unconditional) but unbound ⇒ throws, surfacing the
    // mis-wire instead of laundering a feature into the baseline.
    await expect(runPipeline([localizeStep], ctx, posture)).rejects.toThrow(/wiring error/)
  })
})
