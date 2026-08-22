/**
 * Hellgate — Istanbul-shape JSON emitter (ADR-0173).
 *
 * Seals (10+ cases): single-file shape, hit counts, branchMap.locations,
 * empty input, multi-file aggregation, schema-loose validation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type IstanbulCoverageJson,
  istanbulCoverageSource,
  type PerBranchSidecar,
  toIstanbulJson,
} from "@/observability/coverage"

let workDir = ""
let sourceDir = ""

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-emit-"))
  sourceDir = await mkdtemp(join(tmpdir(), "cov-emit-pkg-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

interface ScriptInput {
  url: string
  functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>
}

let covCounter = 0
const writeV8 = async (scripts: Array<ScriptInput>): Promise<string> => {
  covCounter += 1
  const doc = { result: scripts.map((s, i) => ({ scriptId: String(i + 1), ...s })) }
  const p = join(workDir, `c-${covCounter}.json`)
  await writeFile(p, JSON.stringify(doc), "utf8")
  return p
}

let srcCounter = 0
const writeSource = async (body: string): Promise<string> => {
  srcCounter += 1
  const p = join(sourceDir, `s-${srcCounter}.ts`)
  await writeFile(p, body, "utf8")
  return p
}

const buildReportAndSidecar = async (
  src: string,
  rangeCount: number,
): Promise<{
  report: Awaited<ReturnType<ReturnType<typeof istanbulCoverageSource>["read"]>>
  sidecar: PerBranchSidecar
  file: string
}> => {
  const file = await writeSource(src)
  const cov = await writeV8([
    {
      url: `file://${file}`,
      functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: rangeCount }] }],
    },
  ])
  const adapter = istanbulCoverageSource()
  const report = await adapter.read(cov)
  const sidecar = (adapter as unknown as { lastSidecar: PerBranchSidecar }).lastSidecar
  return { report, sidecar, file }
}

// ────────────────────────────────────────────────────────────────────────────
// E. SINGLE-FILE EMITTER SHAPE (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / E. Istanbul emitter shape", () => {
  test("HELL-16: single file → output has statementMap/fnMap/branchMap/s/f/b keys", async () => {
    const { report, sidecar, file } = await buildReportAndSidecar(
      "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n",
      3,
    )
    const out = toIstanbulJson(report, sidecar)
    const entry = out[file]
    expect(entry).toBeDefined()
    expect(entry?.path).toBe(file)
    expect(typeof entry?.statementMap).toBe("object")
    expect(typeof entry?.s).toBe("object")
    expect(typeof entry?.fnMap).toBe("object")
    expect(typeof entry?.f).toBe("object")
    expect(typeof entry?.branchMap).toBe("object")
    expect(typeof entry?.b).toBe("object")
  })

  test("HELL-17: hit counts in `b` match the per-branch counts from sidecar", async () => {
    const { report, sidecar, file } = await buildReportAndSidecar(
      "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n",
      7,
    )
    const out = toIstanbulJson(report, sidecar)
    const entry = out[file]
    expect(entry).toBeDefined()
    // We expect 1 branchMap entry (if/else grouped) with locations[0]=then,
    // locations[1]=else, and b[0] = [7, 7] (outer range fully covers both).
    const bKeys = Object.keys(entry?.b ?? {})
    expect(bKeys.length).toBe(1)
    expect(entry?.b[bKeys[0] as string]).toEqual([7, 7])
  })

  test("HELL-18: branchMap.locations array length matches arms (if=2, switch=N)", async () => {
    const ifRep = await buildReportAndSidecar(
      "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n",
      1,
    )
    const switchSrc = [
      "function g(x:number){",
      "  switch (x) {",
      "    case 1: return 1",
      "    case 2: return 2",
      "    default: return 0",
      "  }",
      "}",
      "",
    ].join("\n")
    const swRep = await buildReportAndSidecar(switchSrc, 1)
    const outIf = toIstanbulJson(ifRep.report, ifRep.sidecar)
    const outSw = toIstanbulJson(swRep.report, swRep.sidecar)
    const ifEntry = outIf[ifRep.file]
    const swEntry = outSw[swRep.file]
    expect(ifEntry).toBeDefined()
    expect(swEntry).toBeDefined()
    const ifBranchKeys = Object.keys(ifEntry?.branchMap ?? {})
    expect(ifBranchKeys.length).toBe(1)
    expect(ifEntry?.branchMap[ifBranchKeys[0] as string]?.locations.length).toBe(2)
    // Switch: 3 cases (case1/case2/default) → 3 branch entries, 1 location each.
    const swBranchKeys = Object.keys(swEntry?.branchMap ?? {})
    expect(swBranchKeys.length).toBe(3)
    for (const k of swBranchKeys) {
      expect(swEntry?.branchMap[k]?.locations.length).toBe(1)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. EMPTY + MULTI-FILE (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / F. Istanbul emitter empty + multi-file", () => {
  test("HELL-19: empty file (no branches) → branchMap + b empty for that key", async () => {
    const { report, sidecar, file } = await buildReportAndSidecar("const k = 1\nconst m = 2\n", 1)
    const out = toIstanbulJson(report, sidecar)
    const entry = out[file]
    expect(entry).toBeDefined()
    expect(Object.keys(entry?.branchMap ?? {}).length).toBe(0)
    expect(Object.keys(entry?.b ?? {}).length).toBe(0)
  })

  test("HELL-20: multi-file aggregation preserved (one key per file)", async () => {
    const srcA = "function f(x:boolean){ if (x) { return 1 } }\n"
    const srcB = "function g(y:boolean){ while (y) { break } }\n"
    const fileA = await writeSource(srcA)
    const fileB = await writeSource(srcB)
    const cov = await writeV8([
      {
        url: `file://${fileA}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: srcA.length, count: 2 }] }],
      },
      {
        url: `file://${fileB}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: srcB.length, count: 3 }] }],
      },
    ])
    const adapter = istanbulCoverageSource()
    const report = await adapter.read(cov)
    const sidecar = (adapter as unknown as { lastSidecar: PerBranchSidecar }).lastSidecar
    const out = toIstanbulJson(report, sidecar)
    expect(Object.keys(out).length).toBe(2)
    expect(out[fileA]).toBeDefined()
    expect(out[fileB]).toBeDefined()
  })

  test("HELL-21: emitter without sidecar → statement-only (empty branchMap)", async () => {
    const src = "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n"
    const file = await writeSource(src)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }],
      },
    ])
    const report = await istanbulCoverageSource().read(cov)
    const out = toIstanbulJson(report) // NO sidecar
    const entry = out[file]
    expect(entry).toBeDefined()
    expect(Object.keys(entry?.branchMap ?? {}).length).toBe(0)
    expect(Object.keys(entry?.b ?? {}).length).toBe(0)
    // statementMap still populated.
    expect(Object.keys(entry?.statementMap ?? {}).length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// G. STRUCTURAL (Istanbul JSON schema loose validation) (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / G. Istanbul JSON loose schema", () => {
  test("HELL-22: each file entry validates `{path, s, f, b, statementMap, fnMap, branchMap}`", async () => {
    const { report, sidecar } = await buildReportAndSidecar(
      "function f(x:boolean){ if (x) { return 1 } }\n",
      1,
    )
    const out: IstanbulCoverageJson = toIstanbulJson(report, sidecar)
    for (const entry of Object.values(out)) {
      expect("path" in entry).toBe(true)
      expect("statementMap" in entry).toBe(true)
      expect("s" in entry).toBe(true)
      expect("fnMap" in entry).toBe(true)
      expect("f" in entry).toBe(true)
      expect("branchMap" in entry).toBe(true)
      expect("b" in entry).toBe(true)
    }
  })

  test("HELL-23: branchMap entries have `type, line, loc, locations`", async () => {
    const { report, sidecar } = await buildReportAndSidecar(
      "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n",
      1,
    )
    const out = toIstanbulJson(report, sidecar)
    for (const entry of Object.values(out)) {
      for (const be of Object.values(entry.branchMap)) {
        expect(typeof be.type).toBe("string")
        expect(typeof be.line).toBe("number")
        expect(be.loc.start.line).toBeGreaterThanOrEqual(1)
        expect(Array.isArray(be.locations)).toBe(true)
      }
    }
  })

  test("HELL-24: statementMap entries have `start`/`end` with `line`/`column`", async () => {
    const { report, sidecar } = await buildReportAndSidecar("const a = 1\nconst b = 2\n", 1)
    const out = toIstanbulJson(report, sidecar)
    for (const entry of Object.values(out)) {
      for (const sm of Object.values(entry.statementMap)) {
        expect(typeof sm.start.line).toBe("number")
        expect(typeof sm.start.column).toBe("number")
        expect(typeof sm.end.line).toBe("number")
        expect(typeof sm.end.column).toBe("number")
      }
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// H. EMPTY INPUT GUARDS (1)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / H. emitter empty input", () => {
  test("HELL-25: report with empty `files` → emitter returns `{}`", () => {
    const empty = {
      files: [],
      totals: { linesPercent: 100, branchesPercent: 100, statementsPercent: 100, fileCount: 0 },
      generatedAt: Date.now(),
    }
    const out = toIstanbulJson(empty)
    expect(Object.keys(out).length).toBe(0)
  })
})
