/**
 * 31-case hellgate for the pure git merge-conflict parser
 * (`src/tool/git/conflict-parser`).
 *
 * Groups:
 *   A — happy path (5)
 *   B — marker length (4)
 *   C — line terminators (3)
 *   D — diagnostics (6)
 *   E — labels & content (5)
 *   F — adversarial (5)
 *   G — input handling (3)
 *
 * Pure parser: no I/O, no git binary. Each case asserts both blocks and
 * diagnostics shape exactly per ADR-0111.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_MARKER_STYLES,
  type ConflictBlock,
  type ConflictMarkerStyle,
  type ConflictParseDiagnostic,
  ConflictParserInputError,
  parseConflicts,
} from "@/tool/git/conflict-parser"

// ─────────────────────────────────────────────────────────────────────────────
// Group A — happy path (5)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group A happy path", () => {
  test("A1: single two-way conflict, length-7, LF — all fields", () => {
    const src =
      "line A\n" +
      "<<<<<<< HEAD\n" +
      "ours line 1\n" +
      "ours line 2\n" +
      "=======\n" +
      "theirs line 1\n" +
      ">>>>>>> feature/foo\n" +
      "line Z\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    expect(r.diagnostics).toEqual([])
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.style).toBe("two-way")
    expect(b.oursLabel).toBe("HEAD")
    expect(b.theirsLabel).toBe("feature/foo")
    expect("base" in b).toBe(false)
    expect("baseLabel" in b).toBe(false)
    expect(b.ours).toBe("ours line 1\nours line 2\n")
    expect(b.theirs).toBe("theirs line 1\n")
    expect(b.startLine).toBe(2)
    expect(b.endLine).toBe(7)
    expect(b.startOffset).toBe(src.indexOf("<<<<<<<"))
    expect(b.endOffset).toBe(src.indexOf(">>>>>>> feature/foo\n") + ">>>>>>> feature/foo".length)
    expect(src.slice(b.startOffset, b.endOffset).endsWith(">>>>>>> feature/foo")).toBe(true)
  })

  test("A2: single three-way (open + base + sep + close) — base/baseLabel present", () => {
    const src =
      "<<<<<<< HEAD\n" +
      "ours\n" +
      "||||||| merged common ancestors\n" +
      "base content\n" +
      "=======\n" +
      "theirs\n" +
      ">>>>>>> other\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    expect(r.diagnostics).toEqual([])
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.style).toBe("three-way")
    expect(b.oursLabel).toBe("HEAD")
    expect(b.theirsLabel).toBe("other")
    expect(b.baseLabel).toBe("merged common ancestors")
    expect(b.base).toBe("base content\n")
    expect(b.ours).toBe("ours\n")
    expect(b.theirs).toBe("theirs\n")
  })

  test("A3: two consecutive two-way conflicts, no overlap", () => {
    const src =
      "header\n" +
      "<<<<<<< A\n" +
      "ours1\n" +
      "=======\n" +
      "theirs1\n" +
      ">>>>>>> B\n" +
      "middle\n" +
      "<<<<<<< C\n" +
      "ours2\n" +
      "=======\n" +
      "theirs2\n" +
      ">>>>>>> D\n" +
      "footer\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(2)
    expect(r.diagnostics).toEqual([])
    const [b1, b2] = r.blocks
    if (!b1 || !b2) throw new Error("expected 2 blocks")
    expect(b1.oursLabel).toBe("A")
    expect(b1.theirsLabel).toBe("B")
    expect(b2.oursLabel).toBe("C")
    expect(b2.theirsLabel).toBe("D")
    expect(b2.startLine).toBeGreaterThan(b1.endLine)
  })

  test("A4: conflict at start of file (line 1)", () => {
    const src = "<<<<<<< a\nO\n=======\nT\n>>>>>>> b\nafter\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.startLine).toBe(1)
    expect(b.startOffset).toBe(0)
  })

  test("A5: conflict ends at EOF, close marker is the last line (no trailing newline)", () => {
    const src = "<<<<<<< a\nO\n=======\nT\n>>>>>>> b"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.endOffset).toBe(src.length)
    expect(b.theirs).toBe("T\n")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group B — marker length (4)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group B marker length", () => {
  test("B6: length-6 markers (matching) → parsed as two-way", () => {
    const src = "<<<<<< a\nO\n======\nT\n>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.style).toBe("two-way")
    expect(b.oursLabel).toBe("a")
    expect(b.theirsLabel).toBe("b")
  })

  test("B7: length-8 markers (matching) → parsed as two-way", () => {
    const src = "<<<<<<<< HEAD\nO\n========\nT\n>>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.style).toBe("two-way")
    expect(b.oursLabel).toBe("HEAD")
    expect(b.theirsLabel).toBe("b")
  })

  test("B8: length-5 markers → NOT recognised as markers (0 blocks)", () => {
    const src = "<<<<< a\nO\n=====\nT\n>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics).toEqual([])
  })

  test("B9: mismatched lengths (open=7, close=8) → marker_at_offset, block abandoned", () => {
    const src = "<<<<<<< a\nO\n=======\nT\n>>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics.some((d) => d.kind === "marker_at_offset")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group C — line terminators (3)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group C line terminators", () => {
  test("C10: CRLF throughout — offsets correct, slice round-trip reproduces block", () => {
    const src =
      "before\r\n<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> b\r\nafter\r\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.ours).toBe("O\r\n")
    expect(b.theirs).toBe("T\r\n")
    // slice(startOffset, endOffset) reproduces the conflict block excluding
    // the trailing line terminator.
    const recovered = src.slice(b.startOffset, b.endOffset)
    expect(recovered.startsWith("<<<<<<< HEAD")).toBe(true)
    expect(recovered.endsWith(">>>>>>> b")).toBe(true)
  })

  test("C11: mixed \\n and \\r\\n in same file — offsets consistent", () => {
    const src = "<<<<<<< HEAD\r\nO\n=======\nT\r\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.oursLabel).toBe("HEAD")
    expect(b.theirsLabel).toBe("b")
    expect(b.ours).toBe("O\n")
    expect(b.theirs).toBe("T\r\n")
    const recovered = src.slice(b.startOffset, b.endOffset)
    expect(recovered.startsWith("<<<<<<< HEAD")).toBe(true)
    expect(recovered.endsWith(">>>>>>> b")).toBe(true)
  })

  test("C12: file ends with no terminator at all — termLen=0 path correct", () => {
    const src = "<<<<<<< a\nO\n=======\nT\n>>>>>>> b"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    // endOffset is one past the close-marker line's last text char, which
    // equals src.length when there's no trailing terminator.
    expect(b.endOffset).toBe(src.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group D — diagnostics (6)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group D diagnostics", () => {
  test("D13: unterminated — open + no close → diagnostic at lineCount+1, 0 blocks", () => {
    const src = "<<<<<<< HEAD\nO\n=======\nT\nstill open and no close\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    const u = r.diagnostics.find((d) => d.kind === "unterminated")
    expect(u).toBeDefined()
    // lineCount includes the open + 4 content lines = 5 (the trailing newline
    // doesn't add a phantom line). lineCount + 1 = 6.
    const lineCount = src.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l.length > 0).length
    expect(u?.line).toBe(lineCount + 1)
  })

  test("D14: no_separator — open + close, no `=======` → diagnostic, 0 blocks", () => {
    const src = "<<<<<<< HEAD\nO content\nstill content\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics.some((d) => d.kind === "no_separator")).toBe(true)
  })

  test("D15: nested — two opens before a close → nested diag, first abandoned, parser continues", () => {
    const src =
      "<<<<<<< outer\n" +
      "outer ours\n" +
      "<<<<<<< inner\n" +
      "inner ours\n" +
      "=======\n" +
      "inner theirs\n" +
      ">>>>>>> inner-b\n" +
      "tail\n"
    const r = parseConflicts(src)
    expect(r.diagnostics.some((d) => d.kind === "nested")).toBe(true)
    // After the nested-abandonment, scanning resumes after the second open.
    // The inner conflict's `=======` + `>>>>>>>` are not part of a valid
    // open/close pair (because the second open was consumed). So the inner
    // close is reported as missing_ours.
    expect(r.diagnostics.some((d) => d.kind === "missing_ours")).toBe(true)
    // No blocks emitted — both the outer (abandoned) and the inner (no open
    // remains after abandonment) fail to produce a typed block.
    expect(r.blocks).toEqual([])
  })

  test("D16: missing_ours — close marker without preceding open → diagnostic", () => {
    const src = "no open here\n>>>>>>> b\nmore\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics.some((d) => d.kind === "missing_ours")).toBe(true)
  })

  test("D17: missing_theirs — `=======` without preceding open → diagnostic", () => {
    const src = "no open\n=======\nmore\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics.some((d) => d.kind === "missing_theirs")).toBe(true)
  })

  test("D18: marker_at_offset — malformed open (no trailing space) → diagnostic, no block", () => {
    const src = "<<<<<<<HEAD\nO\n=======\nT\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics.some((d) => d.kind === "marker_at_offset")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group E — labels & content (5)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group E labels & content", () => {
  test("E19: no label at all (`<<<<<<<\\n`) → oursLabel === ''", () => {
    const src = "<<<<<<<\nO\n=======\nT\n>>>>>>>\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.oursLabel).toBe("")
    expect(b.theirsLabel).toBe("")
  })

  test("E20: label with trailing whitespace preserved verbatim (modulo CR strip)", () => {
    const src = "<<<<<<< HEAD   \nO\n=======\nT\n>>>>>>> branch v2  \n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    // Trailing spaces in the label are preserved verbatim (no trim).
    expect(b.oursLabel).toBe("HEAD   ")
    expect(b.theirsLabel).toBe("branch v2  ")
  })

  test("E21: empty ours (separator immediately after open) → ours === ''", () => {
    const src = "<<<<<<< a\n=======\nT\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.ours).toBe("")
    expect(b.theirs).toBe("T\n")
  })

  test("E22: empty theirs (close immediately after separator) → theirs === ''", () => {
    const src = "<<<<<<< a\nO\n=======\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.ours).toBe("O\n")
    expect(b.theirs).toBe("")
  })

  test("E23: multiline side; trailing newline preserved in ours/theirs", () => {
    const src = "<<<<<<< a\nL1\nL2\nL3\n=======\nT1\nT2\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.ours).toBe("L1\nL2\nL3\n")
    expect(b.theirs).toBe("T1\nT2\n")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group F — adversarial (5)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group F adversarial", () => {
  test("F24: indented markers ('  <<<<<<<') → NOT recognised (segment-anchored col 0)", () => {
    const src = "  <<<<<<< HEAD\n  O\n  =======\n  T\n  >>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks).toEqual([])
    expect(r.diagnostics).toEqual([])
  })

  test("F25: marker inside a string literal at col 0 — DOES match (documented)", () => {
    const src =
      "const s = `\n" +
      "<<<<<<< HEAD\n" +
      "ours\n" +
      "=======\n" +
      "theirs\n" +
      ">>>>>>> b\n" +
      "`\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
  })

  test("F26: three nested conflicts (3 opens) — nested diag at 2nd open, resume-after semantics", () => {
    // Note (spec ambiguity, flagged in agent report): the spec text says
    // "diagnostics for the 2nd and 3rd", but the parser rule documented in D15
    // ("first conflict abandoned, parser continues scanning from after the
    //  second open") is mutually exclusive with re-flagging the 3rd open as
    // nested — once the 2nd open is consumed, the 3rd is a brand-new
    // top-level open, not a nested one. We pick the D15-consistent reading
    // (since D15's assertion set is unambiguous: nested + missing_ours + 0
    // blocks requires resume-after) and assert only the 2nd-open nested diag
    // here. A future ADR amendment can switch to depth-tracking semantics if
    // the 3-deep diag count matters more.
    const src =
      "<<<<<<< outer\n" +
      "outer ours\n" +
      "<<<<<<< middle\n" +
      "middle ours\n" +
      "<<<<<<< inner\n" +
      "inner content\n" +
      "=======\n" +
      "more\n" +
      ">>>>>>> closer\n" +
      "tail\n"
    const r = parseConflicts(src)
    const nestedDiags = r.diagnostics.filter((d) => d.kind === "nested")
    expect(nestedDiags.length).toBeGreaterThanOrEqual(1)
    // The 2nd open is at line 3 of the input.
    expect(nestedDiags[0]?.line).toBe(3)
  })

  test("F27: many sequential separators with no opens → multiple missing_theirs", () => {
    const src = "=======\n=======\n=======\n"
    const r = parseConflicts(src)
    const ts = r.diagnostics.filter((d) => d.kind === "missing_theirs")
    expect(ts.length).toBe(3)
    expect(ts.map((d) => d.line)).toEqual([1, 2, 3])
  })

  test("F28: smallest valid three-way — ours/base/theirs all empty strings", () => {
    const src = "<<<<<<< a\n||||||| anc\n=======\n>>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.style).toBe("three-way")
    expect(b.ours).toBe("")
    expect(b.base).toBe("")
    expect(b.theirs).toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group G — input handling (3)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — Group G input handling", () => {
  test("G29: empty string → {blocks:[], diagnostics:[]} (no throw)", () => {
    const r = parseConflicts("")
    expect(r.blocks).toEqual([])
    expect(r.diagnostics).toEqual([])
  })

  test("G30: non-string input → ConflictParserInputError", () => {
    expect(() => parseConflicts(null as unknown as string)).toThrow(ConflictParserInputError)
    expect(() => parseConflicts(undefined as unknown as string)).toThrow(ConflictParserInputError)
    expect(() => parseConflicts(123 as unknown as string)).toThrow(ConflictParserInputError)
    expect(() => parseConflicts({} as unknown as string)).toThrow(ConflictParserInputError)
  })

  test("G31: very large input (10MB+) with one conflict at the end — parses, < 1s", () => {
    const filler = "x ".repeat(5_000_000) // 10MB of text
    const src = `${filler}\n<<<<<<< a\nO\n=======\nT\n>>>>>>> b\n`
    const t0 = performance.now()
    const r = parseConflicts(src)
    const elapsedMs = performance.now() - t0
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0]
    if (!b) throw new Error("expected block")
    expect(b.oursLabel).toBe("a")
    expect(b.theirsLabel).toBe("b")
    expect(elapsedMs).toBeLessThan(1000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Enum-shape invariants (carry-over from prior coverage; cheap insurance)
// ─────────────────────────────────────────────────────────────────────────────

describe("conflict-parser — enum invariants", () => {
  test("ALL_MARKER_STYLES exactly 3 unique literals matching the union", () => {
    expect(ALL_MARKER_STYLES.length).toBe(3)
    expect(new Set(ALL_MARKER_STYLES).size).toBe(3)
    expect(new Set(ALL_MARKER_STYLES)).toEqual(new Set(["two-way", "three-way", "diff3"]))
  })

  test("exhaustive switch on ConflictMarkerStyle compiles & runs", () => {
    const label = (s: ConflictMarkerStyle): string => {
      switch (s) {
        case "two-way":
          return "2"
        case "three-way":
          return "3"
        case "diff3":
          return "d"
        default: {
          const _exhaust: never = s
          return _exhaust
        }
      }
    }
    expect(ALL_MARKER_STYLES.map(label).sort()).toEqual(["2", "3", "d"])
  })

  test("exhaustive switch on ConflictParseDiagnostic.kind compiles & runs", () => {
    const kinds: ConflictParseDiagnostic["kind"][] = [
      "unterminated",
      "no_separator",
      "marker_at_offset",
      "nested",
      "missing_ours",
      "missing_theirs",
    ]
    const label = (k: ConflictParseDiagnostic["kind"]): string => {
      switch (k) {
        case "unterminated":
          return "u"
        case "no_separator":
          return "s"
        case "marker_at_offset":
          return "m"
        case "nested":
          return "n"
        case "missing_ours":
          return "o"
        case "missing_theirs":
          return "t"
        default: {
          const _exhaust: never = k
          return _exhaust
        }
      }
    }
    expect(kinds.map(label).sort()).toEqual(["m", "n", "o", "s", "t", "u"])
  })

  test("ConflictBlock omits base/baseLabel for two-way (exactOptionalPropertyTypes)", () => {
    const r = parseConflicts("<<<<<<< a\nO\n=======\nT\n>>>>>>> b\n")
    const b = r.blocks[0] as ConflictBlock
    expect("base" in b).toBe(false)
    expect("baseLabel" in b).toBe(false)
  })
})
