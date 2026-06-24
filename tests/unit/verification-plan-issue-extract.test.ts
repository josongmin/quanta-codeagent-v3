import { describe, expect, test } from "bun:test"
import { buildVerificationPlan } from "@/agent/verification-plan/build"
import { extractIssueDeclaredExpected } from "@/agent/verification-plan/extract-issue-declared-expected"

/**
 * gap-B spec-fidelity rail — the issue-declared-expected extractor + its mapping
 * into a typed VerificationPlan successPredicate.
 *
 * FAIL-CLOSED is the load-bearing property: ambiguous text ⇒ undefined, so the
 * steer never fires on co-change cases (sympy-15976 / 21930) that have no single
 * exact declared output.
 */
describe("extractIssueDeclaredExpected — precision-first", () => {
  test("explicit 'should print `LITERAL`' ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected(
      "Bug: lambdify a 1-tuple. It should print `(1,)` but prints `(1)`.",
    )
    expect(r).toEqual({ kind: "symbolic", value: "(1,)", provenance: "public-issue-text" })
  })

  test("'should return' with a quoted literal ⇒ extracted (stdout kind)", () => {
    const r = extractIssueDeclaredExpected(
      'The function should return "hello world" for this input.',
    )
    expect(r?.value).toBe("hello world")
    expect(r?.kind).toBe("stdout")
  })

  test("LaTeX value ⇒ latex kind", () => {
    const r = extractIssueDeclaredExpected(
      "The Subs printer should render `\\left(x y\\right)` but emits a bad string.",
    )
    expect(r?.kind).toBe("latex")
    expect(r?.value).toBe("\\left(x y\\right)")
  })

  test("explicit empty-output declaration ⇒ stdout-empty", () => {
    const r = extractIssueDeclaredExpected(
      "With min-similarity-lines=0 the checker should report no duplicates, but it flags everything.",
    )
    expect(r?.kind).toBe("stdout-empty")
  })

  test("'Expected: LITERAL' label ⇒ extracted", () => {
    const r = extractIssueDeclaredExpected("Got: (1)\nExpected: `(1,)`\n")
    expect(r?.value).toBe("(1,)")
  })

  // FAIL-CLOSED cases — the safety net.
  test("no marker ⇒ undefined", () => {
    expect(
      extractIssueDeclaredExpected(
        "The MathML printer drops the subscript on bold symbols in Safari.",
      ),
    ).toBeUndefined()
  })

  test("empty / undefined input ⇒ undefined", () => {
    expect(extractIssueDeclaredExpected("")).toBeUndefined()
    expect(extractIssueDeclaredExpected(undefined)).toBeUndefined()
  })

  test("a bare short word after a verb is rejected (too weak)", () => {
    // "should be ok" — "ok" is a 2-char bare word, not an exact spec.
    expect(extractIssueDeclaredExpected("It should be `ok` now.")).toBeUndefined()
  })

  // FIX A — broad bare single-word literals must NOT become a stdout_contains
  // substring (a patched tree that prints the word ANYWHERE would false-pass).
  test("FP guard: broad bare common words (none/null/pass/true/error) ⇒ NOT a stdout substring", () => {
    // build.ts routes kind:"stdout" → { type:"stdout_contains", substring:value }.
    // For a bare common word that is a false-green spec rail, so it must NOT
    // surface as a stdout-kind extract (either undefined, or never stdout-kind).
    for (const word of ["none", "null", "pass", "true", "error", "false"]) {
      const r = extractIssueDeclaredExpected(`The function should return \`${word}\` for this input.`)
      // Either rejected outright, or — if some other rule admits it — it must NOT
      // be the broad stdout_contains substring path.
      if (r !== undefined) {
        expect(r.kind).not.toBe("stdout")
      } else {
        expect(r).toBeUndefined()
      }
    }
  })

  test("structured expected outputs are STILL admitted (no over-tightening)", () => {
    // Punctuation: a KeyError message (no nested delimiter, which the capture
    // class `[^`'"]` would otherwise terminate on).
    expect(
      extractIssueDeclaredExpected("It should print `KeyError: foo` instead of succeeding.")?.value,
    ).toBe("KeyError: foo")
    // Whitespace + digits.
    expect(
      extractIssueDeclaredExpected("The assertion should print `expected 3 got 5` on failure.")
        ?.value,
    ).toBe("expected 3 got 5")
    // Multi-token whitespace value (existing 'hello world' shape).
    expect(
      extractIssueDeclaredExpected('The function should return "hello world" for this input.')
        ?.value,
    ).toBe("hello world")
  })

  test("a 'should fix' sentence WITHOUT a delimited literal ⇒ undefined", () => {
    expect(
      extractIssueDeclaredExpected("We should print the result correctly instead of crashing."),
    ).toBeUndefined()
  })

  // Real-data regressions (measured against the 7 oracle problem statements).
  test("FP guard: 'should be returned by `solveset`' ⇒ undefined (preposition-object, NOT a value)", () => {
    // sympy-18211 produced exactly this false positive with a loose verb→literal gap.
    expect(
      extractIssueDeclaredExpected(
        "The obvious result should be returned by `solveset` instead of raising.",
      ),
    ).toBeUndefined()
  })

  test("real empty-decl: 'should stop pylint from checking duplicate code' ⇒ stdout-empty", () => {
    // pylint-4970 verbatim phrasing.
    expect(
      extractIssueDeclaredExpected(
        "Setting `min-similarity-lines` to `0` should stop pylint from checking duplicate code.",
      )?.kind,
    ).toBe("stdout-empty")
  })

  test("FP guard: 'Expected: <unquoted prose>' ⇒ undefined (label needs a delimited value)", () => {
    // Adversarial audit lens-2: the optional-quote branch captured bare prose.
    expect(extractIssueDeclaredExpected("Expected: the function works correctly")).toBeUndefined()
    expect(
      extractIssueDeclaredExpected("Expected result: nothing changes in output"),
    ).toBeUndefined()
    // …but a DELIMITED labelled value still extracts.
    expect(extractIssueDeclaredExpected("Expected output: `[1, 2, 3]`")?.value).toBe("[1, 2, 3]")
  })

  test("error-message proposal code block extracts the FULL message, not an inner quoted token", () => {
    const r = extractIssueDeclaredExpected(`Proposal: change the message to the form of:
\`\`\`
ValueError: TimeSeries object is invalid - expected ['time', 'flux'] as the first columns but found ['time', 'b']
\`\`\`
`)
    expect(r).toEqual({
      kind: "stdout",
      value:
        "ValueError: TimeSeries object is invalid - expected ['time', 'flux'] as the first columns but found ['time', 'b']",
      provenance: "public-issue-text",
    })
  })

  test("HTML-commented expected markers are ignored", () => {
    expect(
      extractIssueDeclaredExpected(
        "<!-- Expected: `hidden` -->\nThe function should return `visible` for this input.",
      ),
    ).toEqual({ kind: "stdout", value: "visible", provenance: "public-issue-text" })
  })
})

