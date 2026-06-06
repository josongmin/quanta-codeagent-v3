import { describe, expect, test } from "bun:test"
import { detectEol } from "../../src/tool/edit/eol"
import { applyFuzzyEdit } from "../../src/tool/edit/fuzzy"

describe("detectEol", () => {
  test("uniform LF → \\n", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n")
  })

  test("uniform CRLF → \\r\\n", () => {
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n")
  })

  test("empty / single line (no terminator) defaults to \\n", () => {
    expect(detectEol("")).toBe("\n")
    expect(detectEol("no newline here")).toBe("\n")
  })

  test("mixed file resolves to the strict majority terminator", () => {
    // 3 CRLF vs 1 LF → CRLF dominant.
    expect(detectEol("a\r\nb\r\nc\r\nd\ne")).toBe("\r\n")
    // 1 CRLF vs 3 LF → LF dominant.
    expect(detectEol("a\r\nb\nc\nd\ne")).toBe("\n")
  })

  test("a tie keeps the LF default (never *introduce* CRLF)", () => {
    // 1 CRLF, 1 LF.
    expect(detectEol("a\r\nb\nc")).toBe("\n")
  })

  test("a lone \\r (not a terminator) is ignored", () => {
    // "\r" mid-line is part of the line, not a terminator; the only terminator
    // is the trailing lone \n.
    expect(detectEol("a\rb\n")).toBe("\n")
  })
})

// ---------------------------------------------------------------------------
// D6 — fuzzy splice must preserve the file's native EOL (no mixed-EOL).
// Red-on-injection: reverting the splice to `\n`-join makes (a) RED because the
// CRLF file's edited region would emit lone-LF lines.
// ---------------------------------------------------------------------------

/** Every terminator in `s` must be CRLF — assert there is no lone `\n`. */
const hasNoLoneLf = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a && s.charCodeAt(i - 1) !== 0x0d) return false
  }
  return true
}

describe("applyFuzzyEdit — EOL preservation (D6)", () => {
  test("(a) CRLF file + whitespace-approx needle → result is uniformly CRLF", () => {
    // The file uses CRLF; the needle the model typed is LF with different
    // internal whitespace, so only the whitespace-flex/anchored-trim rungs can
    // match (`.trim()` strips the `\r`). The new lines must come back CRLF.
    const src = "function f() {\r\n      return    a +  b\r\n}\r\n"
    const r = applyFuzzyEdit(src, "return a + b", "return a - b", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    // No lone-LF anywhere → no mixed EOL introduced.
    expect(hasNoLoneLf(r.next ?? "")).toBe(true)
    expect(r.next).toBe("function f() {\r\nreturn a - b\r\n}\r\n")
  })

  test("(c) exact-path CRLF edit is byte-identical (exact rung untouched)", () => {
    // The needle matches a CRLF line VERBATIM (incl. the model typing `\r`) so
    // the exact rung (applyExactEdit, a literal splice) handles it — D6 must not
    // perturb that path. Result keeps CRLF exactly.
    const src = "a\r\nfoo\r\nb\r\n"
    const r = applyFuzzyEdit(src, "foo\r", "bar\r", false)
    expect(r.ok).toBe(true)
    expect(r.message).toContain("exact match")
    expect(r.next).toBe("a\r\nbar\r\nb\r\n")
  })

  test("(b) LF file edit is byte-identical to the pre-fix LF behaviour", () => {
    const src = "function f() {\n      return    a +  b\n}"
    const r = applyFuzzyEdit(src, "return a + b", "return a - b", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("function f() {\nreturn a - b\n}")
  })

  test("(d) differential: same logical edit on LF and CRLF versions is EOL-consistent + semantically equal", () => {
    const lfSrc = "alpha   \nbeta\ngamma"
    const crlfSrc = "alpha   \r\nbeta\r\ngamma"
    const lf = applyFuzzyEdit(lfSrc, "alpha\nbeta", "ALPHA\nBETA", false)
    const crlf = applyFuzzyEdit(crlfSrc, "alpha\nbeta", "ALPHA\nBETA", false)
    expect(lf.ok).toBe(true)
    expect(crlf.ok).toBe(true)
    // EOL-consistent: LF stays LF, CRLF stays CRLF.
    expect(lf.next).toBe("ALPHA\nBETA\ngamma")
    expect(crlf.next).toBe("ALPHA\r\nBETA\r\ngamma")
    expect(hasNoLoneLf(crlf.next ?? "")).toBe(true)
    // Semantically equal: normalize both to LF and compare.
    expect((crlf.next ?? "").replace(/\r\n/g, "\n")).toBe(lf.next ?? "")
  })

  test("replaceAll on a CRLF file keeps every spliced region CRLF", () => {
    // Two duplicate lines (whitespace differs from the needle so only fuzzy
    // matches) → replace_all splices BOTH; each spliced region must stay CRLF.
    const src = "x =  1\r\nmid\r\nx =  1\r\n"
    const r = applyFuzzyEdit(src, "x = 1", "x = 2", true)
    expect(r.ok).toBe(true)
    expect(hasNoLoneLf(r.next ?? "")).toBe(true)
    expect(r.next).toBe("x = 2\r\nmid\r\nx = 2\r\n")
  })
})
