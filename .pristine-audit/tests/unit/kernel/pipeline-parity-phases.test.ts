/**
 * Pillar B PARITY TEST (remaining live phases) — kernel-over-steps === the
 * driver's inline phase sequence for env-prep / main / repair / followup /
 * terminal-validate.
 *
 * Companion to `pipeline-parity.test.ts` (which covers localize/repro/repair).
 * This file proves the SECOND batch of migrated phases are behavior-preserving:
 *
 *   1. ORDER — the full ordered pipeline fires in DRIVER order:
 *      env-prep → main → repair → followup → terminal-validate.
 *   2. GATING — always-on phases (env-prep / main / terminal) run for every
 *      posture; gated phases (repair / followup) run iff their posture flag is
 *      set; gate OFF ⇒ delegate NOT called (byte-identical no-op, ctx unchanged).
 *   3. OBSERVABILITY — the `observe` callback reports the EXACT included/excluded
 *      set for the posture.
 *   4. RED-ON-INJECTION — flipping a single gate flag (`repairRounds`,
 *      `repairEscalation`) flips whether that phase runs.
 *   5. WIRING ERROR — a gated-in step with no bound delegate throws (never a
 *      silent no-op of an enabled feature).
 *
 * All phase logic is mocked: delegates are spies threaded through `EvalCtx.deps`,
 * so this exercises the kernel's gating/ordering/folding — NOT a live agent loop.
 * The gate PREDICATES under test are the real exported ones (`repairGate` /
 * `followupGate`), so a drift between the step's gate and the driver's `if` would
 * surface here. Modeled on `pipeline-parity.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test"
import type { EnvPrepResult } from "@/runner/batch/eval/env-prep"
import type { EvalCtx, EvalPhaseDeps, FollowupOutcome } from "@/runner/batch/eval/kernel/eval-step"
import { runPipeline, type StepObserver } from "@/runner/batch/eval/kernel/pipeline"
import { envPrepStep } from "@/runner/batch/eval/kernel/steps/env-prep"
import { followupStep } from "@/runner/batch/eval/kernel/steps/followup"
import { mainPhaseStep } from "@/runner/batch/eval/kernel/steps/main-phase"
import { repairStep } from "@/runner/batch/eval/kernel/steps/repair"
import { terminalValidateStep } from "@/runner/batch/eval/kernel/steps/terminal-validate"
import {
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import type { RunRepairRoundsArgs, RunRepairRoundsResult } from "@/runner/batch/eval/repair/types"
import type { Instance } from "@/runner/batch/types"

// The pipeline under test, in the SAME order as the driver's inline sequence:
// env-prep BEFORE the agent, main agent run, then repair / owner-widening
// followup, then terminal-result validation last.
const EVAL_STEPS = [
  envPrepStep,
  mainPhaseStep,
  repairStep,
  followupStep,
  terminalValidateStep,
] as const

/** A complete, REAL default BenchPosture (clean env ⇒ all features default-OFF). */
const basePosture = (): BenchPosture =>
  benchPostureFromState(resolveBenchKnobs({ envVars: {} }), {})

const fakeInstance: Instance = {
  id: "parity-phases-fixture",
  repoPath: "/tmp/parity-phases",
  problemStatement: "make it green",
  testCmd: "true",
}

const fakeEnvPrepResult: EnvPrepResult = { ok: true }
const fakeMainPhase = { kind: "phase-fixture" } as const
const fakeTerminalResult = { passed: true } as const
const fakeFollowup: FollowupOutcome = { reran: true, payload: { widened: ["c.py"] } }

const fakeRepairResult: RunRepairRoundsResult = {
  patch: "diff",
  turns: 1,
  rounds: 1,
  validated: true,
  primaryFalseGreen: false,
  primaryFalseRed: false,
  history: [{ round: 0, patch: "diff", validated: true }],
}
const fakeRepairArgs = {} as unknown as RunRepairRoundsArgs

interface Spies {
  envPrep: ReturnType<typeof mock>
  mainPhase: ReturnType<typeof mock>
  repair: ReturnType<typeof mock>
  followup: ReturnType<typeof mock>
  terminalValidate: ReturnType<typeof mock>
}

