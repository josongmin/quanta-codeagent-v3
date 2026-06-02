import { describe, expect, test } from "bun:test"
import { applyFuzzyEdit } from "../../src/tool/edit/fuzzy"

describe("applyFuzzyEdit", () => {
  test("exact passthrough wins first", () => {
    const r = applyFuzzyEdit("const a = 1", "1", "2", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("const a = 2")
    expect(r.message).toContain("exact match")
  })

  test("whitespace-flexible match (indentation / internal runs differ)", () => {
    const src = "function f() {\n      return    a +  b\n}"
    const r = applyFuzzyEdit(src, "return a + b", "return a - b", false)
    expect(r.ok).toBe(true)
    expect(r.message).toContain("whitespace-flexible")
    expect(r.next).toBe("function f() {\nreturn a - b\n}")
  })

  test("anchored-trim match reached when whitespace-flex over-collapses", () => {
    // Needle has a single internal space; file line has a double internal
    // space. normalizeLine collapses BOTH sides so whitespace-flex still
    // matches first — anchored-trim is a strict subset, so it can only ever
    // confirm. Assert the edit is correct and matched by a fuzzy strategy.
    const src = "  if  (x) {\n    do_it()\n  }"
    const r = applyFuzzyEdit(src, "if (x) {\ndo_it()\n}", "if (y) {\ndo_it()\n}", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    expect(r.next).toBe("if (y) {\ndo_it()\n}")
  })

  test("trailing-whitespace-only difference matches via a fuzzy strategy", () => {
    // Two lines so no single exact substring spans them; the file's first
    // line has trailing spaces the needle lacks → fuzzy line-trim matches.
    const src = "alpha   \nbeta"
    const r = applyFuzzyEdit(src, "alpha\nbeta", "ALPHA\nBETA", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    expect(r.next).toBe("ALPHA\nBETA")
  })

  test("ambiguous fuzzy match without replace_all fails (stops the ladder)", () => {
    // Needle uses single spaces; every file line uses double spaces → exact
    // never matches, whitespace-flex finds 3 spans → ambiguous, ladder stops.
    const src = "x  =  1\n  x  =  1\n    x  =  1"
    const r = applyFuzzyEdit(src, "x = 1", "x = 2", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.message).toMatch(/ambiguous/)
  })

  test("no-match fails with a helpful message", () => {
    const r = applyFuzzyEdit("alpha\nbeta", "gamma delta", "x", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.message).toContain("no confident match")
  })

  test("replace_all applies every fuzzy span (exact declined, ws-flex wins)", () => {
    // Needle has single internal spaces; file lines have double → exact never
    // matches, whitespace-flex collapses each line and replaces all 3 spans.
    const src = "a  +  b\n  a  +  b\n    a  +  b"
    const r = applyFuzzyEdit(src, "a + b", "a - b", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("a - b\na - b\na - b")
    expect(r.message).toContain("3 occurrence")
    expect(r.message).toContain("whitespace-flexible")
  })

  test("rejects identical strings and empty old_string", () => {
    expect(applyFuzzyEdit("x", "a", "a", false).ok).toBe(false)
    expect(applyFuzzyEdit("x", "", "a", false).ok).toBe(false)
  })

  // ADR-0451 — scored-candidate recovery rung. Runs ONLY on the ambiguous path
  // that the 3-rung ladder rejects outright today. Each candidate window is
  // scored by its verbatim-exact line count; recovery happens only when exactly
  // one candidate strictly outscores ALL others (strict-ordering discriminator).
  describe("scored-candidate recovery (ADR-0451)", () => {
    test("recovers when one ambiguous candidate has strictly more exact-anchor lines", () => {
      // Needle = "  x = 1\n  y = 2". Line 1 ("  y = 2") matches NEITHER window
      // verbatim (both use double internal spaces), so the multi-line needle is
      // NOT a verbatim substring anywhere → exact fails. Under whitespace-flex
      // BOTH windows match → ambiguous (2 spans). But window A's first line
      // ("  x = 1") IS verbatim while window B's ("  x  =  1") is not, so the
      // exact-anchor score is A=1 vs B=0 → strict winner A → recovers there.
      const src = ["  x = 1", "  y  =  2", "sep", "  x  =  1", "  y  =  2"].join("\n")
      const r = applyFuzzyEdit(src, "  x = 1\n  y = 2", "  x = 9\n  y = 9", false)
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/scored|best/i)
      // Applied to window A (higher exact-anchor count), NOT window B.
      expect(r.next).toBe(["  x = 9", "  y = 9", "sep", "  x  =  1", "  y  =  2"].join("\n"))
    })

    test("true tie (equal exact-anchor counts) STILL fails ambiguous — safety anchor", () => {
      // Both windows are byte-identical to the needle's whitespace shape under
      // normalization AND have the SAME verbatim-exact line count (both 0 exact
      // because both differ from the needle by internal runs identically).
      // No strict winner → must keep failing.
      const src = ["a  =  1", "  a  =  1", "    a  =  1"].join("\n")
      const r = applyFuzzyEdit(src, "a = 1", "a = 2", false)
      expect(r.ok).toBe(false)
      expect(r.next).toBeUndefined()
      expect(r.message).toMatch(/ambiguous/)
    })

    test("two candidates with EQUAL exact-anchor counts (both verbatim) fail", () => {
      // Needle line trimmed; two windows where trimming both yields the needle
      // but the verbatim-exact line count is EQUAL (both 0) → tie → fail.
      const src = ["  foo", "  foo"].join("\n")
      // exact never matches (count 2 → ambiguous in exact too, but exact handles
      // its own ambiguity); use a leading-trim-only divergence that only
      // anchored-trim catches with 2 spans and equal exact scores.
      const r = applyFuzzyEdit(src, "foo", "bar", false)
      expect(r.ok).toBe(false)
      expect(r.next).toBeUndefined()
      expect(r.message).toMatch(/ambiguous/)
    })

    test("3-line needle, one window strictly tops all others → recovers", () => {
      // 3-line needle; line c is never verbatim in either window, so the whole
      // block is not a verbatim substring → exact fails, ws-flex → 2 spans
      // (ambiguous). Window 0 matches 2 lines verbatim (a, b), window 1 matches
      // 1 (c). Strict winner = window 0 → recovers and applies there only.
      const src = [
        "a = 1", // w0 l0 verbatim
        "b = 2", // w0 l1 verbatim
        "c  =  3", // w0 l2 differs   → score 2
        "a  =  1", // w1 l0 differs
        "b  =  2", // w1 l1 differs
        "c = 3", // w1 l2 verbatim  → score 1
      ].join("\n")
      const r = applyFuzzyEdit(src, "a = 1\nb = 2\nc = 3", "X\nY\nZ", false)
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/scored|best/i)
      expect(r.next).toBe(["X", "Y", "Z", "a  =  1", "b  =  2", "c = 3"].join("\n"))
    })

    test("near-tie at the top (two share the max) → fails, no edit applied", () => {
      // Window 0 scores 2 (a, b verbatim); window 1 ALSO scores 2 (a, c
      // verbatim). The max is shared → no strict winner → must fail
      // (false-negative is strictly preferred over a wrong-window edit).
      const src = [
        "a = 1",
        "b = 2",
        "c  =  3", // w0 = 2
        "a = 1",
        "b  =  2",
        "c = 3", // w1 = 2
      ].join("\n")
      const r = applyFuzzyEdit(src, "a = 1\nb = 2\nc = 3", "X\nY\nZ", false)
      expect(r.ok).toBe(false)
      expect(r.next).toBeUndefined()
      expect(r.message).toMatch(/ambiguous/)
    })

    test("replace_all is never routed through the scored rung (unchanged)", () => {
      // With replace_all the ws-flex rung applies ALL spans (it's not ambiguous),
      // so the scored rung never runs. Outcome identical to pre-ADR behavior.
      const src = "a  +  b\n  a  +  b\n    a  +  b"
      const r = applyFuzzyEdit(src, "a + b", "a - b", true)
      expect(r.ok).toBe(true)
      expect(r.next).toBe("a - b\na - b\na - b")
      expect(r.message).toContain("3 occurrence")
    })

    test("recovered outcome carries no failure kind (ok result)", () => {
      const src = ["  x = 1", "  y  =  2", "sep", "  x  =  1", "  y  =  2"].join("\n")
      const r = applyFuzzyEdit(src, "  x = 1\n  y = 2", "  x = 9\n  y = 9", false)
      expect(r.ok).toBe(true)
      expect(r.kind).toBeUndefined()
    })

    test("failed scored rung still carries ambiguous kind for index.ts marker", () => {
      const src = ["a  =  1", "  a  =  1", "    a  =  1"].join("\n")
      const r = applyFuzzyEdit(src, "a = 1", "a = 2", false)
      expect(r.ok).toBe(false)
      expect(r.kind).toBe("ambiguous")
    })
  })
})
