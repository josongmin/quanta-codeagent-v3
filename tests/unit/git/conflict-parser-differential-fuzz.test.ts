/**
 * Differential fuzz for the CANONICAL git merge-conflict parser
 * (`@/git` → `src/git/conflict-parser.ts`, `parseConflicts`).
 *
 * The T13 SSOT promotion of this parser was previously validated only on the
 * ~8 hand cases in `conflict-parser.test.ts` + the tool layer's own suite.
 * This battery hardens that by:
 *
 *   PART 1 — REAL GIT GROUND TRUTH. We drive Git's xdiff engine through
 *     `git merge-file` over base/ours/theirs inputs, then assert
 *     `parseConflicts` matches what Git emitted (block count, style, split,
 *     labels, marker offsets). Run for BOTH `merge.conflictStyle=merge`
 *     (two-way) and `=diff3` (three-way), across many randomized line shapes,
 *     CRLF/LF, unicode labels, and EOF-without-trailing-newline.
 *
 *   PART 2 — CONSTRUCTED ADVERSARIAL. Shapes git won't emit but a real file
 *     can contain (after hand-editing, bad tooling, partial resolution):
 *     mismatched marker lengths 7..12, markers at EOF w/o newline,
 *     nested / unterminated / missing-separator, multiple sequential blocks,
 *     near-miss runs shorter than the marker minimum. We assert the parser's
 *     documented invariants and that it ALWAYS degrades typed (diagnostics,
 *     never throws) — per ADR-0111 / the SSOT contract.
 *
 * Determinism: a seeded SplitMix32 PRNG (NO Math.random / Date.now). Each case
 * derives its randomness from a fixed base seed XORed with the case index, so
 * the corpus is byte-stable across runs and CI.
 */

import { describe, expect, test } from "bun:test"
import { type ConflictBlock, parseConflicts } from "@/git"
import { CANARY_INDICES } from "./conflict-parser-fuzz-cases"
import {
  contentLine,
  type Rng,
  registerRealGitConflictTests,
  rngFor,
  UNICODE_LABELS,
} from "./conflict-parser-fuzz-runtime"

const assertSequentialBlocks = (
  blocks: readonly ConflictBlock[],
  expected: ReadonlyArray<{ ours: string; theirs: string }>,
  count: number,
): void => {
  expect(blocks.length).toBe(count)
  for (let index = 0; index < count; index++) {
    const block = blocks[index]
    const expectedBlock = expected[index]
    if (!block || !expectedBlock) throw new Error("missing expected block")
    expect(block.ours).toBe(expectedBlock.ours)
    expect(block.theirs).toBe(expectedBlock.theirs)
  }
  for (let index = 1; index < count; index++) {
    const previous = blocks[index - 1]
    const current = blocks[index]
    if (!previous || !current) throw new Error("missing sequential block")
    expect(current.startOffset).toBeGreaterThan(previous.endOffset)
  }
}

