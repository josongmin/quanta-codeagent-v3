import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
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

// ---------------------------------------------------------------------------
// D6 MIXED-EOL CORRUPTION (jun-25) — the silent content-corruption bug.
//
// A MIXED-EOL file (mostly one terminator with a region of the other) must NOT
// be whole-file-normalized by a fuzzy edit that touches a SINGLE line. The old
// `next.join(detectEol(source))` reassembly coerced EVERY line's terminator to
// the strict-majority EOL — silently rewriting hundreds of untouched lines. The
// fix splices BYTE-LITERALLY into the original source at the matched window's
// char span, so every byte OUTSIDE the edited window is identical to the input.
//
// TEETH: under the old whole-file join, the untouched lines' minority-EOL
// terminators are rewritten to the majority EOL, so the byte-identity assertions
// below FAIL (the result no longer equals the input outside the edited window).
// ---------------------------------------------------------------------------

/** The substring of `s` with the edited line's region cut out, used to assert
 *  the surrounding bytes are byte-identical to the input. */
const sliceAround = (s: string, removeStart: number, removeEnd: number): string =>
  s.slice(0, removeStart) + s.slice(removeEnd)

describe("applyFuzzyEdit — MIXED-EOL files: untouched lines keep their ORIGINAL terminators (D6)", () => {
  test("LF-majority file with one CRLF region: editing an LF line leaves the CRLF region byte-identical", () => {
    // Lines 0,1 are LF; line 2 ("keep me\r") is CRLF; lines 3,4 LF. LF is the
    // strict majority, so the OLD code would have rewritten the CRLF terminator
    // on line 2 to LF. We edit line 1 (whitespace-approx → fuzzy rung), and the
    // CRLF region must survive untouched.
    const src = "head\n  target   here\nkeep me\r\ntail one\ntail two"
    expect(detectEol(src)).toBe("\n") // LF is the strict majority

    const r = applyFuzzyEdit(src, "target here", "TARGET DONE", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    const out = r.next ?? ""

    // The edited line became "TARGET DONE" with its OWN (LF) terminator.
    expect(out).toContain("TARGET DONE\n")
    // The CRLF region is BYTE-IDENTICAL — its \r\n was NOT coerced to \n.
    expect(out).toContain("keep me\r\n")
    // Whole-file shape: only line 1 changed; everything else verbatim.
    expect(out).toBe("head\nTARGET DONE\nkeep me\r\ntail one\ntail two")
  })

  test("CRLF-majority file with one LF region: editing a CRLF line leaves the LF region byte-identical", () => {
    // Lines 0,1,3,4 are CRLF; line 2 ("lone\n") is a lone-LF. CRLF is the strict
    // majority, so the OLD code would have rewritten the lone LF to CRLF. We edit
    // line 1 via the fuzzy rung; the lone-LF line must survive untouched.
    const src = "head\r\n  target   here\r\nlone\ntail one\r\ntail two\r\n"
    expect(detectEol(src)).toBe("\r\n") // CRLF is the strict majority

    const r = applyFuzzyEdit(src, "target here", "TARGET DONE", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    const out = r.next ?? ""

    // The edited (CRLF) line is re-emitted CRLF (window-local terminator).
    expect(out).toContain("TARGET DONE\r\n")
    // The lone-LF region is BYTE-IDENTICAL — its \n was NOT coerced to \r\n.
    // "lone" is followed by a lone \n (the char before that \n is "e", not \r).
    const idx = out.indexOf("lone\n")
    expect(idx).toBeGreaterThanOrEqual(0)
    const lfPos = idx + "lone".length // position of the \n after "lone"
    expect(out.charCodeAt(lfPos)).toBe(0x0a) // the terminator is \n
    expect(out.charCodeAt(lfPos - 1)).not.toBe(0x0d) // NOT preceded by \r → lone LF
    // Whole-file shape.
    expect(out).toBe("head\r\nTARGET DONE\r\nlone\ntail one\r\ntail two\r\n")
  })

  test("everything OUTSIDE the edited window is byte-identical to the input (mixed file)", () => {
    // Strong invariant: cut the edited line out of BOTH input and output and the
    // remainders must be byte-equal. This catches ANY terminator coercion on an
    // untouched line, anywhere in the file.
    const src = "a\nb\nc\r\nd\ne\r\nf\n  EDIT  ME\ng\r\nh\n"
    // Edit the line "  EDIT  ME" (index in source).
    const lineStart = src.indexOf("  EDIT  ME")
    const lineEnd = src.indexOf("\n", lineStart) + 1 // include its LF terminator
    const r = applyFuzzyEdit(src, "EDIT ME", "DONE", false)
    expect(r.ok).toBe(true)
    const out = r.next ?? ""

    // The replacement line: "DONE" + the window's LF terminator.
    const outLineStart = out.indexOf("DONE")
    const outLineEnd = out.indexOf("\n", outLineStart) + 1
    // Surrounding bytes (input vs output, edited line removed) are IDENTICAL —
    // no untouched terminator was rewritten.
    expect(sliceAround(out, outLineStart, outLineEnd)).toBe(sliceAround(src, lineStart, lineEnd))
    // And the CRLF lines are still CRLF in the output.
    expect(out).toContain("c\r\n")
    expect(out).toContain("e\r\n")
    expect(out).toContain("g\r\n")
  })

  test("replaceAll across a mixed-EOL file: untouched lines (both EOLs) survive verbatim", () => {
    // Two fuzzy-matching duplicate lines straddle a mixed region; replace_all
    // splices BOTH. Untouched lines keep their own terminator (CRLF stays CRLF,
    // LF stays LF) — no whole-file normalize.
    const src = "x =  1\nmid CRLF\r\nbetween\nx =  1\r\nlone\n"
    const r = applyFuzzyEdit(src, "x = 1", "x = 2", true)
    expect(r.ok).toBe(true)
    const out = r.next ?? ""
    expect(out).toContain("mid CRLF\r\n") // untouched CRLF survives
    expect(out).toContain("between\n") // untouched LF survives
    expect(out).toContain("lone\n") // untouched LF survives
    // Each "x = 1" became "x = 2" with that line's ORIGINAL terminator:
    // first occurrence was LF-terminated, second was CRLF-terminated.
    expect(out).toBe("x = 2\nmid CRLF\r\nbetween\nx = 2\r\nlone\n")
  })

  test("scored-candidate recovery on a mixed-EOL file also byte-preserves untouched lines", () => {
    // Engineer the ADR-0456 scored-candidate rung (ambiguous → strict winner) on
    // a mixed-EOL file and assert the untouched CRLF region survives. Window A's
    // first line is verbatim; window B's is not → strict winner A.
    const src = "  x = 1\n  y  =  2\nCRLF HERE\r\n  x  =  1\n  y  =  2\n"
    const r = applyFuzzyEdit(src, "  x = 1\n  y = 2", "  x = 9\n  y = 9", false)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/scored|best/i)
    const out = r.next ?? ""
    // The untouched CRLF line is byte-identical.
    expect(out).toContain("CRLF HERE\r\n")
    expect(out).toBe("  x = 9\n  y = 9\nCRLF HERE\r\n  x  =  1\n  y  =  2\n")
  })
})

// ---------------------------------------------------------------------------
// T-D6 (RFC jun-7 Phase-2-FINAL W3) — REAL-FS disk round-trip CRLF.
//
// The `applyFuzzyEdit` tests above are pure-string only (no disk). The plan
// flagged the real-modality proof as MISSING: nothing exercised the actual
// `edit` tool's read→edit→write path against a CRLF file ON DISK. This drives
// the REAL `editTool` (default `@/storage` filesystem port) against a temp CRLF
// file, with a WHITESPACE-APPROXIMATE `old_string` (different internal spacing
// + LF-typed needle) so the EXACT rung MISSES and the FUZZY rung — the rung that
// carried the D6 mixed-EOL bug — is the one that applies. We then re-READ the
// file from disk and assert: (1) NO lone-`\n` was introduced (the file stays
// uniformly CRLF), and (2) the edit applied correctly.
// ---------------------------------------------------------------------------

const diskDir = mkdtempSync(join(tmpdir(), "edit-eol-disk-"))
afterAll(() => rmSync(diskDir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const runEdit = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result from editTool")
  return result
}

/** Every terminator in `s` is CRLF — no lone `\n` (mirror of the helper above,
 *  duplicated locally so the disk block reads standalone). */
const diskHasNoLoneLf = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a && s.charCodeAt(i - 1) !== 0x0d) return false
  }
  return true
}

