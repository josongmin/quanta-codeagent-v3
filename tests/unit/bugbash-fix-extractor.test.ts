import { describe, expect, test } from "bun:test"
import { extractIssueDeclaredExpected } from "@/agent/verification-plan/extract-issue-declared-expected"

/**
 * jun-20 bugbash — extractor recall regression (findings #10/#11).
 *
 * The removed EXPECT_RE pre-gate (verbs: print|output|return|give|produce|
 * render|show|be|display|yield) was strictly NARROWER than EXPECT_LITERAL_RE
 * (which adds `equals?` and the plural forms returns?/gives?/…). Because the
 * pre-gate ran BEFORE the real matcher, any declared output whose verb existed
 * only in EXPECT_LITERAL_RE was silently dropped. These tests pin the verbs the
 * pre-gate lacked: revert the fix (re-add the EXPECT_RE guard) and they go RED
 * because extraction returns undefined.
 */
describe("bugbash #10 — EXPECT_LITERAL_RE verbs missing from the old pre-gate now extract", () => {
  test("'should equal `LITERAL`' ⇒ extracted (no `equal` verb existed in EXPECT_RE)", () => {
    const r = extractIssueDeclaredExpected("The result should equal `(1,)` but the call returns `(1)`.")
    expect(r).toEqual({ kind: "symbolic", value: "(1,)" })
  })

  test("'should equals `LITERAL`' (plural) ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected("It should equals `42` here.")
    expect(r?.value).toBe("42")
  })

  test("'should returns `LITERAL`' (plural verb form) ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected("The helper should returns `(1,)` for a 1-tuple.")
    expect(r).toEqual({ kind: "symbolic", value: "(1,)" })
  })

  test("'should produces `LITERAL`' (plural verb form) ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected('The printer should produces "x_{1}" here.')
    expect(r?.value).toBe("x_{1}")
  })

  test("'should gives `LITERAL`' (plural verb form) ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected("It should gives `True` on this input.")
    // bare common word <4 chars stays admissible only with structure; "True" is
    // 4 chars so isMeaningful passes.
    expect(r?.value).toBe("True")
  })

  test("control: singular verb already covered ⇒ still extracts (no regression)", () => {
    const r = extractIssueDeclaredExpected("It should print `(1,)` but prints `(1)`.")
    expect(r).toEqual({ kind: "symbolic", value: "(1,)" })
  })

  test("control: fail-closed — no expect verb + no marker ⇒ undefined", () => {
    expect(extractIssueDeclaredExpected("The result is `(1,)` somewhere in the trace.")).toBeUndefined()
  })
})