registerRealGitConflictTests(
  "conflict-parser differential fuzz — PR real-git canary",
  CANARY_INDICES,
  4,
)

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — CONSTRUCTED ADVERSARIAL (shapes git won't emit but files contain)
// ─────────────────────────────────────────────────────────────────────────────

const MARK = (ch: string, n: number) => ch.repeat(n)

/** Build a single well-formed two-way block with a chosen marker length. */
const twoWayBlock = (
  rng: Rng,
  runLen: number,
  eol: string,
): { text: string; oursLabel: string; theirsLabel: string; ours: string; theirs: string } => {
  const oursLabel = rng.pick(UNICODE_LABELS)
  const theirsLabel = rng.pick(UNICODE_LABELS)
  const oursLines = [`o-${contentLine(rng)}`, `o2-${contentLine(rng)}`]
  const theirsLines = [`t-${contentLine(rng)}`]
  const open = oursLabel === "" ? MARK("<", runLen) : `${MARK("<", runLen)} ${oursLabel}`
  const close = theirsLabel === "" ? MARK(">", runLen) : `${MARK(">", runLen)} ${theirsLabel}`
  const lines = [open, ...oursLines, MARK("=", runLen), ...theirsLines, close]
  return {
    text: lines.join(eol) + eol,
    oursLabel,
    theirsLabel,
    ours: oursLines.join(eol) + eol,
    theirs: theirsLines.join(eol) + eol,
  }
}

describe("conflict-parser differential fuzz — PART 2: constructed adversarial", () => {
  // ── 2a. Matched marker lengths 7..12 (and the documented length-6 tolerance) ──
  for (let idx = 0; idx < 24; idx++) {
    test(`L${idx}: matched marker length parses, ours/theirs split exact`, () => {
      const rng = rngFor(1000 + idx)
      const runLen = rng.between(7, 12)
      const eol = rng.bool() ? "\r\n" : "\n"
      const blk = twoWayBlock(rng, runLen, eol)
      const r = parseConflicts(blk.text)
      expect(r.diagnostics).toEqual([])
      expect(r.blocks.length).toBe(1)
      const b = r.blocks[0] as ConflictBlock
      expect(b.style).toBe("two-way")
      expect(b.oursLabel).toBe(blk.oursLabel)
      expect(b.theirsLabel).toBe(blk.theirsLabel)
      expect(b.ours).toBe(blk.ours)
      expect(b.theirs).toBe(blk.theirs)
      // Reproduce verbatim via offsets.
      expect(blk.text.slice(b.startOffset, b.endOffset).startsWith(MARK("<", runLen))).toBe(true)
    })
  }

  test("length-6 tolerance: a matched length-6 pair parses (documented < git's 7)", () => {
    // INTENTIONAL TOLERANCE: MIN_MARKER_RUN=6 in conflict-parser.ts (one below
    // git's 7) to keep a legacy B6 hand-case green. Real git never emits a
    // length-6 run, so this is purely a tolerance — assert + comment, do NOT
    // "fix" the parser to reject it.
    const src = "<<<<<< a\nx\n======\ny\n>>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    expect(r.diagnostics).toEqual([])
    const b = r.blocks[0] as ConflictBlock
    expect(b.oursLabel).toBe("a")
    expect(b.theirsLabel).toBe("b")
  })

  test("length-5 is below the marker minimum → plain text, no block", () => {
    const src = "<<<<< a\nx\n=====\ny\n>>>>> b\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics).toEqual([])
  })

  // ── 2b. Mismatched open/close lengths → length-mismatch diagnostic, no block ──
  for (let idx = 0; idx < 16; idx++) {
    test(`M${idx}: mismatched open/close marker length → typed diag, no block`, () => {
      const rng = rngFor(2000 + idx)
      const openLen = rng.between(7, 11)
      let closeLen = rng.between(7, 12)
      if (closeLen === openLen) closeLen = openLen + 1
      const eol = rng.bool() ? "\r\n" : "\n"
      const src =
        `${MARK("<", openLen)} HEAD${eol}` +
        `ours${eol}` +
        `${MARK("=", openLen)}${eol}` +
        `theirs${eol}` +
        `${MARK(">", closeLen)} feat${eol}`
      const r = parseConflicts(src)
      // Length mismatch on close → block abandoned, marker_at_offset diagnostic.
      expect(r.blocks.length).toBe(0)
      expect(r.diagnostics.length).toBeGreaterThanOrEqual(1)
      expect(r.diagnostics.some((d) => d.kind === "marker_at_offset")).toBe(true)
    })
  }

  // ── 2c. Markers at EOF without a trailing newline ──
  test("E1: close marker at EOF without trailing newline parses, offset exact", () => {
    const src = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feat" // no final \n
    const r = parseConflicts(src)
    expect(r.diagnostics).toEqual([])
    expect(r.blocks.length).toBe(1)
    const b = r.blocks[0] as ConflictBlock
    expect(b.endOffset).toBe(src.length)
    expect(src.slice(b.startOffset, b.endOffset)).toBe(src)
  })

  test("E2: open marker at EOF without close → unterminated diagnostic, no block", () => {
    const src = "before\n<<<<<<< HEAD\nours-only-no-close"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics.some((d) => d.kind === "unterminated")).toBe(true)
  })

  // ── 2d. Three-way (diff3) constructed with base section ──
  for (let idx = 0; idx < 8; idx++) {
    test(`T${idx}: constructed three-way with base section parses all three`, () => {
      const rng = rngFor(3000 + idx)
      const runLen = rng.between(7, 10)
      const eol = rng.bool() ? "\r\n" : "\n"
      const baseLabel = rng.pick(["merged common ancestors", "3c6a7fa", ""])
      const src =
        `${MARK("<", runLen)} HEAD${eol}` +
        `ours-1${eol}` +
        (baseLabel === ""
          ? `${MARK("|", runLen)}${eol}`
          : `${MARK("|", runLen)} ${baseLabel}${eol}`) +
        `base-1${eol}base-2${eol}` +
        `${MARK("=", runLen)}${eol}` +
        `theirs-1${eol}` +
        `${MARK(">", runLen)} other${eol}`
      const r = parseConflicts(src)
      expect(r.diagnostics).toEqual([])
      expect(r.blocks.length).toBe(1)
      const b = r.blocks[0] as ConflictBlock
      expect(b.style).toBe("three-way")
      expect(b.ours).toBe(`ours-1${eol}`)
      expect(b.base).toBe(`base-1${eol}base-2${eol}`)
      expect(b.theirs).toBe(`theirs-1${eol}`)
      expect(b.baseLabel).toBe(baseLabel)
    })
  }

  test("T-mismatch: base marker length != open length → typed diag, no block", () => {
    const src = "<<<<<<< HEAD\nours\n|||||| base\nb\n=======\ntheirs\n>>>>>>> x\n" // base len 6 vs open 7
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics.some((d) => d.kind === "marker_at_offset")).toBe(true)
  })

  // ── 2e. Nested / missing-separator / missing-ours / missing-theirs ──
  test("N1: nested open before close → nested diagnostic", () => {
    const src = "<<<<<<< A\nx\n<<<<<<< B\ny\n=======\nz\n>>>>>>> C\n"
    const r = parseConflicts(src)
    expect(r.diagnostics.some((d) => d.kind === "nested")).toBe(true)
  })

  test("N2: open + close but no separator → no_separator diagnostic, no block", () => {
    const src = "<<<<<<< A\nx\ny\n>>>>>>> B\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics.some((d) => d.kind === "no_separator")).toBe(true)
  })

  test("N3: bare close marker with no open → missing_ours diagnostic", () => {
    const src = "plain\n>>>>>>> B\nmore\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics.some((d) => d.kind === "missing_ours")).toBe(true)
  })

  test("N4: bare separator with no open → missing_theirs diagnostic", () => {
    const src = "plain\n=======\nmore\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(0)
    expect(r.diagnostics.some((d) => d.kind === "missing_theirs")).toBe(true)
  })

  // ── 2f. Multiple sequential blocks ──
  for (let idx = 0; idx < 12; idx++) {
    test(`S${idx}: N sequential valid blocks all parsed, in order`, () => {
      const rng = rngFor(4000 + idx)
      const n = rng.between(2, 5)
      const eol = rng.bool() ? "\r\n" : "\n"
      const parts: string[] = [`prologue${eol}`]
      const expected: Array<{ ours: string; theirs: string }> = []
      for (let k = 0; k < n; k++) {
        const runLen = rng.between(7, 9)
        const blk = twoWayBlock(rng, runLen, eol)
        parts.push(blk.text)
        parts.push(`gap-${k}${eol}`)
        expected.push({ ours: blk.ours, theirs: blk.theirs })
      }
      const src = parts.join("")
      const r = parseConflicts(src)
      expect(r.diagnostics).toEqual([])
      // Blocks must be strictly increasing in offset.
      assertSequentialBlocks(r.blocks, expected, n)
    })
  }

  // ── 2g. Mixed valid + malformed in one file: valid blocks survive ──
  test("MIX: a valid block then a malformed open → one block + one diag", () => {
    const src =
      "<<<<<<< A\no\n=======\nt\n>>>>>>> B\n" + // valid
      "<<<<<<<HEAD\n" + // malformed open (no space before label)
      "junk\n"
    const r = parseConflicts(src)
    expect(r.blocks.length).toBe(1)
    expect(r.diagnostics.some((d) => d.kind === "marker_at_offset")).toBe(true)
  })

  const assertNoiseParse = (source: string): void => {
    const result = parseConflicts(source)
    for (const block of result.blocks) {
      const slice = source.slice(block.startOffset, block.endOffset)
      expect(slice.startsWith("<")).toBe(true)
      expect(slice.includes(">>>")).toBe(true)
      expect(block.endOffset).toBeGreaterThan(block.startOffset)
      expect(block.endLine).toBeGreaterThanOrEqual(block.startLine)
      expect("base" in block).toBe(block.style !== "two-way")
    }
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.line).toBeGreaterThanOrEqual(1)
      expect(typeof diagnostic.message).toBe("string")
      expect(diagnostic.message.length).toBeGreaterThan(0)
    }
  }

  // ── 2h. Pure fuzz: arbitrary marker-ish noise must NEVER throw ──
  for (let idx = 0; idx < 80; idx++) {
    test(`F${idx}: arbitrary marker-noise input degrades typed, never throws`, () => {
      const rng = rngFor(5000 + idx)
      const lineCount = rng.between(0, 14)
      const lines: string[] = []
      const tokens = [
        () => MARK("<", rng.between(3, 13)) + (rng.bool() ? ` ${rng.pick(UNICODE_LABELS)}` : ""),
        () => MARK(">", rng.between(3, 13)) + (rng.bool() ? ` ${rng.pick(UNICODE_LABELS)}` : ""),
        () => MARK("=", rng.between(3, 13)) + (rng.bool() ? "tail" : ""),
        () => MARK("|", rng.between(3, 13)) + (rng.bool() ? ` ${rng.pick(UNICODE_LABELS)}` : ""),
        () => contentLine(rng),
        () => `<<<<<<<${rng.pick(UNICODE_LABELS)}`, // malformed (no space)
      ]
      for (let k = 0; k < lineCount; k++) lines.push(rng.pick(tokens)())
      const eol = rng.bool() ? "\r\n" : "\n"
      const trailing = rng.bool() ? eol : ""
      const src = lines.join(eol) + trailing

      assertNoiseParse(src)
    })
  }

  // ── 2i. Non-string input is the ONLY throw path ──
  test("non-string input throws ConflictParserInputError (only throw path)", () => {
    // @ts-expect-error deliberate misuse
    expect(() => parseConflicts(null)).toThrow()
    // @ts-expect-error deliberate misuse
    expect(() => parseConflicts(123)).toThrow()
  })
})
