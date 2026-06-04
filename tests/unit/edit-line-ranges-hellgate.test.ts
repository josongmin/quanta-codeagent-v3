import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import { applyExactEdit } from "../../src/tool/edit/exact"
import { applyFuzzyEdit } from "../../src/tool/edit/fuzzy"
import {
  inRangeMatchOffsets,
  lineAt,
  lineCount,
  validateLineRanges,
} from "../../src/tool/edit/line-range"

/**
 * H12 hellgate — `line_ranges`-scoped str_replace. Adversarial proof that a
 * repeated anchor is deterministically addressable by a 1-indexed inclusive
 * line window, that every degenerate range is a CLEAN typed failure (never a
 * wrong-location edit, never a throw), and that the absent-line_ranges path is
 * byte-identical to legacy — including the existing ambiguous-failure behavior,
 * which now also carries the file's line count.
 */

const dir = mkdtempSync(join(tmpdir(), "edit-lr-hell-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// A file with FIVE identical `target` lines, one per 10-line block, so each
// occurrence sits on a known, distinct line.
const buildRepeated = (): string => {
  const lines: string[] = []
  for (let block = 0; block < 5; block++) {
    lines.push(`// block ${block}`)
    lines.push("target")
    for (let f = 0; f < 8; f++) lines.push(`filler ${block}-${f}`)
  }
  return lines.join("\n")
}

describe("H12 line-range pure helpers", () => {
  test("lineAt is 1-indexed and counts newlines up to the offset", () => {
    const src = "a\nb\nc"
    expect(lineAt(src, 0)).toBe(1) // 'a'
    expect(lineAt(src, 2)).toBe(2) // 'b'
    expect(lineAt(src, 4)).toBe(3) // 'c'
  })

  test("lineCount counts the trailing partial line (no trailing newline)", () => {
    expect(lineCount("")).toBe(1)
    expect(lineCount("a")).toBe(1)
    expect(lineCount("a\nb")).toBe(2)
    expect(lineCount("a\nb\n")).toBe(3) // trailing empty line is real
  })

  test("inRangeMatchOffsets returns only offsets whose first char is in range", () => {
    const src = "x\nx\nx" // 'x' on lines 1, 2, 3 at offsets 0, 2, 4
    expect(inRangeMatchOffsets(src, "x", [{ start: 2, end: 2 }])).toEqual([2])
    expect(inRangeMatchOffsets(src, "x", [{ start: 1, end: 3 }])).toEqual([0, 2, 4])
    expect(inRangeMatchOffsets(src, "x", [{ start: 9, end: 9 }])).toEqual([])
  })

  test("validateLineRanges rejects inverted / negative / non-integer, accepts good", () => {
    expect(validateLineRanges([{ start: 1, end: 3 }]).ok).toBe(true)
    expect(validateLineRanges([{ start: 5, end: 2 }]).ok).toBe(false) // inverted
    expect(validateLineRanges([{ start: 0, end: 3 }]).ok).toBe(false) // start < 1
    expect(validateLineRanges([{ start: -2, end: 3 }]).ok).toBe(false) // negative
    expect(validateLineRanges([{ start: 1.5, end: 3 }]).ok).toBe(false) // non-integer
  })
})

describe("H12 applyExactEdit — range scoping picks exactly one of N identical", () => {
  test("range containing exactly ONE of 5 identical anchors → edits that one only", () => {
    const src = buildRepeated()
    // block 2's `target` is the 3rd occurrence. Each block is 10 lines: block b
    // starts at line 10*b+1, its `target` is line 10*b+2. Block 2 → line 22.
    const r = applyExactEdit(src, "target", "PICKED", false, [{ start: 21, end: 23 }])
    expect(r.ok).toBe(true)
    expect((r.next as string).split("PICKED").length - 1).toBe(1) // exactly one swap
    // The OTHER four occurrences are untouched.
    expect((r.next as string).split("\ntarget").length - 1).toBe(4)
  })

  test("range containing ZERO matches but anchor present elsewhere → clean not-found", () => {
    const src = buildRepeated()
    const r = applyExactEdit(src, "target", "X", false, [{ start: 100, end: 200 }])
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.kind).toBe("not-found")
    expect(r.message).toContain("NONE within")
  })

  test("anchor not in file at all → not-found (range present)", () => {
    const r = applyExactEdit("a\nb\nc", "zzz", "X", false, [{ start: 1, end: 3 }])
    expect(r.ok).toBe(false)
    expect(r.kind).toBe("not-found")
  })

  test("range containing >1 match without replace_all → still ambiguous (clean fail)", () => {
    const src = buildRepeated()
    // A wide range spanning blocks 1 and 2 contains TWO `target` lines.
    const r = applyExactEdit(src, "target", "X", false, [{ start: 11, end: 23 }])
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.kind).toBe("ambiguous")
  })

  test("range containing >1 match WITH replace_all → replaces all in-range only", () => {
    const src = buildRepeated()
    const r = applyExactEdit(src, "target", "X", true, [{ start: 11, end: 23 }])
    expect(r.ok).toBe(true)
    expect((r.next as string).split("X").length - 1).toBe(2) // the 2 in-range
    expect((r.next as string).split("\ntarget").length - 1).toBe(3) // the 3 out-of-range survive
  })

  test("MULTIPLE line_ranges union: two windows each holding one anchor → 2 with replace_all", () => {
    const src = buildRepeated()
    const r = applyExactEdit(src, "target", "X", true, [
      { start: 1, end: 3 }, // block 0 target (line 2)
      { start: 41, end: 43 }, // block 4 target (line 42)
    ])
    expect(r.ok).toBe(true)
    expect((r.next as string).split("X").length - 1).toBe(2)
  })

  test("multiple ranges that select exactly one anchor total → deterministic single edit", () => {
    const src = buildRepeated()
    const r = applyExactEdit(src, "target", "ONE", false, [
      { start: 31, end: 33 }, // block 3 target (line 32) — the only one
      { start: 100, end: 110 }, // empty window
    ])
    expect(r.ok).toBe(true)
    expect((r.next as string).split("ONE").length - 1).toBe(1)
  })
})

