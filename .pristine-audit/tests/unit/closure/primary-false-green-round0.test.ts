import { describe, expect, test } from "bun:test"
import type { PrimaryRailStep } from "@/agent/closure"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * FIX 1 — `primaryFalseGreen` must be SEEDED from round 0 (symmetric to
 * `primaryFalseRed`) AND accumulate STICKY across rounds.
 *
 * Bug: `falseRed` was seeded from `v0` and sticky; `falseGreen` was initialized
 * `false` and last-write-wins inside the loop. So a round-0 false-green that the
 * finish gate WITHHELD from clearing (primary rail set ⇒ `v0Cleared` false ⇒ the
 * loop runs) was never recorded when no later round was exit-code-green.
 */
const railStep: PrimaryRailStep = {
  kind: "repro",
  cmd: 'python "repro.py"',
  authority: "execution",
  successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
}

const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
  patch: "diff --git a/x b/x\n",
  turns: 1,
  lastVerifyCmd: "pytest",
})

const scriptedValidator = (results: readonly ValidatorResult[]) => {
  let i = 0
  return async (_a: ValidateArgs): Promise<ValidatorResult> => {
    const r = results[Math.min(i, results.length - 1)] as ValidatorResult
    i++
    return r
  }
}

const base = {
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce,
  primaryRailStep: railStep,
}

describe("FIX 1 — primaryFalseGreen seeded from round 0", () => {
  test("🔴 round-0 false-green (rail set ⇒ withheld) + later round red ⇒ primaryFalseGreen:true", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: scriptedValidator([
        // round 0: exit-code green BUT predicate mismatch ⇒ false-green. With the
        // primary rail set the finish gate WITHHOLDS clearing, so the loop runs.
        { ok: true, predicate: { evaluable: true, matched: false } },
        // round 1: genuinely red ⇒ never sets falseGreen inside the loop.
        { ok: false, failTail: "still broken" },
      ]),
    })
    // The finish gate correctly withheld the spurious exit-code green.
    expect(out.validated).toBe(false)
    // …but the false green that happened in round 0 MUST be recorded.
    expect(out.primaryFalseGreen).toBe(true)
  })

  test("STICKY: an EARLIER false-green is not erased by a LATER honest green", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 2 },
      validate: scriptedValidator([
        // round 0: false-green, withheld ⇒ loop continues.
        { ok: true, predicate: { evaluable: true, matched: false } },
        // round 1: honest green (predicate matches) ⇒ clears + breaks.
        { ok: true, predicate: { evaluable: true, matched: true } },
      ]),
    })
    expect(out.validated).toBe(true)
    // Last-write-wins would set this back to false; sticky keeps the round-0 signal.
    expect(out.primaryFalseGreen).toBe(true)
  })
})
