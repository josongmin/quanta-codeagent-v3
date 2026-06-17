import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * T-3 OBSERVE-ONLY — `primaryFalseGreen`: the round that CLEARED the loop (ok by
 * exit code) had a typed rail predicate that was evaluable AND mismatched. This
 * is the signal that quantifies how often a predicate-aware gate (T-4) WOULD have
 * caught a false green — measured WITHOUT changing `validated` (observe-first).
 *
 * Fail-open: an unevaluable/absent predicate is NOT a false green.
 */
const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
  patch: "diff --git a/x b/x\n",
  turns: 1,
  lastVerifyCmd: "pytest",
})

const validatorReturning = (result: ValidatorResult) => async (_a: ValidateArgs) => result

const base = {
  config: { maxRounds: 0 }, // round 0 only — it clears (ok:true)
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce,
}

describe("runRepairRounds — primaryFalseGreen (observe-only)", () => {
  test("🔴 cleared on exit code BUT predicate evaluable+mismatch ⇒ primaryFalseGreen:true", async () => {
    const out = await runRepairRounds({
      ...base,
      validate: validatorReturning({ ok: true, predicate: { evaluable: true, matched: false } }),
    })
    // validated still true (observe-first — predicate does NOT flip the gate).
    expect(out.validated).toBe(true)
    // …but the false green is RECORDED.
    expect(out.primaryFalseGreen).toBe(true)
  })

  test("cleared + predicate matched ⇒ NOT a false green", async () => {
    const out = await runRepairRounds({
      ...base,
      validate: validatorReturning({ ok: true, predicate: { evaluable: true, matched: true } }),
    })
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("fail-open: cleared + predicate UNEVALUABLE ⇒ NOT a false green", async () => {
    const out = await runRepairRounds({
      ...base,
      validate: validatorReturning({ ok: true, predicate: { evaluable: false, matched: false } }),
    })
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("cleared + NO predicate ⇒ NOT a false green", async () => {
    const out = await runRepairRounds({ ...base, validate: validatorReturning({ ok: true }) })
    expect(out.primaryFalseGreen).toBe(false)
  })

  test("never cleared (exhausted) ⇒ NOT a false green", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning({ ok: false, failTail: "x" }),
    })
    expect(out.validated).toBe(false)
    expect(out.primaryFalseGreen).toBe(false)
  })
})