describe("H12 absent line_ranges ⇒ byte-identical legacy", () => {
  test("undefined ranges → same result as the 4-arg call", () => {
    const src = "const a = 1"
    const legacy = applyExactEdit(src, "1", "2", false)
    const scoped = applyExactEdit(src, "1", "2", false, undefined)
    expect(scoped).toEqual(legacy)
  })

  test("empty ranges array ⇒ whole-file search (NOT treated as 'matches nothing')", () => {
    const src = "const a = 1"
    const r = applyExactEdit(src, "1", "2", false, [])
    expect(r.ok).toBe(true)
    expect(r.next).toBe("const a = 2")
  })

  test("unscoped ambiguous still fails ambiguous (legacy invariant preserved)", () => {
    const r = applyExactEdit("a a a", "a", "b", false)
    expect(r.ok).toBe(false)
    expect(r.kind).toBe("ambiguous")
  })

  test("fuzzy path: undefined ranges is byte-identical to legacy fuzzy", () => {
    const src = "  hello  world\nfoo"
    const legacy = applyFuzzyEdit(src, "hello world", "HI", false)
    const scoped = applyFuzzyEdit(src, "hello world", "HI", false, undefined)
    expect(scoped).toEqual(legacy)
  })
})

describe("H12 fuzzy ladder respects line_ranges prefilter", () => {
  test("whitespace-flexible match scoped to a window picks the in-range occurrence", () => {
    // Two whitespace-variant copies of the same line; scope to the second.
    const src = ["  alpha   beta", "x", "x", "x", "alpha beta"].join("\n")
    const r = applyFuzzyEdit(src, "alpha beta", "Z", false, [{ start: 5, end: 5 }])
    expect(r.ok).toBe(true)
    expect((r.next as string).includes("Z")).toBe(true)
    // The line-1 variant (leading spaces / internal run) is untouched.
    expect((r.next as string).split("\n")[0]).toBe("  alpha   beta")
  })

  test("fuzzy scoped to a window with zero candidates → no confident match", () => {
    const src = ["  alpha   beta", "x", "x"].join("\n")
    const r = applyFuzzyEdit(src, "alpha beta", "Z", false, [{ start: 3, end: 3 }])
    expect(r.ok).toBe(false)
  })
})

describe("H12 editTool — typed failures, no throw, line-count hint", () => {
  test("malformed range (start > end) → rejected, file untouched, no throw", async () => {
    const f = join(dir, "inverted.txt")
    writeFileSync(f, "target\ntarget")
    const r = await run({
      path: f,
      old_string: "target",
      new_string: "X",
      line_ranges: [{ start: 9, end: 2 }],
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    expect(readFileSync(f, "utf8")).toBe("target\ntarget") // untouched
  })

  test("negative range → rejected, no throw, file untouched", async () => {
    const f = join(dir, "negative.txt")
    writeFileSync(f, "target\ntarget")
    const r = await run({
      path: f,
      old_string: "target",
      new_string: "X",
      line_ranges: [{ start: -3, end: 2 }],
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    expect(readFileSync(f, "utf8")).toBe("target\ntarget")
  })

  test("out-of-bounds range → clean not_found failure, no edit", async () => {
    const f = join(dir, "oob.txt")
    writeFileSync(f, "target\ntarget\ntarget")
    const r = await run({
      path: f,
      old_string: "target",
      new_string: "X",
      line_ranges: [{ start: 500, end: 600 }],
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("not_found")
    expect(readFileSync(f, "utf8")).toBe("target\ntarget\ntarget")
  })

  test("UNSCOPED ambiguous failure now carries the file line count for retry", async () => {
    const f = join(dir, "ambig-count.txt")
    // 3 occurrences across 3 lines → ambiguous without line_ranges.
    writeFileSync(f, "target\ntarget\ntarget")
    const r = await run({ path: f, old_string: "target", new_string: "X" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("the file has 3 lines")
    expect(readFileSync(f, "utf8")).toBe("target\ntarget\ntarget") // no edit
  })

  test("NO line_ranges on a unique edit → succeeds byte-identical to legacy", async () => {
    const f = join(dir, "unique.txt")
    writeFileSync(f, "const a = 1")
    const r = await run({ path: f, old_string: "1", new_string: "2" })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("const a = 2")
  })
})
