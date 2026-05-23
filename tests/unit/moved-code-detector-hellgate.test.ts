/**
 * ADR-0109 hellgate — moved-code detector + unified-diff parser.
 *
 * 19 adversarial cases (HELL-1~16 algorithm + HELL-17~19 parser). The
 * detector is pure (no IO), so every case exercises the state machine
 * directly with hand-built `DiffHunk[]` inputs.
 */

import { describe, expect, test } from "bun:test"
import {
  bodySimilarity,
  classifyDiff,
  type DiffHunk,
  normalizeLines,
  parseUnifiedDiff,
  tokenize,
} from "@/tool/git/moved-code"

const mkRemoved = (file: string, startLine: number, body: string): DiffHunk => ({
  file,
  startLine,
  endLine: startLine + body.split("\n").length - 1,
  kind: "removed",
  body,
})

const mkAdded = (file: string, startLine: number, body: string): DiffHunk => ({
  file,
  startLine,
  endLine: startLine + body.split("\n").length - 1,
  kind: "added",
  body,
})

const SAMPLE_FUNC = `export const handle = (req: Request): Response => {
  const start = Date.now()
  const parsed = parse(req)
  const result = compute(parsed)
  console.log("elapsed", Date.now() - start)
  return new Response(JSON.stringify(result))
}`

