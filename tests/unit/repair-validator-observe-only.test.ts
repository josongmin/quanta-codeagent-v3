import { describe, expect, test } from "bun:test"
import { evaluateSuccessPredicate } from "@/agent/closure"
import { validate } from "@/runner/batch/eval/repair/validator"
import type { ExecFn, ValidateArgs } from "@/runner/batch/eval/repair/types"

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

  test("exit 0 + matching predicate ⇒ ok:true, predicate.matched:true", async () => {
    const r = await validate(
      base({ exec: fakeExec(0, "3 PASSED"), successPredicate: { type: "stdout_contains", substring: "PASSED" } }),
    )
    expect(r.ok).toBe(true)
    expect(r.predicate).toEqual({ evaluable: true, matched: true })
  })

  test("🔴 exit 0 + predicate MISMATCH ⇒ STILL ok:true (observe-only, no false-RED in v1)", async () => {
    const r = await validate(
      base({
        exec: fakeExec(0, "wrong output"),
        successPredicate: { type: "stdout_contains", substring: "expected" },
      }),
    )
    // ok unchanged (exit-code decision); mismatch only RECORDED.
    expect(r.ok).toBe(true)
    expect(r.predicate?.evaluable).toBe(true)
    expect(r.predicate?.matched).toBe(false)
  })

  test("advisory predicate (latex) ⇒ recorded evaluable:false, ok follows exit code", async () => {
    const r = await validate(
      base({
        exec: fakeExec(0),
        successPredicate: { type: "latex_or_string_exact", expected: "\\left(x\\right)" },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.predicate?.evaluable).toBe(false)
  })

  test("exit 1 ⇒ ok:false + failTail + observed recorded", async () => {
    const r = await validate(base({ exec: fakeExec(1, "out", "boom") }))
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("boom")
    expect(r.observed).toEqual({ exitCode: 1, stdout: "out", stderr: "boom" })
  })

  test("no cmd / no repro ⇒ degenerate fail (byte-identical, no observed)", async () => {
    const r = await validate({ sandbox: "/x", exec: fakeExec(0), timeoutMs: 1000 })
    expect(r).toEqual({ ok: false, failTail: "" })
  })
})

/**
 * jun-18 RCA fix — REPRO-SENTINEL gating. The repro's Agentless contract is the
 * stdout marker, not the incidental exit code (base reproduction is classified by
 * marker via classifyStdout; the patched check MUST be consistent). Confirmed
 * locally: a well-formed repro prints "Issue resolved" + exit 0 on a correct
 * patch, but malformed repros print "resolved" yet exit ≠0 — the false-RED that
 * forced wasteful churn (46→131 turns re-deriving the same correct patch). The
 * sentinel overrides the exit code; when NO sentinel is present the legacy
 * exit-code decision is byte-identical (non-repro verify cmds unaffected).
 */
describe("validator — repro-sentinel gating (RCA fix)", () => {
  test("🔴 exit ≠0 BUT stdout 'Issue resolved' ⇒ ok:true (false-RED eliminated)", async () => {
    const r = await validate(base({ exec: fakeExec(1, "warn...\nIssue resolved\n", "DeprecationWarning") }))
    expect(r.ok).toBe(true)
  })

  test("exit 0 BUT stdout 'Issue reproduced' ⇒ ok:false (repro says NOT fixed — false-green caught)", async () => {
    const r = await validate(base({ exec: fakeExec(0, "Issue reproduced\n") }))
    expect(r.ok).toBe(false)
  })

  test("exit 0 + stdout 'Other issues' ⇒ ok:false (repro blew up, not resolved)", async () => {
    const r = await validate(base({ exec: fakeExec(0, "Other issues: boom\n") }))
    expect(r.ok).toBe(false)
  })

  test("last-marker-wins: 'reproduced' then 'resolved' ⇒ ok:true", async () => {
    const r = await validate(base({ exec: fakeExec(1, "Issue reproduced\n...fixed...\nIssue resolved\n") }))
    expect(r.ok).toBe(true)
  })

  test("NO sentinel + exit 0 ⇒ ok:true (byte-identical fallback)", async () => {
    expect((await validate(base({ exec: fakeExec(0, "3 passed") }))).ok).toBe(true)
  })

  test("NO sentinel + exit 1 ⇒ ok:false (byte-identical fallback)", async () => {
    expect((await validate(base({ exec: fakeExec(1, "1 failed") }))).ok).toBe(false)
  })
})
