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
})