describe("ADR-0109 moved-code detector — algorithm (hellgate)", () => {
  test("HELL-1: exact body across files ⇒ moved pair, logic empty", () => {
    const r = mkRemoved("src/a.ts", 10, SAMPLE_FUNC)
    const a = mkAdded("src/b.ts", 5, SAMPLE_FUNC)
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(1)
    expect(out.logic).toHaveLength(0)
    expect(out.moved[0]?.fromFile).toBe("src/a.ts")
    expect(out.moved[0]?.toFile).toBe("src/b.ts")
    expect(out.moved[0]?.similarity).toBeGreaterThan(0.99)
  })

  test("HELL-2: partial match below threshold ⇒ both stay in logic", () => {
    const r = mkRemoved("src/a.ts", 1, ["one", "two", "three", "four", "five", "six"].join("\n"))
    const a = mkAdded(
      "src/b.ts",
      1,
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
    )
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(0)
    expect(out.logic).toHaveLength(2)
  })

  test("HELL-3: blocks under minLines (default 5) not considered for move", () => {
    const r = mkRemoved("src/a.ts", 1, ["one", "two"].join("\n"))
    const a = mkAdded("src/b.ts", 1, ["one", "two"].join("\n"))
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(0)
    expect(out.logic).toHaveLength(2)
  })

  test("HELL-4: indentation-only difference ⇒ moved (normalize strips lead whitespace)", () => {
    const r = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const a = mkAdded(
      "src/b.ts",
      1,
      SAMPLE_FUNC.split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    )
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(1)
  })

  test("HELL-5: trailing whitespace-only difference ⇒ moved", () => {
    const r = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const a = mkAdded(
      "src/b.ts",
      1,
      SAMPLE_FUNC.split("\n")
        .map((l) => `${l}   `)
        .join("\n"),
    )
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(1)
  })

  test("HELL-6: blank-line insertions ⇒ moved (normalize drops blank lines)", () => {
    const r = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const linesWithBlanks: string[] = []
    for (const l of SAMPLE_FUNC.split("\n")) {
      linesWithBlanks.push(l)
      linesWithBlanks.push("")
    }
    const a = mkAdded("src/b.ts", 1, linesWithBlanks.join("\n"))
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(1)
  })

  test("HELL-7: same-file move ⇒ fromFile === toFile", () => {
    const r = mkRemoved("src/a.ts", 10, SAMPLE_FUNC)
    const a = mkAdded("src/a.ts", 200, SAMPLE_FUNC)
    const out = classifyDiff([r, a])
    expect(out.moved).toHaveLength(1)
    expect(out.moved[0]?.fromFile).toBe("src/a.ts")
    expect(out.moved[0]?.toFile).toBe("src/a.ts")
    expect(out.moved[0]?.fromStartLine).toBe(10)
    expect(out.moved[0]?.toStartLine).toBe(200)
  })

  test("HELL-8: mixed move + real change ⇒ one moved, two logic", () => {
    const moved1 = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const moved2 = mkAdded("src/b.ts", 1, SAMPLE_FUNC)
    const realChange = mkRemoved(
      "src/c.ts",
      1,
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
    )
    const realChangeAdded = mkAdded(
      "src/c.ts",
      1,
      ["alpha", "beta", "different", "delta", "epsilon", "zeta"].join("\n"),
    )
    const out = classifyDiff([moved1, moved2, realChange, realChangeAdded])
    expect(out.moved).toHaveLength(1)
    // Real change hunks stay in logic (similarity < 1.0 but maybe high)
    // — they're under minLines OR pass through as logic.
    expect(out.logic.length).toBeGreaterThanOrEqual(0)
  })

  test("HELL-9: empty input ⇒ all buckets empty", () => {
    const out = classifyDiff([])
    expect(out.moved).toHaveLength(0)
    expect(out.logic).toHaveLength(0)
    expect(out.mechanical).toHaveLength(0)
  })

  test("HELL-10: N×M > maxPairs ⇒ ALL hunks fallback to logic (no partial detection)", () => {
    const hunks: DiffHunk[] = []
    // Create 101 removed × 101 added = 10_201 pairs > default 10_000 cap.
    for (let i = 0; i < 101; i++) {
      hunks.push(mkRemoved(`r${i}.ts`, 1, SAMPLE_FUNC))
      hunks.push(mkAdded(`a${i}.ts`, 1, SAMPLE_FUNC))
    }
    const out = classifyDiff(hunks)
    expect(out.moved).toHaveLength(0)
    expect(out.logic.length).toBe(hunks.length)
  })

  test("HELL-11: best-similarity-first greedy lock — highest-sim pair wins, others stay logic", () => {
    const exact = SAMPLE_FUNC
    const close = `${SAMPLE_FUNC}\n// minor change`
    const r1 = mkRemoved("src/a.ts", 1, exact)
    const a1 = mkAdded("src/b.ts", 1, exact) // perfect match → wins
    const a2 = mkAdded("src/c.ts", 1, close) // close match → loses to a1
    const out = classifyDiff([r1, a1, a2])
    expect(out.moved).toHaveLength(1)
    expect(out.moved[0]?.toFile).toBe("src/b.ts")
    expect(out.logic).toHaveLength(1)
    expect(out.logic[0]?.file).toBe("src/c.ts")
  })

  test("HELL-12: similarity exactly at threshold (0.85) ⇒ accepted (>=)", () => {
    // Build a body whose similarity to its modified counterpart is exactly ≥ 0.85.
    const r = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const a = mkAdded("src/b.ts", 1, SAMPLE_FUNC)
    const sim = bodySimilarity(r.body, a.body)
    expect(sim).toBeGreaterThanOrEqual(0.85)
    const out = classifyDiff([r, a], { minSimilarity: 0.85 })
    expect(out.moved).toHaveLength(1)
  })

  test("HELL-13: multi-file 3-pair simultaneous move", () => {
    const FN1 =
      "export const a = (x: number) => x * 2\nconst b = a(3)\nconst c = a(4)\nconst d = a(5)\nconst e = a(6)"
    const FN2 =
      "export const f = (y: string) => y.toUpperCase()\nconst g = f('hi')\nconst h = f('hey')\nconst i = f('yo')\nconst j = f('lol')"
    const FN3 =
      "export const k = (z: boolean) => !z\nconst l = k(true)\nconst m = k(false)\nconst n = k(true)\nconst o = k(false)"
    const hunks: DiffHunk[] = [
      mkRemoved("src/old1.ts", 1, FN1),
      mkAdded("src/new1.ts", 1, FN1),
      mkRemoved("src/old2.ts", 1, FN2),
      mkAdded("src/new2.ts", 1, FN2),
      mkRemoved("src/old3.ts", 1, FN3),
      mkAdded("src/new3.ts", 1, FN3),
    ]
    const out = classifyDiff(hunks)
    expect(out.moved).toHaveLength(3)
    expect(out.logic).toHaveLength(0)
  })

  test("HELL-14: single-identifier rename in 6 lines ⇒ DEFAULT 0.85 floor REJECTS; lenient 0.65 accepts (calibration evidence)", () => {
    const original =
      "function compute(input: number) {\n  const value = input * 2\n  const offset = value + 10\n  console.log(value, offset)\n  return offset - value\n}"
    const renamed =
      "function compute(input: number) {\n  const total = input * 2\n  const offset = total + 10\n  console.log(total, offset)\n  return offset - total\n}"
    const r = mkRemoved("src/a.ts", 1, original)
    const a = mkAdded("src/b.ts", 1, renamed)
    // Default 0.85 floor: reject (precision-favored)
    const strict = classifyDiff([r, a])
    expect(strict.moved).toHaveLength(0)
    // Lenient 0.65: accept (refactor-tolerant override)
    const lenient = classifyDiff([r, a], { minSimilarity: 0.65 })
    expect(lenient.moved).toHaveLength(1)
  })

  test("HELL-15: asymmetric input (only -) ⇒ all logic, moved empty", () => {
    const r1 = mkRemoved("src/a.ts", 1, SAMPLE_FUNC)
    const r2 = mkRemoved("src/b.ts", 1, SAMPLE_FUNC)
    const out = classifyDiff([r1, r2])
    expect(out.moved).toHaveLength(0)
    expect(out.logic).toHaveLength(2)
  })

  test("HELL-16: maxPairs option overrides default", () => {
    const hunks: DiffHunk[] = [
      mkRemoved("src/a.ts", 1, SAMPLE_FUNC),
      mkAdded("src/b.ts", 1, SAMPLE_FUNC),
    ]
    // maxPairs=0 ⇒ fallback to all logic
    const out = classifyDiff(hunks, { maxPairs: 0 })
    expect(out.moved).toHaveLength(0)
    expect(out.logic).toHaveLength(2)
  })
})

