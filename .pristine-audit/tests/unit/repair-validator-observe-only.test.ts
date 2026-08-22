import { describe, expect, test } from "bun:test"
import { evaluateSuccessPredicate } from "@/agent/closure"
import { pytestReportPathFor } from "@/agent/repro-test/pytest-report"
import type { ExecFn, ValidateArgs } from "@/runner/batch/eval/repair/types"
import { validate } from "@/runner/batch/eval/repair/validator"

/**
 * T-1 — validator predicate integration is OBSERVE-ONLY.
 *
 * The validator records `observed` + the typed `predicate` verdict, but its `ok`
 * decision stays byte-identical to the legacy exit-code rule. Red cases:
 *  - exit 0 + predicate mismatch ⇒ still `ok:true` (no behavior change in v1).
 *  - advisory predicate (evaluable:false) ⇒ never flips `ok`.
 *  - no predicate supplied ⇒ no `predicate` field (byte-identical to pre-T-1).
 */
const fakeExec =
  (code: number, stdout = "", stderr = ""): ExecFn =>
  async () => ({ code, stdout, stderr })

const sidecar = (outcome: "resolved" | "reproduced" | "error"): string => {
  if (outcome === "resolved") {
    return JSON.stringify({
      schema: 1,
      collected: 1,
      exitstatus: 0,
      reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
    })
  }
  if (outcome === "reproduced") {
    return JSON.stringify({
      schema: 1,
      collected: 1,
      exitstatus: 1,
      reports: [
        { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AssertionError" },
      ],
    })
  }
  return JSON.stringify({
    schema: 1,
    collected: 1,
    exitstatus: 1,
    reports: [
      { nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "RuntimeError" },
    ],
  })
}

const base = (over: Partial<ValidateArgs>): ValidateArgs => ({
  sandbox: "/tmp/x",
  cmd: "pytest -q",
  exec: fakeExec(0),
  timeoutMs: 1000,
  evaluatePredicate: evaluateSuccessPredicate,
  ...over,
})

describe("validator — observe-only predicate", () => {
  test("exit 0 + NO predicate ⇒ ok:true, no predicate field (byte-identical)", async () => {
    const r = await validate(base({ exec: fakeExec(0) }))
    expect(r.ok).toBe(true)
    expect(r.predicate).toBeUndefined()
  })

  test("exit 0 + matching EVALUABLE predicate (test_exit_zero) ⇒ ok:true, predicate.matched:true", async () => {
    // Use the execution oracle here: it is the only EVALUABLE predicate in v1, so
    // it exercises the matched:true recording path. (stdout_contains is now
    // advisory — see the prose-stdout test below.)
    const r = await validate(
      base({
        exec: fakeExec(0, "3 PASSED"),
        successPredicate: { type: "test_exit_zero" },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.predicate).toEqual({ evaluable: true, matched: true })
  })

  test("🔴 exit 0 + ADVISORY prose stdout_contains MISMATCH ⇒ STILL ok:true, recorded evaluable:false (no false-RED)", async () => {
    // stdout_contains is issue-PROSE-derived; a mis-extracted value must NOT gain
    // rail authority. So even a stdout that does NOT contain the value records as
    // ADVISORY (evaluable:false), never a hard matched:false.
    const r = await validate(
      base({
        exec: fakeExec(0, "wrong output"),
        successPredicate: { type: "stdout_contains", substring: "expected" },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.predicate?.evaluable).toBe(false) // ← was evaluable:true before the demotion
  })

  test("advisory predicate (latex / stdout_exact_empty) ⇒ recorded evaluable:false, ok follows exit code", async () => {
    const latex = await validate(
      base({
        exec: fakeExec(0),
        successPredicate: { type: "latex_or_string_exact", expected: "\\left(x\\right)" },
      }),
    )
    expect(latex.ok).toBe(true)
    expect(latex.predicate?.evaluable).toBe(false)
    // stdout_exact_empty with NON-empty stdout is also advisory now (prose-derived).
    const empty = await validate(
      base({ exec: fakeExec(0, "noise"), successPredicate: { type: "stdout_exact_empty" } }),
    )
    expect(empty.ok).toBe(true)
    expect(empty.predicate?.evaluable).toBe(false)
  })

  test("exit 1 ⇒ ok:false + failTail + observed recorded", async () => {
    const r = await validate(base({ exec: fakeExec(1, "out", "boom") }))
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("boom")
    expect(r.failureEvidence).toEqual({
      stdoutTail: "out",
      stderrTail: "boom",
      combinedTail: "out\nboom",
    })
    expect(r.observed).toEqual({ exitCode: 1, stdout: "out", stderr: "boom" })
  })

  test("no cmd / no repro ⇒ degenerate fail (byte-identical, no observed)", async () => {
    const r = await validate({ sandbox: "/x", exec: fakeExec(0), timeoutMs: 1000 })
    expect(r).toEqual({ ok: false, failTail: "" })
  })
})

/**
 * P1 — execution-grounded repro validation. A synthesized repro is a real pytest
 * test now, so the patched check must read pytest's pass/fail summary first, not
 * a model-printed sentinel string. Older marker-style repros remain as fallback
 * when no pytest signal exists.
 */
describe("validator — execution-grounded repro gating", () => {
  test("pytest-green repro authority: exit 0 + passed summary ⇒ ok:true", async () => {
    const reproPath = "/tmp/x/reproduce_issue.py"
    const r = await validate({
      sandbox: "/tmp/x",
      reproPath,
      reproCmd: "python3 -s /tmp/x/reproduce_issue.py",
      exec: fakeExec(0, "1 passed in 0.12s"),
      readFile: async (path) => {
        expect(path).toBe(pytestReportPathFor(reproPath))
        return sidecar("resolved")
      },
      timeoutMs: 1000,
      evaluatePredicate: evaluateSuccessPredicate,
    })
    expect(r.ok).toBe(true)
  })

  test("non-repro cmd printing 'Issue resolved' does NOT override exit code", async () => {
    const r = await validate(
      base({ exec: fakeExec(1, "warn...\nIssue resolved\n", "DeprecationWarning") }),
    )
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBeUndefined()
  })

  test("pytest-red repro authority: exit 1 + failed summary ⇒ ok:false", async () => {
    const reproPath = "/tmp/x/reproduce_issue.py"
    const r = await validate({
      sandbox: "/tmp/x",
      reproPath,
      reproCmd: "python3 -s /tmp/x/reproduce_issue.py",
      exec: fakeExec(1, "F\n1 failed in 0.12s"),
      readFile: async () => sidecar("reproduced"),
      timeoutMs: 1000,
      evaluatePredicate: evaluateSuccessPredicate,
    })
    expect(r.ok).toBe(false)
  })

  test("pytest error summary ⇒ ok:false (repro blew up, not resolved)", async () => {
    const r = await validate({
      sandbox: "/tmp/x",
      reproPath: "/tmp/x/reproduce_issue.py",
      reproCmd: "python3 -s /tmp/x/reproduce_issue.py",
      exec: fakeExec(1, "", "1 error in 0.12s"),
      readFile: async () => sidecar("error"),
      timeoutMs: 1000,
      evaluatePredicate: evaluateSuccessPredicate,
    })
    expect(r.ok).toBe(false)
  })

  test("legacy marker without sidecar is fail-closed for repro authority", async () => {
    const r = await validate({
      sandbox: "/tmp/x",
      reproPath: "/tmp/x/reproduce_issue.py",
      reproCmd: "python3 -s /tmp/x/reproduce_issue.py",
      exec: fakeExec(1, "Issue reproduced\n...fixed...\nIssue resolved\n"),
      timeoutMs: 1000,
      evaluatePredicate: evaluateSuccessPredicate,
    })
    expect(r.ok).toBe(false)
    expect(r.reproOutcome).toBe("exec_failed")
  })

  test("non-repro exit 0 ⇒ ok:true", async () => {
    expect((await validate(base({ exec: fakeExec(0, "3 passed") }))).ok).toBe(true)
  })

  test("non-repro exit 1 ⇒ ok:false", async () => {
    expect((await validate(base({ exec: fakeExec(1, "1 failed") }))).ok).toBe(false)
  })
})
