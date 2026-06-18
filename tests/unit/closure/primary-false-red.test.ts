import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * jun-18 RCA OBSERVE-ONLY — `primaryFalseRed`: a round did NOT clear (`ok:false`,
 * exit-code ≠ 0 on the rail) YET the repro's OWN sentinel says the bug is fixed
 * (`classifyStdout(stdout) === "resolved"`). This is the false-RED the
 * measurement is meant to quantify: the exit-code gate rejecting a patch the
 * repro reports as resolved, which forces wasteful repair churn. Recorded,
 * never flips `validated` (no blind loop change — the fix is gated on THIS rate).
 */
const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
  patch: "diff --git a/x b/x\n",
  turns: 1,
  lastVerifyCmd: "pytest",
})

const validatorReturning = (result: ValidatorResult) => async (_a: ValidateArgs) => result

const base = {
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
  runOnce,
}

/** A failing validator (ok:false) whose OBSERVED repro stdout carries a marker. */
const failWithStdout = (stdout: string): ValidatorResult => ({
  ok: false,
  failTail: stdout,
  observed: { exitCode: 1, stdout, stderr: "" },
})

describe("runRepairRounds — primaryFalseRed (RCA observe-only)", () => {
  test("🔴 not cleared (exit≠0) BUT repro stdout says 'Issue resolved' ⇒ primaryFalseRed:true", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning(failWithStdout("running...\nIssue resolved\n")),
    })
    // The loop never clears (exit-code gate) — the wasteful churn the RCA found.
    expect(out.validated).toBe(false)
    // …but the false-RED (repro itself reports resolved) is RECORDED.
    expect(out.primaryFalseRed).toBe(true)
  })

  test("paired control: not cleared AND repro says 'Issue reproduced' ⇒ NOT a false red (repro agrees)", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning(failWithStdout("running...\nIssue reproduced\n")),
    })
    expect(out.validated).toBe(false)
    expect(out.primaryFalseRed).toBe(false)
  })

  test("cleared (ok:true) ⇒ never a false red (the gate agreed)", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 0 },
      validate: validatorReturning({ ok: true, observed: { exitCode: 0, stdout: "Issue resolved", stderr: "" } }),
    })
    expect(out.primaryFalseRed).toBe(false)
  })

  test("not cleared + NO observed (no rail/observation) ⇒ NOT a false red (no signal)", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning({ ok: false, failTail: "x" }),
    })
    expect(out.primaryFalseRed).toBe(false)
  })

  test("round-0 false-RED is captured even with no repair budget (maxRounds 0)", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 0 },
      validate: validatorReturning(failWithStdout("Issue resolved\n")),
    })
    expect(out.primaryFalseRed).toBe(true)
  })
})
