/**
 * HELLGATE — syntax-aware chunker (RFC jun-6-syntax-aware-chunking §6.1).
 *
 * All via `fakeParser` (canned `ParsedFile`) — NO real WASM. Pins the
 * load-bearing invariants of `chunkFileSyntactic`:
 *
 *   - NEVER splits a function mid-body (each chunk = one whole decl or a clean
 *     merge of small siblings);
 *   - oversized container splits at CHILD boundaries (each method whole);
 *   - an oversized LEAF falls to a line-window split (last resort);
 *   - tiny consecutive siblings merge up to ≤ maxLines into ONE chunk;
 *   - COVERAGE: the union of all chunk ranges == [1, lineCount] (nothing
 *     dropped — header comments / gaps attached);
 *   - non-code / unknown-lang / parse-error ⇒ BYTE-IDENTICAL to `chunkFile`
 *     (NO-THROW fallback);
 *   - default-OFF byte-identity (the syntactic path is never even reached when
 *     the caller passes an `{ok:false}` outcome — proven by equality);
 *   - determinism (same input ⇒ identical array across two runs).
 */

import { describe, expect, test } from "bun:test"
import {
  indexerChunkFile as chunkFile,
  indexerChunkFileSyntactic as chunkFileSyntactic,
  fakeParser,
  type ParsedFile,
  type ParseOutcome,
} from "@/retrieval"
import type { ChunkInput } from "@/retrieval/indexer"

const leaf = (
  kind: "function" | "method" | "const",
  name: string,
  startLine: number,
  endLine: number,
): {
  kind: "function" | "method" | "const"
  name: string
  startLine: number
  endLine: number
  signatureEndLine: number
  children: never[]
} => ({ kind, name, startLine, endLine, signatureEndLine: startLine, children: [] })

const mkInput = (text: string): ChunkInput => ({
  path: "src/foo.ts",
  text,
  mtime: 123,
  sha: "deadbeef",
})

/** Build a file of `n` lines with a marker per line for coverage assertions. */
const linesFile = (n: number): string => Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n")

