/**
 * Hellgate — c8 coverage source (ADR-0172).
 *
 * Seals the Istanbul `coverage-final.json` → CoverageReport projection +
 * proves the precision win over the keyword-heuristic v8-source:
 *
 *   A. Happy path           (HELL-1..5)   — 5 cases
 *   B. Branch precision     (HELL-6..8)   — 3 cases (the c8 advantage)
 *   C. Error paths          (HELL-9..12)  — 4 cases
 *   D. Port parity          (HELL-13..15) — 3 cases
 *
 * Fixtures are hand-crafted Istanbul docs written to tmpdir; the source
 * files referenced by `path` do NOT need to exist (c8-source reads only
 * the JSON, not the source — branch info is already in `branchMap`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CoverageError,
  type CoverageSource,
  c8CoverageSource,
  defaultV8CoverageSource,
} from "@/observability/coverage"

let workDir = ""

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-c8-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

interface IstFile {
  path: string
  statementMap: Record<
    string,
    { start: { line: number; column: number }; end: { line: number; column: number } }
  >
  branchMap: Record<
    string,
    {
      type?: string
      locations: Array<{
        start: { line: number; column: number }
        end: { line: number; column: number }
      }>
    }
  >
  s: Record<string, number>
  b: Record<string, number[]>
  fnMap?: Record<string, unknown>
  f?: Record<string, number>
}

const writeIstanbul = async (files: IstFile[]): Promise<string> => {
  const doc: Record<string, IstFile> = {}
  for (const f of files) doc[f.path] = f
  const p = join(workDir, "coverage-final.json")
  await writeFile(p, JSON.stringify(doc), "utf8")
  return p
}

const stmt = (line: number, col = 0) => ({
  start: { line, column: col },
  end: { line, column: col + 1 },
})

const loc = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 1 },
})

// ────────────────────────────────────────────────────────────────────────────
// A. HAPPY PATH (5)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage-c8 / A. happy path", () => {
  test("HELL-1: single file 100% coverage → all percents = 100", async () => {
    const cov = await writeIstanbul([
      {
        path: "/abs/full.ts",
        statementMap: { "0": stmt(1), "1": stmt(2), "2": stmt(3) },
        branchMap: { "0": { type: "if", locations: [loc(1), loc(1)] } },
        s: { "0": 5, "1": 5, "2": 5 },
        b: { "0": [3, 2] },
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
    const f = report.files[0]
    expect(f?.linesPercent).toBe(100)
    expect(f?.branchesPercent).toBe(100)
    expect(f?.statementsPercent).toBe(100)
  })

  test("HELL-2: single file 0% coverage → all percents = 0", async () => {
    const cov = await writeIstanbul([
      {
        path: "/abs/zero.ts",
        statementMap: { "0": stmt(1), "1": stmt(2) },
        branchMap: { "0": { type: "if", locations: [loc(1), loc(1)] } },
        s: { "0": 0, "1": 0 },
        b: { "0": [0, 0] },
      },
    ])
    const report = await c8CoverageSource().read(cov)
    const f = report.files[0]
    expect(f?.linesPercent).toBe(0)
    expect(f?.branchesPercent).toBe(0)
    expect(f?.statementsPercent).toBe(0)
  })

  test("HELL-3: partial coverage (5/10 stmts, 2/4 branches) → correct percents", async () => {
    const statementMap: Record<string, ReturnType<typeof stmt>> = {}
    const s: Record<string, number> = {}
    for (let i = 0; i < 10; i += 1) {
      statementMap[String(i)] = stmt(i + 1)
      s[String(i)] = i < 5 ? 3 : 0
    }
    const cov = await writeIstanbul([
      {
        path: "/abs/partial.ts",
        statementMap,
        branchMap: {
          "0": { type: "if", locations: [loc(1), loc(1)] },
          "1": { type: "if", locations: [loc(2), loc(2)] },
        },
        s,
        b: { "0": [1, 0], "1": [1, 0] },
      },
    ])
    const report = await c8CoverageSource().read(cov)
    const f = report.files[0]
    expect(f?.statementsPercent).toBe(50)
    expect(f?.branchesPercent).toBe(50)
    expect(f?.branchCount).toBe(4)
    expect(f?.branchesCovered).toBe(2)
  })

  test("HELL-4: multi-file aggregate weighted by lineCount", async () => {
    // File A: 10 stmts on 10 distinct lines, all covered.
    // File B: 10 stmts on 10 distinct lines, none covered.
    const stmtsA: Record<string, ReturnType<typeof stmt>> = {}
    const sA: Record<string, number> = {}
    const stmtsB: Record<string, ReturnType<typeof stmt>> = {}
    const sB: Record<string, number> = {}
    for (let i = 0; i < 10; i += 1) {
      stmtsA[String(i)] = stmt(i + 1)
      sA[String(i)] = 1
      stmtsB[String(i)] = stmt(i + 1)
      sB[String(i)] = 0
    }
    const cov = await writeIstanbul([
      { path: "/abs/A.ts", statementMap: stmtsA, branchMap: {}, s: sA, b: {} },
      { path: "/abs/B.ts", statementMap: stmtsB, branchMap: {}, s: sB, b: {} },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.totals.fileCount).toBe(2)
    expect(report.totals.linesPercent).toBe(50)
    expect(report.totals.statementsPercent).toBe(50)
  })

  test("HELL-5: uncoveredLines lists exactly the unhit statement start lines", async () => {
    const cov = await writeIstanbul([
      {
        path: "/abs/uncov.ts",
        statementMap: {
          "0": stmt(1),
          "1": stmt(2),
          "2": stmt(7),
          "3": stmt(9),
        },
        branchMap: {},
        s: { "0": 5, "1": 0, "2": 0, "3": 5 },
        b: {},
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files[0]?.uncoveredLines).toEqual([2, 7])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. BRANCH PRECISION (3) — c8 advantage over v8 keyword heuristic
// ────────────────────────────────────────────────────────────────────────────
describe("coverage-c8 / B. branch precision", () => {
  test("HELL-6: if/else both arms tested → branchCount=2, branchesCovered=2", async () => {
    // ONE branchMap entry with TWO locations (then + else). Both arms hit.
    const cov = await writeIstanbul([
      {
        path: "/abs/both.ts",
        statementMap: { "0": stmt(1) },
        branchMap: { "0": { type: "if", locations: [loc(1), loc(2)] } },
        s: { "0": 5 },
        b: { "0": [3, 2] },
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files[0]?.branchCount).toBe(2)
    expect(report.files[0]?.branchesCovered).toBe(2)
    expect(report.files[0]?.branchesPercent).toBe(100)
  })

  test("HELL-7: if/else only THEN arm tested → branchesCovered=1 (NOT 2)", async () => {
    const cov = await writeIstanbul([
      {
        path: "/abs/then-only.ts",
        statementMap: { "0": stmt(1) },
        branchMap: { "0": { type: "if", locations: [loc(1), loc(2)] } },
        s: { "0": 5 },
        b: { "0": [5, 0] }, // then=5, else=0
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files[0]?.branchCount).toBe(2)
    expect(report.files[0]?.branchesCovered).toBe(1)
    expect(report.files[0]?.branchesPercent).toBe(50)
  })

  test("HELL-8: c8 source reports STRICTER branchesCovered than v8 ratio heuristic", async () => {
    // Setup: a hypothetical file with an `if/else` where the THEN arm is hit
    // many times and the ELSE arm is never hit, yet all LINES of the file
    // are covered. The v8 keyword heuristic infers branchesCovered from
    // lineRatio (=1.0 → all branches covered). c8 reads per-arm hits and
    // correctly reports only 1/2.
    const cov = await writeIstanbul([
      {
        path: "/abs/asymmetric.ts",
        statementMap: { "0": stmt(1), "1": stmt(2), "2": stmt(3) },
        branchMap: { "0": { type: "if", locations: [loc(2), loc(2)] } },
        s: { "0": 5, "1": 5, "2": 5 },
        b: { "0": [5, 0] }, // every statement executed; only then arm
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files[0]?.linesPercent).toBe(100)
    expect(report.files[0]?.branchesPercent).toBe(50)
    // v8 would have reported branchesCovered = round(2 * 1.0) = 2 (false 100%)
    // c8 reports the true 1/2. This is the documented precision win.
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. ERROR PATHS (4)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage-c8 / C. error paths", () => {
  test("HELL-9: missing JSON file → CoverageError(io-failed)", async () => {
    const missing = join(workDir, "does-not-exist.json")
    try {
      await c8CoverageSource().read(missing)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError)
      expect((e as CoverageError).code).toBe("io-failed")
    }
  })

  test("HELL-10: malformed JSON → CoverageError(json-malformed)", async () => {
    const p = join(workDir, "bad.json")
    await writeFile(p, "{not json", "utf8")
    try {
      await c8CoverageSource().read(p)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError)
      expect((e as CoverageError).code).toBe("json-malformed")
    }
  })

  test("HELL-11: empty file map → empty CoverageReport (NO error)", async () => {
    const p = join(workDir, "empty.json")
    await writeFile(p, "{}", "utf8")
    const report = await c8CoverageSource().read(p)
    expect(report.files).toHaveLength(0)
    expect(report.totals.fileCount).toBe(0)
    expect(report.totals.linesPercent).toBe(100)
  })

  test("HELL-12: schema mismatch (missing `s` field) → CoverageError(json-malformed)", async () => {
    const p = join(workDir, "broken.json")
    // Missing `s` and `b` fields.
    const bad = {
      "/abs/x.ts": {
        path: "/abs/x.ts",
        statementMap: { "0": stmt(1) },
        branchMap: {},
      },
    }
    await writeFile(p, JSON.stringify(bad), "utf8")
    try {
      await c8CoverageSource().read(p)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(CoverageError)
      expect((e as CoverageError).code).toBe("json-malformed")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. PORT PARITY (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage-c8 / D. port parity", () => {
  test("HELL-13: c8CoverageSource compiles as CoverageSource", () => {
    const src: CoverageSource = c8CoverageSource()
    expect(typeof src.read).toBe("function")
  })

  test("HELL-14: differential vs v8 — same logical content, c8 yields stricter branchesCovered", async () => {
    // Hand-roll BOTH a V8 JSON and an Istanbul JSON describing the same
    // source file. In v8 land we can only count via keyword heuristic
    // → linesRatio drives branchesCovered. In c8 land we know the truth
    // from `b[]`. The two MUST disagree when only one arm is hit.
    // 1) Write source file the v8 source can read (needs the file on disk).
    const srcBody = "if (x) { a() } else { b() }\n" // 1 line, both arms keyword-counted
    const srcPath = join(workDir, "diff.ts")
    await writeFile(srcPath, srcBody, "utf8")
    // 2) V8 doc: full coverage of the single line, count > 0.
    const v8Doc = {
      result: [
        {
          scriptId: "1",
          url: `file://${srcPath}`,
          functions: [{ ranges: [{ startOffset: 0, endOffset: srcBody.length, count: 5 }] }],
        },
      ],
    }
    const v8Path = join(workDir, "v8.json")
    await writeFile(v8Path, JSON.stringify(v8Doc), "utf8")
    // 3) Istanbul doc: same line covered, ONE branchMap entry, only then arm.
    const istPath = await writeIstanbul([
      {
        path: srcPath,
        statementMap: { "0": stmt(1) },
        branchMap: { "0": { type: "if", locations: [loc(1), loc(1)] } },
        s: { "0": 5 },
        b: { "0": [5, 0] }, // only `then` arm exercised
      },
    ])
    const v8Report = await defaultV8CoverageSource().read(v8Path)
    const c8Report = await c8CoverageSource().read(istPath)
    // v8 keyword scan: "if" (1) + "else" (1) = 2 branches; ratio = 100% lines
    // → branchesCovered = 2 → percent = 100%.
    // c8: 2 arms; only one hit → branchesCovered = 1 → percent = 50%.
    expect(v8Report.files[0]?.branchesPercent).toBe(100)
    expect(c8Report.files[0]?.branchesPercent).toBe(50)
    expect(c8Report.files[0]?.branchesPercent).toBeLessThan(v8Report.files[0]?.branchesPercent ?? 0)
  })

  test("HELL-15: node_modules paths filtered out", async () => {
    const cov = await writeIstanbul([
      {
        path: "/abs/project/src/keep.ts",
        statementMap: { "0": stmt(1) },
        branchMap: {},
        s: { "0": 1 },
        b: {},
      },
      {
        path: "/abs/project/node_modules/vendor/skip.ts",
        statementMap: { "0": stmt(1) },
        branchMap: {},
        s: { "0": 1 },
        b: {},
      },
    ])
    const report = await c8CoverageSource().read(cov)
    expect(report.files).toHaveLength(1)
    expect(report.files[0]?.file).toBe("/abs/project/src/keep.ts")
  })
})