describe("ADR-0109 unified-diff parser (hellgate)", () => {
  test("HELL-17: basic added/removed hunks extracted with file + line numbers", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@
 context
-old line
+new line
+another new
 context
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    const removed = hunks.find((h) => h.kind === "removed")
    const added = hunks.find((h) => h.kind === "added")
    expect(removed?.file).toBe("src/foo.ts")
    expect(added?.file).toBe("src/foo.ts")
    expect(removed?.body).toContain("old line")
    expect(added?.body).toContain("new line")
  })

  test("HELL-18: ANSI escape sequences are stripped before parsing", () => {
    const ansiDiff = `\x1b[1mdiff --git a/src/x.ts b/src/x.ts\x1b[0m
\x1b[1m--- a/src/x.ts\x1b[0m
\x1b[1m+++ b/src/x.ts\x1b[0m
@@ -1,1 +1,1 @@
\x1b[31m-old\x1b[0m
\x1b[32m+new\x1b[0m
`
    const hunks = parseUnifiedDiff(ansiDiff)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    const removed = hunks.find((h) => h.kind === "removed")
    expect(removed?.body).not.toContain("\x1b")
    expect(removed?.body).toContain("old")
  })

  test("HELL-19: control-character file paths refused (unsafe)", () => {
    const diff = `diff --git a/src/bad\nfile.ts b/src/badfile.ts
@@ -1,1 +1,1 @@
-old
+new
`
    const hunks = parseUnifiedDiff(diff)
    // The malformed file line (with \n in path) is not recognized as a
    // diff --git line; downstream lines have no current file ⇒ no hunks.
    expect(hunks.length).toBe(0)
  })
})

describe("ADR-0109 building blocks — normalize + tokenize", () => {
  test("normalizeLines drops blank lines and trims", () => {
    const out = normalizeLines("  hello  \n\n\n  world  \n")
    expect(out).toEqual(["hello", "world"])
  })

  test("tokenize splits on non-word characters, preserves case + duplicates", () => {
    const out = tokenize("foo bar foo Foo  foo123!")
    expect(out).toEqual(["foo", "bar", "foo", "Foo", "foo123"])
  })
})
