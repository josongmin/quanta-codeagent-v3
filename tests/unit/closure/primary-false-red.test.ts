import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"
import { validate as realValidate } from "@/runner/batch/eval/repair/validator"

/**
 * jun-18 RCA OBSERVE-ONLY — `primaryFalseRed`: a round did NOT clear
 * (`ok:false`) YET the validator's explicit repro outcome says the bug is fixed
 * (`reproOutcome === "resolved"`). Legacy stdout markers are not an authority or
 * telemetry fallback. Recorded, never flips `validated`.
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

const failWithStdout = (
  stdout: string,
  reproOutcome?: ValidatorResult["reproOutcome"],
): ValidatorResult => ({
  ok: false,
  failTail: stdout,
  observed: { exitCode: 1, stdout, stderr: "" },
  ...(reproOutcome !== undefined ? { reproOutcome } : {}),
})

describe("runRepairRounds — primaryFalseRed (RCA observe-only)", () => {
  test("not cleared + legacy stdout marker only ⇒ primaryFalseRed:false", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning(failWithStdout("running...\nIssue resolved\n")),
    })
    expect(out.validated).toBe(false)
    expect(out.primaryFalseRed).toBe(false)
  })

  test("not cleared + explicit validator outcome resolved ⇒ primaryFalseRed:true", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning(failWithStdout("running...\nIssue resolved\n", "resolved")),
    })
    expect(out.validated).toBe(false)
    expect(out.primaryFalseRed).toBe(true)
  })

  test("paired control: not cleared + explicit outcome reproduced ⇒ NOT a false red", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 1 },
      validate: validatorReturning(failWithStdout("running...\nIssue reproduced\n", "reproduced")),
    })
    expect(out.validated).toBe(false)
    expect(out.primaryFalseRed).toBe(false)
  })

  test("cleared (ok:true) ⇒ never a false red (the gate agreed)", async () => {
    const out = await runRepairRounds({
      ...base,
      config: { maxRounds: 0 },
      validate: validatorReturning({
        ok: true,
        observed: { exitCode: 0, stdout: "Issue resolved", stderr: "" },
      }),
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
      validate: validatorReturning(failWithStdout("Issue resolved\n", "resolved")),
    })
    expect(out.primaryFalseRed).toBe(true)
  })
})

/**
 * END-TO-END: the REAL validator (not a mock) through runRepairRounds. Repro
 * authority is the structured pytest sidecar; a printed legacy marker alone is
 * not enough to clear a proof rail.
 */
describe("runRepairRounds — REAL validator sidecar gating", () => {
  const railBase = {
    config: { maxRounds: 3 },
    problem: "fix it",
    buildContext: () => "seed",
    sandbox: "/tmp/sb",
    timeoutMs: 1000,
    validate: realValidate,
    // The rail makes the validator run `args.primaryRailStep.cmd` (the repro) and
    // attach the sentinel predicate — exactly the production wiring.
    primaryRailStep: {
      kind: "repro",
      cmd: 'python "reproduce_issue.py"',
      authority: "execution" as const,
      successPredicate: { type: "stdout_contains" as const, substring: "Issue resolved" },
    },
    runOnce: async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff --git a/x b/x\n",
      turns: 1,
    }),
  }

  test("repro prints 'Issue resolved' but has no sidecar ⇒ does NOT clear", async () => {
    let execCalls = 0
    const out = await runRepairRounds({
      ...railBase,
      // exit 1 (a warning-turned-error) but the repro's own marker says resolved.
      exec: async () => {
        execCalls += 1
        return { code: 1, stdout: "DeprecationWarning...\nIssue resolved\n", stderr: "warn" }
      },
    })
    expect(out.validated).toBe(false)
    expect(out.rounds).toBe(4)
    expect(execCalls).toBe(4)
    expect(out.primaryFalseRed).toBe(false)
  })

  test("repro sidecar resolved + predicate output ⇒ clears at round 0", async () => {
    let execCalls = 0
    const out = await runRepairRounds({
      ...railBase,
      readFile: async () =>
        JSON.stringify({
          schema: 1,
          collected: 1,
          exitstatus: 0,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
        }),
      primaryRailStep: {
        ...railBase.primaryRailStep,
        pytestReportPath: "/tmp/sb/reproduce_issue.py.pytest-report.json",
      },
      exec: async () => {
        execCalls += 1
        return { code: 1, stdout: "Issue resolved\n", stderr: "warn" }
      },
    })
    expect(out.validated).toBe(true)
    expect(out.rounds).toBe(1)
    expect(execCalls).toBe(1)
  })

  test("repro prints 'Issue reproduced' (still broken) ⇒ does NOT clear, churns to maxRounds", async () => {
    const out = await runRepairRounds({
      ...railBase,
      exec: async () => ({ code: 0, stdout: "Issue reproduced\n", stderr: "" }),
    })
    expect(out.validated).toBe(false)
    expect(out.rounds).toBe(4) // round 0 + 3 repair rounds, never cleared (correct)
  })
})