describe("syntax-chunk hellgate", () => {
  test("never splits a function — each chunk is one whole decl (or merged siblings)", () => {
    const text = linesFile(300)
    // 3 functions + 1 class with 4 methods, all > maxLines so each stands alone.
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        leaf("function", "a", 1, 90),
        leaf("function", "b", 91, 180),
        {
          kind: "class",
          name: "C",
          startLine: 181,
          endLine: 300,
          signatureEndLine: 181,
          children: [
            leaf("method", "m1", 182, 210),
            leaf("method", "m2", 211, 240),
            leaf("method", "m3", 241, 270),
            leaf("method", "m4", 271, 299),
          ],
        },
      ],
    }
    const chunks = chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines: 80 })
    // Each function is exactly its own span (never split).
    const fnA = chunks.find((c) => c.startLine === 1)
    expect(fnA?.endLine).toBe(90)
    const fnB = chunks.find((c) => c.startLine === 91)
    expect(fnB?.endLine).toBe(180)
    // The class is split at method boundaries — every method line range is
    // covered by exactly one chunk that begins at-or-before the method start.
    for (const m of parsed.decls[2]!.children) {
      const owner = chunks.find((c) => c.startLine <= m.startLine && c.endLine >= m.endLine)
      expect(owner).toBeDefined()
    }
  })

  test("coverage invariant — union of chunk ranges == [1, lineCount], no gaps/overlaps", () => {
    const text = linesFile(300)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        leaf("function", "a", 5, 90),
        leaf("function", "b", 95, 180),
        {
          kind: "class",
          name: "C",
          startLine: 185,
          endLine: 300,
          signatureEndLine: 185,
          children: [leaf("method", "m1", 190, 240), leaf("method", "m2", 245, 299)],
        },
      ],
    }
    const chunks = [...chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines: 80 })]
    chunks.sort((a, b) => a.startLine - b.startLine)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[chunks.length - 1]!.endLine).toBe(300)
    for (let i = 1; i < chunks.length; i++) {
      // Contiguous, non-overlapping: next.start == prev.end + 1.
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1)
    }
  })

  test("tiny-sibling merge — 30 one-line consts collapse to one chunk (<= maxLines)", () => {
    const text = linesFile(30)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: Array.from({ length: 30 }, (_, i) => leaf("const", `c${i}`, i + 1, i + 1)),
    }
    const chunks = chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines: 80 })
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[0]!.endLine).toBe(30)
  })

  test("tiny-sibling merge respects maxLines — splits into bounded groups", () => {
    const text = linesFile(100)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: Array.from({ length: 100 }, (_, i) => leaf("const", `c${i}`, i + 1, i + 1)),
    }
    const chunks = chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines: 40 })
    expect(chunks.length).toBeGreaterThan(1)
    // No merged chunk exceeds maxLines.
    for (const c of chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(40)
  })

  test("oversized LEAF (one 400-line function, no children) → line-window split", () => {
    const text = linesFile(400)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [leaf("function", "huge", 1, 400)],
    }
    const chunks = chunkFileSyntactic(
      mkInput(text),
      { ok: true, parsed },
      { maxLines: 80, maxLinesSplit: 150, windowLines: 100 },
    )
    // Split into multiple windows (400 > 150 split cap).
    expect(chunks.length).toBeGreaterThan(1)
    // Coverage still exact.
    const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine)
    expect(sorted[0]!.startLine).toBe(1)
    expect(sorted[sorted.length - 1]!.endLine).toBe(400)
  })

  test("oversize-by-gap — tiny decls split by a large inter-decl gap never exceed maxLines", () => {
    // RED-ON-INJECTION repro for the mergeSmall/planRanges oversize bug: three
    // small top-level decls with a BIG gap (lines 21-199) before the last one.
    // The merge accumulator measured its span GAP-INCLUSIVE from accStart and
    // the FINAL accumulator was emitted whole with no size check, so the bug
    // produced chunks [1,20] and [21,205] — a 185-line chunk for maxLines=80.
    const maxLines = 80
    const text = linesFile(205)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [leaf("const", "A", 1, 10), leaf("const", "B", 15, 20), leaf("const", "C", 200, 205)],
    }
    const chunks = [...chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines })]
    // INVARIANT 1: no emitted chunk exceeds maxLines. None of these decls is an
    // indivisible oversized LEAF body (each spans <= maxLines), so the
    // documented single-oversized-leaf exception does NOT apply here.
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(maxLines)
    }
    // INVARIANT 2: coverage is still EXACT over [1, lineCount] — the gap lines
    // (21-199) must still land in SOME chunk — and contiguous (no holes/overlaps).
    chunks.sort((a, b) => a.startLine - b.startLine)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[chunks.length - 1]!.endLine).toBe(205)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1)
    }
  })

  test("oversize-by-trailing-gap — large gap AFTER the last decl stays bounded + covered", () => {
    // The tail-coverage path: a tiny decl early, then nothing for the rest of
    // the file. coverTail must NOT inflate the last chunk past maxLines while
    // still covering every trailing line.
    const maxLines = 50
    const text = linesFile(300)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [leaf("const", "A", 1, 5), leaf("const", "B", 8, 12)],
    }
    const chunks = [...chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines })]
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(maxLines)
    }
    chunks.sort((a, b) => a.startLine - b.startLine)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[chunks.length - 1]!.endLine).toBe(300)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1)
    }
  })

  test("windowLines > maxLines — split bound NEVER leaks a chunk past maxLines (gaps everywhere)", () => {
    // RED-ON-INJECTION repro for the pushBounded incomplete-bound bug: pushBounded
    // GUARDS on maxLines (oversized if span > maxLines) but SPLIT via splitWindow
    // with windowLines. With windowLines (50) > maxLines (10), each emitted window
    // could STILL be up to 50 lines — exceeding the very bound the guard checks.
    //
    // Layout exercises every pushBounded site at once:
    //   - LEADING gap: first decl starts at 6 (lines 1-5 attach to it),
    //   - BIG inter-decl gap: 16..199 between B and C (mergeSmall flush + final
    //     accumulator flush go through pushBounded),
    //   - TRAILING gap: 211..260 after the last decl (coverTail → pushBounded).
    // Pre-fix, the final flush pushBounded(1?,..) splits e.g. [6,199] into
    // [6,55],[56,105],... — 50-line chunks ≫ maxLines 10.
    const maxLines = 10
    const lineCount = 260
    const text = linesFile(lineCount)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [leaf("const", "A", 6, 8), leaf("const", "B", 12, 15), leaf("const", "C", 200, 205)],
    }
    const chunks = [
      ...chunkFileSyntactic(mkInput(text), { ok: true, parsed }, { maxLines, windowLines: 50 }),
    ]
    // INVARIANT 1: EVERY emitted chunk's span ≤ maxLines. None of these decls is
    // an indivisible oversized LEAF (each spans ≤ maxLines), so the documented
    // single-oversized-leaf exception does NOT apply — the bound must hold for all.
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(maxLines)
    }
    // INVARIANT 2: coverage still EXACT over [1, lineCount] + contiguous.
    chunks.sort((a, b) => a.startLine - b.startLine)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[chunks.length - 1]!.endLine).toBe(lineCount)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1)
    }
  })

  test("non-code / unknown-lang fallback ⇒ BYTE-IDENTICAL to chunkFile (NO-THROW)", () => {
    const text = linesFile(120)
    const input = mkInput(text)
    const outcome: ParseOutcome = { ok: false, reason: "no-grammar" }
    const syntactic = chunkFileSyntactic(input, outcome, { windowLines: 50, overlapLines: 20 })
    const window = chunkFile(input, { windowLines: 50, overlapLines: 20 })
    expect(syntactic).toEqual(window)
  })

  test("parse-error fallback ⇒ same line-window output, NO-THROW", () => {
    const text = linesFile(75)
    const input = mkInput(text)
    const syntactic = chunkFileSyntactic(input, { ok: false, reason: "parse-error" })
    const window = chunkFile(input)
    expect(syntactic).toEqual(window)
  })

  test("default-OFF byte-identity over a mixed corpus (fallback path == line-window)", () => {
    for (const n of [0, 1, 30, 50, 51, 120, 333]) {
      const input = mkInput(linesFile(n))
      const off = chunkFileSyntactic(input, { ok: false, reason: "no-grammar" })
      const base = chunkFile(input)
      expect(off).toEqual(base)
    }
  })

  test("fakeParser is NEVER consulted by the chunker (the indexer parses, not us)", async () => {
    // The chunker takes an ALREADY-RESOLVED outcome — it never calls parse.
    const fp = fakeParser(new Map())
    chunkFileSyntactic(mkInput(linesFile(10)), { ok: false, reason: "no-grammar" })
    expect(fp.calls()).toBe(0)
    // Sanity: the fake itself works when driven directly.
    const out = await fp.parse("x.ts", "nope")
    expect(out.ok).toBe(false)
    expect(fp.calls()).toBe(1)
  })

  test("determinism — same input ⇒ identical chunk array across two runs", () => {
    const text = linesFile(200)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [leaf("function", "a", 1, 100), leaf("function", "b", 101, 200)],
    }
    const r1 = chunkFileSyntactic(mkInput(text), { ok: true, parsed })
    const r2 = chunkFileSyntactic(mkInput(text), { ok: true, parsed })
    expect(r1).toEqual(r2)
  })

  test("empty file ⇒ no chunks (matches chunkFile)", () => {
    const input = mkInput("")
    expect(
      chunkFileSyntactic(input, { ok: true, parsed: { lang: "typescript", decls: [] } }),
    ).toEqual([])
  })

  test("no decls (only imports) ⇒ one chunk covering the whole file", () => {
    const text = linesFile(12)
    const chunks = chunkFileSyntactic(mkInput(text), {
      ok: true,
      parsed: { lang: "typescript", decls: [] },
    })
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[0]!.endLine).toBe(12)
  })
})
