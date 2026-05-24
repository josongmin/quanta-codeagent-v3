/**
 * Hellgate — V8 coverage source (ADR-0165).
 *
 * Seals:
 *   A. V8 source parsing  (HELL-1..10) — 10 cases
 *   B. Branch heuristic   (HELL-11..15) — 5 cases
 *
 * All cases use a real tmpdir + real fs writes; the V8 coverage JSON is
 * crafted by hand (the V8 shape is a small public schema). No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CoverageError, defaultV8CoverageSource } from "@/observability/coverage"

let workDir = ""
let sourceDir = ""

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-src-"))
  sourceDir = await mkdtemp(join(tmpdir(), "cov-pkg-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

/** Build a V8 coverage doc for the supplied script entries + write it to
 *  `workDir/coverage.json`. Returns the path. */
const writeV8 = async (
  scripts: Array<{
    url: string
    functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>
  }>,
): Promise<string> => {
  const doc = { result: scripts.map((s, i) => ({ scriptId: String(i + 1), ...s })) }
  const p = join(workDir, "coverage.json")
  await writeFile(p, JSON.stringify(doc), "utf8")
  return p
}

const writeSource = async (basename: string, body: string): Promise<string> => {
  const p = join(sourceDir, basename)
  await writeFile(p, body, "utf8")
  return p
}