describe("buildVerificationPlan — issueDeclaredExpected mapping", () => {
  const withSpec = (kind: "latex" | "symbolic" | "stdout" | "stdout-empty", value: string) =>
    buildVerificationPlan({
      ownerNearTests: ["pytest x"],
      issueDeclaredExpected: { kind, value },
    })

  test("latex ⇒ latex_or_string_exact + exact-diff authority on primary", () => {
    const p = withSpec("latex", "\\left(x\\right)")
    expect(p.required[0]?.successPredicate).toEqual({
      type: "latex_or_string_exact",
      expected: "\\left(x\\right)",
    })
    expect(p.required[0]?.authority).toBe("exact-diff")
  })

  test("symbolic ⇒ symbolic_repr_equals + structure authority", () => {
    const p = withSpec("symbolic", "(1,)")
    expect(p.required[0]?.successPredicate).toEqual({
      type: "symbolic_repr_equals",
      expectedRepr: "(1,)",
    })
    expect(p.required[0]?.authority).toBe("structure")
  })

  test("stdout ⇒ stdout_contains", () => {
    const p = withSpec("stdout", "hello")
    expect(p.required[0]?.successPredicate).toEqual({ type: "stdout_contains", substring: "hello" })
  })

  test("stdout-empty ⇒ stdout_exact_empty (value NOT used as substring)", () => {
    const p = withSpec("stdout-empty", "issue declares empty")
    expect(p.required[0]?.successPredicate).toEqual({ type: "stdout_exact_empty" })
    expect(p.required[0]?.authority).toBe("execution")
  })

  test("no issueDeclaredExpected ⇒ default execution predicate (byte-identical rail)", () => {
    const p = buildVerificationPlan({ ownerNearTests: ["pytest x"] })
    expect(p.required[0]?.successPredicate).toEqual({ type: "test_exit_zero" })
  })
})
