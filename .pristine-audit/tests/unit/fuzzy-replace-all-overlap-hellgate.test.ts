import { describe, expect, test } from "bun:test"
import { applyFuzzyEdit } from "../../src/tool/edit/fuzzy"

/**
 * [F3] FUZZY replace_all OVERLAPPING-WINDOW CORRUPTION (hellgate).
 *
 * Under replace_all, the old applyWindows spliced EVERY span returned by
 * findLineWindows — including SELF-OVERLAPPING windows. For a 2-line needle
 * whose normalized form repeats across N consecutive lines, findLineWindows
 * returns spans {0,2},{1,3},{2,4}… all overlapping by one line. Splicing each
 * independently (even bottom-up) replaces every line, dropping/corrupting the
 * non-overlapping leftover.
 *
 * The EXACT path is inherently non-overlapping: `source.split(old).join(new)`
 * never re-scans inside a just-consumed match. Line-level analog:
 *   "aaa".split("aa").join("XX") === "XXa"   // ONE replacement, "a" leftover
 *   "aaaaa".split("aa").join("XX") === "XXXXa"
 * Fuzzy replace_all MUST match this semantics: greedy left-to-right selection
 * of NON-OVERLAPPING windows only.
 */
describe("F3 fuzzy replace_all overlapping-window corruption", () => {
  // ── Sanity: confirm the split/join semantics fuzzy must mirror. ──────────
  test("baseline: split/join is non-overlapping (the semantics to mirror)", () => {
    expect("aaa".split("aa").join("XX")).toBe("XXa")
    expect("aaaaa".split("aa").join("XX")).toBe("XXXXa")
  })

  // ── RED: 3 self-similar lines, 2-line needle. ───────────────────────────
  // Source lines all normalize to "a" (trailing space differs from needle so
  // EXACT misses). whitespace-flex finds overlapping spans {0,2} and {1,3}.
  // Greedy non-overlap accepts only {0,2}; line 2 ("a ") is a leftover and
  // must survive untouched — exactly like "aaa".split("aa").join("XX")==="XXa".
  test("3 self-similar lines: only ONE non-overlapping window replaced", () => {
    const src = "a \na \na "
    const r = applyFuzzyEdit(src, "a\na", "X\nX", true)
    expect(r.ok).toBe(true)
    // CORRECT (non-overlapping): {0,2}->X\nX, line index 2 "a " left intact.
    expect(r.next).toBe("X\nX\na ")
    // The bug produced "X\nX\nX" (line 2 wrongly consumed by overlapping {1,3}).
    expect(r.next).not.toBe("X\nX\nX")
    expect(r.message).toContain("Replaced 1")
  })

  // ── RED: 5 self-similar lines, 2-line needle. ───────────────────────────
  // Spans {0,2},{1,3},{2,4},{3,5} all overlap. Greedy accepts {0,2},{2,4};
  // line index 4 ("a ") is the leftover, like "aaaaa".split("aa").join==="XXXXa".
  test("5 self-similar lines: TWO non-overlapping windows, last line leftover", () => {
    const src = "a \na \na \na \na "
    const r = applyFuzzyEdit(src, "a\na", "X\nX", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("X\nX\nX\nX\na ")
    expect(r.next).not.toBe("X\nX\nX\nX\nX")
    expect(r.message).toContain("Replaced 2")
  })

  // ── GREEN-GUARD: distinct (non-overlapping) windows unaffected. ─────────
  // Two separate matched windows that do NOT overlap must BOTH be replaced —
  // the fix must not regress the legitimate multi-replace path.
  test("byte-identical: distinct non-overlapping windows both replaced", () => {
    // 1-line needle: every window is length 1, none can overlap. Three matches.
    const src = "k  =  1\nsep\nk  =  1\nsep\nk  =  1"
    const r = applyFuzzyEdit(src, "k = 1", "k = 2", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("k = 2\nsep\nk = 2\nsep\nk = 2")
    expect(r.message).toContain("Replaced 3")
  })

  // 2-line needle matching at well-separated, non-overlapping windows.
  test("byte-identical: 2-line windows that don't overlap both replaced", () => {
    const src = "a \nb \nZZZ\na \nb "
    const r = applyFuzzyEdit(src, "a\nb", "P\nQ", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("P\nQ\nZZZ\nP\nQ")
    expect(r.message).toContain("Replaced 2")
  })

  // ── GREEN-GUARD: non-replace_all path totally unchanged. ────────────────
  // Without replace_all, an overlapping multi-window match is ambiguous and the
  // ladder must keep failing (no greedy reduction sneaks an apply in).
  test("non-replace_all over self-similar lines stays ambiguous (unchanged)", () => {
    const src = "a \na \na "
    const r = applyFuzzyEdit(src, "a\na", "X\nX", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.message).toMatch(/ambiguous/)
  })

  // ── GREEN-GUARD: single fuzzy match (non-replace_all) unchanged. ────────
  test("byte-identical: single whitespace-flex match (non-replace_all)", () => {
    const src = "function f() {\n      return    a +  b\n}"
    const r = applyFuzzyEdit(src, "return a + b", "return a - b", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("function f() {\nreturn a - b\n}")
    expect(r.message).toContain("whitespace-flexible")
  })
})