describe("editTool — real-FS disk round-trip preserves CRLF via the FUZZY rung (T-D6)", () => {
  test("a whitespace-approx fuzzy edit on a CRLF file leaves it uniformly CRLF", async () => {
    const f = join(diskDir, "crlf-source.ts")
    // A genuine CRLF file on disk (the bytes carry `\r\n` terminators).
    const original = "function f() {\r\n      return    a +  b\r\n}\r\n"
    writeFileSync(f, original)
    // Sanity: the file is CRLF on disk before we touch it.
    expect(readFileSync(f, "utf8")).toBe(original)

    // `old_string` differs from the on-disk line by INTERNAL whitespace and is
    // typed with LF — so the EXACT rung cannot match and the FUZZY rung (the one
    // that had the D6 bug) is what applies. `fuzzy:true` is required to engage it.
    const r = await runEdit(
      { path: f, old_string: "return a + b", new_string: "return a - b", fuzzy: true },
      diskDir,
    )
    expect(r.ok).toBe(true)
    // The success message proves a NON-exact (whitespace-flex/anchored-trim) rung
    // engaged — i.e. the rung that carried the corruption bug.
    expect(r.output).toMatch(/whitespace-flexible|anchored-trim/)

    // Re-read the bytes from DISK (the real modality) and assert no corruption.
    const after = readFileSync(f, "utf8")
    expect(diskHasNoLoneLf(after)).toBe(true) // uniformly CRLF, no lone-LF
    expect(after).toBe("function f() {\r\nreturn a - b\r\n}\r\n") // edit applied
  })

  test("an LF file edited the same way stays uniformly LF on disk (no CRLF introduced)", async () => {
    const f = join(diskDir, "lf-source.ts")
    const original = "function f() {\n      return    a +  b\n}\n"
    writeFileSync(f, original)
    const r = await runEdit(
      { path: f, old_string: "return a + b", new_string: "return a - b", fuzzy: true },
      diskDir,
    )
    expect(r.ok).toBe(true)
    const after = readFileSync(f, "utf8")
    // No CR was introduced — the LF file stays LF.
    expect(after.includes("\r")).toBe(false)
    expect(after).toBe("function f() {\nreturn a - b\n}\n")
  })
})