// ────────────────────────────────────────────────────────────────────────────
// A. V8 SOURCE PARSING (10)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / A. V8 source parsing", () => {
  test("HELL-1: single file 100% line coverage → linesPercent=100", async () => {
    const src = "const a = 1\nconst b = 2\nconst c = 3\n"
    const file = await writeSource("a.ts", src)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 5 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
    expect(report.files[0]?.linesPercent).toBe(100)
  })

  test("HELL-2: single file 0% line coverage → linesPercent=0", async () => {
    const src = "const a = 1\nconst b = 2\nconst c = 3\n"
    const file = await writeSource("z.ts", src)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 0 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
    expect(report.files[0]?.linesPercent).toBe(0)
  })

  test("HELL-3: partial coverage (inner range count=0) → percent reflects partial", async () => {
    // 10 lines, V8 outer-range covers all (count=1), inner-range covers lines
    // 6..10 with count=0. Expected: lines 1..5 covered, 6..10 not → 50%.
    const lines: string[] = []
    for (let i = 0; i < 10; i += 1) lines.push(`x${i}`)
    const src = `${lines.join("\n")}\n`
    const file = await writeSource("p.ts", src)
    // byte offset where line 6 starts: 3*5 = 15  ("x0\n" is 3 bytes each)
    const halfOff = 15
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [
          {
            ranges: [
              { startOffset: 0, endOffset: src.length, count: 1 },
              { startOffset: halfOff, endOffset: src.length, count: 0 },
            ],
          },
        ],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.files[0]?.linesPercent).toBeGreaterThan(40)
    expect(report.files[0]?.linesPercent).toBeLessThan(60)
  })

  test("HELL-4: multi-file aggregate totals weighted by lineCount", async () => {
    // File A: 10 lines, all covered. File B: 10 lines, none covered.
    const srcA = `${"a\n".repeat(10)}`
    const srcB = `${"b\n".repeat(10)}`
    const a = await writeSource("a.ts", srcA)
    const b = await writeSource("b.ts", srcB)
    const cov = await writeV8([
      {
        url: `file://${a}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: srcA.length, count: 1 }] }],
      },
      {
        url: `file://${b}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: srcB.length, count: 0 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.totals.fileCount).toBe(2)
    // Weighted average of 100% (10 lines) + 0% (10 lines) = 50%
    expect(report.totals.linesPercent).toBeGreaterThan(40)
    expect(report.totals.linesPercent).toBeLessThan(60)
  })

  test("HELL-5: node_modules path filtered out", async () => {
    const nmDir = join(sourceDir, "node_modules", "vendor")
    await writeFile(join(sourceDir, "real.ts"), "x\n", "utf8")
    // We don't even need the file to exist for filter test — the urlToAbsPath
    // returns null before any read.
    const cov = await writeV8([
      {
        url: `file://${join(nmDir, "ghost.ts")}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
      },
      {
        url: `file://${join(sourceDir, "real.ts")}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
    expect(report.files[0]?.file).toBe(join(sourceDir, "real.ts"))
  })

  test("HELL-6: non-file URL (data:/node:) skipped", async () => {
    const src = "z\n"
    const file = await writeSource("real.ts", src)
    const cov = await writeV8([
      {
        url: "data:text/javascript;base64,YQ==",
        functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
      },
      {
        url: "node:internal/process",
        functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
      },
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
  })

  test("HELL-7: malformed JSON → CoverageError(json-malformed)", async () => {
    const p = join(workDir, "bad.json")
    await writeFile(p, "{not valid json", "utf8")
    let err: CoverageError | null = null
    try {
      await defaultV8CoverageSource().read(p)
    } catch (e) {
      if (e instanceof CoverageError) err = e
    }
    expect(err).not.toBeNull()
    expect(err?.code).toBe("json-malformed")
  })

  test("HELL-8: missing file → CoverageError(io-failed)", async () => {
    const ghost = join(workDir, "ghost.json")
    let err: CoverageError | null = null
    try {
      await defaultV8CoverageSource().read(ghost)
    } catch (e) {
      if (e instanceof CoverageError) err = e
    }
    expect(err).not.toBeNull()
    expect(err?.code).toBe("io-failed")
  })

  test("HELL-9: empty result array → CoverageError(no-coverage-data)", async () => {
    const p = join(workDir, "empty.json")
    await writeFile(p, JSON.stringify({ result: [] }), "utf8")
    let err: CoverageError | null = null
    try {
      await defaultV8CoverageSource().read(p)
    } catch (e) {
      if (e instanceof CoverageError) err = e
    }
    expect(err).not.toBeNull()
    expect(err?.code).toBe("no-coverage-data")
  })

  test("HELL-10: uncoveredLines is sorted, 1-indexed, dedup", async () => {
    const src = `${"x\n".repeat(5)}` // 5 lines + trailing newline → 6 total
    const file = await writeSource("u.ts", src)
    // Outer covered, inner range covers ONLY line 3 with count 0.
    // "x\n" is 2 bytes → line 3 starts at byte 4, ends at byte 6.
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [
          {
            ranges: [
              { startOffset: 0, endOffset: src.length, count: 1 },
              { startOffset: 4, endOffset: 6, count: 0 },
            ],
          },
        ],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    const uncovered = report.files[0]?.uncoveredLines ?? []
    expect(uncovered.length).toBeGreaterThan(0)
    // Strictly ascending
    for (let i = 1; i < uncovered.length; i += 1) {
      const prev = uncovered[i - 1]
      const cur = uncovered[i]
      if (prev !== undefined && cur !== undefined) expect(cur).toBeGreaterThan(prev)
    }
    // 1-indexed: no zero
    expect(uncovered).not.toContain(0)
    // Must contain line 3
    expect(uncovered).toContain(3)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. BRANCH COUNTING HEURISTIC (5)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / B. branch heuristic", () => {
  // We test branchCount via the FileCoverage emitted by the V8 adapter on a
  // small source. Use full-coverage outer range so the heuristic ratio is 1.
  const runBranchCount = async (src: string): Promise<number> => {
    const file = await writeSource(`b-${Math.random()}.ts`, src)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }],
      },
    ])
    const report = await defaultV8CoverageSource().read(cov)
    return report.files[0]?.branchCount ?? -1
  }

  test("HELL-11: `if (x) {}` → 1 branch", async () => {
    const count = await runBranchCount("function f(x){ if (x) { return 1 } }\n")
    expect(count).toBe(1)
  })

  test("HELL-12: `if (x) {} else {}` → 2 branches", async () => {
    const count = await runBranchCount("function f(x){ if (x) { return 1 } else { return 0 } }\n")
    expect(count).toBe(2)
  })

  test("HELL-13: `a && b` and `a || b` → 1 branch each", async () => {
    const andCount = await runBranchCount("const r = a && b\n")
    const orCount = await runBranchCount("const r = a || b\n")
    expect(andCount).toBe(1)
    expect(orCount).toBe(1)
  })

  test("HELL-14: ternary `a ? b : c` → 1 branch", async () => {
    const count = await runBranchCount("const r = a ? b : c\n")
    expect(count).toBe(1)
  })

  test("HELL-15: nested branches sum (if+else inside ternary)", async () => {
    // `if` + `else` + `?` = 3
    const count = await runBranchCount(
      "function f(x){ if (x) { return x ? 1 : 0 } else { return 2 } }\n",
    )
    expect(count).toBe(3)
  })
})
