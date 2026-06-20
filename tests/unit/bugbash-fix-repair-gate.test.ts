import { describe, expect, test } from "bun:test"
import type { PrimaryRailStep } from "@/agent/closure"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * jun-20 bugbash #1 — WIRE the false-green finish gate into the repair loop.
 *
 * decidePrimaryRailFinishGate was dead code: a NON-primary / false-green
 * validation (exit-code green but typed rail predicate evaluable AND
 * matched===false) still cleared the loop as `validated`. With the primary-rail
 * knob ON (a primaryRailStep is present), such a round must NOT clear — the
 * spurious exit-code green does not substitute for the rail's own proof. With
 * the knob OFF (no primaryRailStep) behavior is byte-identical to before.
 *
 * Teeth (red-on-injection): revert the `clearedAsValidated` wiring (clear on
 * `v.ok` again) and the FG-1 case flips to validated:true.
 */
const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
  patch: "diff --git a/x b/x\n",
  turns: 1,
  lastVerifyCmd: "pytest",
})

const validatorReturning = (result: ValidatorResult) => async (_a: ValidateArgs) => result

const railStep = (cmd: string): PrimaryRailStep =>
  ({
    kind: "owner-test",
    cmd,
    authority: "execution",
    successPredicate: { type: "test_exit_zero" },
  }) as const

const base = {
  config: { maxRounds: 0 }, // round 0 only — it clears (ok:true) by exit code
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce,
}

describe("bugbash #1 — primary-rail finish gate wired into repair loop", () => {
  test("FG-1: knob ON + false-green round ⇒ NOT validated (gate blocks the spurious green)", async () => {
    const out = await runRepairRounds({
      ...base,
      primaryRailStep: railStep("rail-cmd"),
      validate: validatorReturning({ ok: true, predicate: { evaluable: true, matched: false } }),
    })
    // The exit-code green did not match the typed rail predicate ⇒ the finish
    // gate withholds clearing. (Reverting the wiring makes this true — teeth.)
    expect(out.validated).toBe(false)
    // …but the false green is still RECORDED (observe-only diagnostic intact).
    expect(out.primaryFalseGreen).toBe(true)
  })

  test("FG-2: knob OFF (no primaryRailStep) + same false-green ⇒ byte-identical: still validated", async () => {
    const out = await runRepairRounds({
      ...base,
      validate: validatorReturning({ ok: true, predicate: { evaluable: true, matched: false } }),
    })
    expect(out.validated).toBe(true)
    expect(out.primaryFalseGreen).toBe(true)
  })

  test("FG-3: knob ON + genuine green (predicate matched) ⇒ validated (gate allows)", async () => {
    const out = await runRepairRounds({
      ...base,
      primaryRailStep: railStep("rail-cmd"),
      validate: validatorReturning({ ok: true, predicate: { evaluable: true, matched: true } }),
    })
    expect(out.validated).toBe(true)
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("FG-4: knob ON + fail-open (predicate UNEVALUABLE) ⇒ validated (never penalize on absent proof)", async () => {
    const out = await runRepairRounds({
      ...base,
      primaryRailStep: railStep("rail-cmd"),
      validate: validatorReturning({ ok: true, predicate: { evaluable: false, matched: false } }),
    })
    expect(out.validated).toBe(true)
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("FG-5: knob ON + false-green at round 0 then a CLEAN green at round 1 ⇒ loop continues then validates", async () => {
    // Round 0 is a false green (gate withholds), round ≥1 is a genuine green
    // (gate clears). Proves the gate makes the loop ITERATE instead of stopping
    // on the spurious green — the whole point of closing the false-green hole.
    let call = 0
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
      call += 1
      return call === 1
        ? { ok: true, predicate: { evaluable: true, matched: false } } // round 0: false green
        : { ok: true, predicate: { evaluable: true, matched: true } } // round 1: real green
    }
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      primaryRailStep: railStep("rail-cmd"),
      validate,
    })
    expect(out.rounds).toBe(2) // round 0 did NOT stop the loop
    expect(out.validated).toBe(true) // round 1's genuine green cleared it
    expect(out.primaryFalseGreen).toBe(false) // the LAST cleared round was honest
  })
})