const makeCtx = (): { ctx: EvalCtx; spies: Spies } => {
  const envPrep = mock(async (_i: Instance, _s: string, _t: number) => fakeEnvPrepResult)
  const mainPhase = mock(async () => fakeMainPhase as unknown)
  const repair = mock(async (_args: RunRepairRoundsArgs) => fakeRepairResult)
  const followup = mock(async () => fakeFollowup)
  const terminalValidate = mock(async () => fakeTerminalResult as unknown)
  const deps: EvalPhaseDeps = {
    envPrep,
    mainPhase,
    repair,
    repairArgs: fakeRepairArgs,
    followup,
    terminalValidate,
  }
  const ctx: EvalCtx = {
    instance: fakeInstance,
    sandbox: "/tmp/parity-phases",
    deps,
    signal: new AbortController().signal,
    timeoutMs: 5000,
    state: {},
  }
  return { ctx, spies: { envPrep, mainPhase, repair, followup, terminalValidate } }
}

const recordingObserver = (): {
  observe: StepObserver
  entries: { id: string; included: boolean; index: number }[]
} => {
  const entries: { id: string; included: boolean; index: number }[] = []
  return { observe: (e) => entries.push({ ...e }), entries }
}

describe("pipeline-parity-phases: kernel over [env-prep, main, repair, followup, terminal] === driver inline sequence", () => {
  test("ALL gates ON ⇒ every phase called once, in driver order, contributions folded", async () => {
    const { ctx, spies } = makeCtx()
    const posture: BenchPosture = {
      ...basePosture(),
      repairRounds: 2,
      repairEscalation: true,
    }
    const { observe, entries } = recordingObserver()

    const out = await runPipeline(EVAL_STEPS, ctx, posture, observe)

    expect(spies.envPrep).toHaveBeenCalledTimes(1)
    // env-prep forwards (instance, sandbox, timeoutMs) — delegation, not re-impl.
    expect(spies.envPrep).toHaveBeenCalledWith(fakeInstance, "/tmp/parity-phases", 5000)
    expect(spies.mainPhase).toHaveBeenCalledTimes(1)
    expect(spies.repair).toHaveBeenCalledTimes(1)
    expect(spies.repair).toHaveBeenCalledWith(fakeRepairArgs)
    expect(spies.followup).toHaveBeenCalledTimes(1)
    expect(spies.terminalValidate).toHaveBeenCalledTimes(1)

    // Folded contributions.
    expect(out.state.envPrep).toBe(fakeEnvPrepResult)
    expect(out.state.mainPhase).toBe(fakeMainPhase)
    expect(out.state.repair).toBe(fakeRepairResult)
    expect(out.state.followup).toBe(fakeFollowup)
    expect(out.state.terminalResult).toBe(fakeTerminalResult)

    // Observer reports the EXACT included set, in order.
    expect(entries).toEqual([
      { id: "env-prep", included: true, index: 0 },
      { id: "main", included: true, index: 1 },
      { id: "repair", included: true, index: 2 },
      { id: "followup", included: true, index: 3 },
      { id: "terminal-validate", included: true, index: 4 },
    ])
  })

  test("default posture ⇒ gated phases (repair, followup) NOT called; always-on phases run", async () => {
    const { ctx, spies } = makeCtx()
    const posture = basePosture() // repairRounds undefined, repairEscalation false
    const { observe, entries } = recordingObserver()

    const out = await runPipeline(EVAL_STEPS, ctx, posture, observe)

    // Always-on phases still run.
    expect(spies.envPrep).toHaveBeenCalledTimes(1)
    expect(spies.mainPhase).toHaveBeenCalledTimes(1)
    expect(spies.terminalValidate).toHaveBeenCalledTimes(1)
    // Gated-OFF phases are no-ops: delegate never invoked, no state contribution.
    expect(spies.repair).not.toHaveBeenCalled()
    expect(spies.followup).not.toHaveBeenCalled()
    expect(out.state.repair).toBeUndefined()
    expect(out.state.followup).toBeUndefined()

    expect(entries).toEqual([
      { id: "env-prep", included: true, index: 0 },
      { id: "main", included: true, index: 1 },
      { id: "repair", included: false, index: 2 },
      { id: "followup", included: false, index: 3 },
      { id: "terminal-validate", included: true, index: 4 },
    ])
  })

  test("ORDER: phases fire env-prep → main → repair → followup → terminal regardless of which are gated in", async () => {
    const { ctx, spies } = makeCtx()
    const posture: BenchPosture = {
      ...basePosture(),
      repairRounds: 1,
      repairEscalation: true,
    }
    const callOrder: string[] = []
    spies.envPrep.mockImplementation(async () => {
      callOrder.push("env-prep")
      return fakeEnvPrepResult
    })
    spies.mainPhase.mockImplementation(async () => {
      callOrder.push("main")
      return fakeMainPhase as unknown
    })
    spies.repair.mockImplementation(async (_a: RunRepairRoundsArgs) => {
      callOrder.push("repair")
      return fakeRepairResult
    })
    spies.followup.mockImplementation(async () => {
      callOrder.push("followup")
      return fakeFollowup
    })
    spies.terminalValidate.mockImplementation(async () => {
      callOrder.push("terminal")
      return fakeTerminalResult as unknown
    })

    await runPipeline(EVAL_STEPS, ctx, posture)

    expect(callOrder).toEqual(["env-prep", "main", "repair", "followup", "terminal"])
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

  test("RED-ON-INJECTION: flipping ONLY repairEscalation flips whether followup runs", async () => {
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), repairEscalation: false }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.followup).not.toHaveBeenCalled()
    }
    {
      const { ctx, spies } = makeCtx()
      const posture = { ...basePosture(), repairEscalation: true }
      await runPipeline(EVAL_STEPS, ctx, posture)
      expect(spies.followup).toHaveBeenCalledTimes(1)
    }
  })

  test("followup delegate decides NOT to widen (reran:false) ⇒ ctx unchanged (inner no-op honored)", async () => {
    const { ctx, spies } = makeCtx()
    spies.followup.mockImplementation(async () => ({ reran: false }) as FollowupOutcome)
    const posture: BenchPosture = { ...basePosture(), repairEscalation: true }

    const out = await runPipeline([followupStep], ctx, posture)

    expect(spies.followup).toHaveBeenCalledTimes(1) // gate admitted it
    expect(out.state.followup).toBeUndefined() // but no contribution folded
    expect(out).toBe(ctx) // byte-identical ctx
  })

  test("terminal-validate yields undefined (no terminal result) ⇒ ctx unchanged", async () => {
    const { ctx, spies } = makeCtx()
    spies.terminalValidate.mockImplementation(async () => undefined)
    const posture = basePosture()

    const out = await runPipeline([terminalValidateStep], ctx, posture)

    expect(spies.terminalValidate).toHaveBeenCalledTimes(1)
    expect(out.state.terminalResult).toBeUndefined()
    expect(out).toBe(ctx)
  })

  test("env-prep uses the REAL delegate by default (unbound) — no wiring-error throw", async () => {
    // env-prep defaults to the real `runEnvPrep`; an instance with no setupCmd
    // is a no-op {ok:true}, so an unbound env-prep step does NOT throw.
    const ctx: EvalCtx = {
      instance: fakeInstance, // no setupCmd
      sandbox: "/tmp/parity-phases",
      deps: {}, // envPrep unbound ⇒ falls back to real runEnvPrep
      signal: new AbortController().signal,
      state: {},
    }
    const out = await runPipeline([envPrepStep], ctx, basePosture())
    expect(out.state.envPrep).toEqual({ ok: true })
  })

  test("WIRING ERROR: a gated-in always-on step with no bound delegate throws (main / terminal)", async () => {
    const ctx: EvalCtx = {
      instance: fakeInstance,
      sandbox: "/tmp/parity-phases",
      deps: {}, // nothing bound
      signal: new AbortController().signal,
      state: {},
    }
    const posture = basePosture()
    await expect(runPipeline([mainPhaseStep], ctx, posture)).rejects.toThrow(/wiring error/)
    await expect(runPipeline([terminalValidateStep], ctx, posture)).rejects.toThrow(/wiring error/)
  })

  test("WIRING ERROR: gated-IN followup (escalation ON) with no bound delegate throws", async () => {
    const ctx: EvalCtx = {
      instance: fakeInstance,
      sandbox: "/tmp/parity-phases",
      deps: {},
      signal: new AbortController().signal,
      state: {},
    }
    const posture: BenchPosture = { ...basePosture(), repairEscalation: true }
    await expect(runPipeline([followupStep], ctx, posture)).rejects.toThrow(/wiring error/)
    // And the SAME unbound followup, gated OFF, is a silent no-op (NOT a throw).
    const offCtx: EvalCtx = { ...ctx }
    const out = await runPipeline([followupStep], offCtx, {
      ...basePosture(),
      repairEscalation: false,
    })
    expect(out).toBe(offCtx)
  })

  test("OBSERVABILITY: included set reflects exactly the gated-in phases for a mixed posture", async () => {
    const { ctx } = makeCtx()
    // repair OFF, followup ON.
    const posture: BenchPosture = {
      ...basePosture(),
      repairRounds: undefined,
      repairEscalation: true,
    }
    const { observe, entries } = recordingObserver()

    await runPipeline(EVAL_STEPS, ctx, posture, observe)

    expect(entries.map((e) => ({ id: e.id, included: e.included }))).toEqual([
      { id: "env-prep", included: true },
      { id: "main", included: true },
      { id: "repair", included: false },
      { id: "followup", included: true },
      { id: "terminal-validate", included: true },
    ])
  })
})
