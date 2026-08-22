/**
 * Repair spec-gate — observed-output declared-expected matcher (jun-26
 * repair-loop oracle-hardening).
 *
 * The repair-loop false-green RCA: an over-narrow patch passes the agent's own
 * weak repro (exit 0) so `clearedAsValidated` clears at round 0 while the hidden
 * fail_to_pass stays red. The fix makes the repair rail's success check ALSO
 * require the PUBLIC issue-declared expected output to appear in the observed
 * stdout: a green run whose output LACKS the declared expected ⇒ predicate
 * {evaluable:true, matched:false} ⇒ false-green ⇒ loop runs another round.
 *
 * This file pins the PURE matcher
 * (`evaluateDeclaredExpectedAgainstObserved`) that produces that verdict from an
 * {@link IssueDeclaredExpected} + an {@link ExecObservation}. NO I/O.
 */

import { describe, expect, test } from "bun:test"
import type { ExecObservation } from "@/agent/closure"
import { type IssueDeclaredExpected, PUBLIC_ISSUE_TEXT_PROVENANCE } from "@/agent/verification-plan"
import { evaluateDeclaredExpectedAgainstObserved } from "@/runner/batch/eval/declared-expected-matcher"

const declared = (kind: IssueDeclaredExpected["kind"], value: string): IssueDeclaredExpected => ({
  kind,
  value,
  provenance: PUBLIC_ISSUE_TEXT_PROVENANCE,
})

const obs = (stdout: string, stderr = "", exitCode = 0): ExecObservation => ({
  exitCode,
  stdout,
  stderr,
})

describe("evaluateDeclaredExpectedAgainstObserved — repair spec gate", () => {
  test("declared stdout literal PRESENT in observed ⇒ evaluable+matched (clears)", () => {
    const v = evaluateDeclaredExpectedAgainstObserved(
      declared("stdout", "TypeError: cannot convert"),
      obs("...\nE   TypeError: cannot convert\n1 passed"),
    )
    expect(v).toEqual({ evaluable: true, matched: true })
  })

  test("declared stdout literal ABSENT in a green observation ⇒ evaluable+matched:false (false-green)", () => {
    const v = evaluateDeclaredExpectedAgainstObserved(
      declared("stdout", "TypeError: cannot convert"),
      obs("1 passed in 0.3s"),
    )
    expect(v.evaluable).toBe(true)
    expect(v.matched).toBe(false)
    expect(v.mismatchReason).toBeDefined()
  })

  test("declared value matched against stderr too (runners print to either stream)", () => {
    const v = evaluateDeclaredExpectedAgainstObserved(
      declared("stdout", "ZeroDivisionError: weights sum to zero"),
      obs("", "Traceback...\nZeroDivisionError: weights sum to zero\n"),
    )
    expect(v).toEqual({ evaluable: true, matched: true })
  })

  test("whitespace-insensitive substring match (collapsed)", () => {
    const v = evaluateDeclaredExpectedAgainstObserved(
      declared("stdout", "got   multiple   spaces"),
      obs("prefix got multiple spaces suffix"),
    )
    expect(v).toEqual({ evaluable: true, matched: true })
  })

  test("latex/symbolic kinds behave the same (literal in output)", () => {
    expect(
      evaluateDeclaredExpectedAgainstObserved(declared("symbolic", "(1,)"), obs("result = (1,)\n")),
    ).toEqual({ evaluable: true, matched: true })
    expect(
      evaluateDeclaredExpectedAgainstObserved(declared("symbolic", "(1,)"), obs("result = []\n"))
        .matched,
    ).toBe(false)
  })

  test("ABSTAIN on stdout-empty (absence of a print is not visible in pytest output) ⇒ fail-open", () => {
    const v = evaluateDeclaredExpectedAgainstObserved(
      declared("stdout-empty", "issue declares the correct output is empty"),
      obs("1 passed in 0.3s"),
    )
    expect(v.evaluable).toBe(false)
    expect(v.matched).toBe(false)
  })

  test("ABSTAIN on a non-spec-bearing (bare-word) declared value ⇒ fail-open (no false-RED on noise)", () => {
    // A short bare identifier could appear incidentally in runner output; abstain
    // rather than hard-gate on it.
    const v = evaluateDeclaredExpectedAgainstObserved(declared("stdout", "id"), obs("xxx"))
    expect(v.evaluable).toBe(false)
  })

  test("ABSTAIN on an empty declared value ⇒ fail-open", () => {
    expect(
      evaluateDeclaredExpectedAgainstObserved(declared("stdout", "   "), obs("anything")).evaluable,
    ).toBe(false)
  })

  test("NO-LEAK guard: a non-public-provenance invariant is NEVER evaluated (abstain)", () => {
    // red-on-injection: if a gold/test_patch-derived value were ever passed in, the
    // matcher must refuse to give it authority.
    const poisoned = {
      kind: "stdout" as const,
      value: "GOLD ANSWER LEAK",
      provenance: "gold-patch" as unknown as typeof PUBLIC_ISSUE_TEXT_PROVENANCE,
    }
    const v = evaluateDeclaredExpectedAgainstObserved(poisoned, obs("GOLD ANSWER LEAK"))
    expect(v.evaluable).toBe(false)
    expect(v.matched).toBe(false)
  })
})
