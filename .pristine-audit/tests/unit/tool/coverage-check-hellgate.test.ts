/**
 * Hellgate — `coverage_check` tool (ADR-0165).
 *
 * Seals:
 *   A. Tool surface  (HELL-28..30) — 3 cases
 *   B. Execution    (HELL-31..37)  — 7 cases
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { coverageCheckTool } from "@/tool/coverage_check"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

let workDir = ""
let sourceDir = ""

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-tool-"))
  sourceDir = await mkdtemp(join(tmpdir(), "cov-tool-src-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: workDir,
  signal: signal ?? new AbortController().signal,
})

const collect = async (input: unknown, c: ToolContext = ctx()): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of coverageCheckTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/** Build a V8-shape doc covering ONE source file with the given coverage
 *  ratio. The source file is created under `sourceDir`. */
const buildCovJson = async (opts: {
  basename: string
  covered: boolean
  jsonName?: string
}): Promise<string> => {
  const src = "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n"
  const srcFile = join(sourceDir, opts.basename)
  await writeFile(srcFile, src, "utf8")
  const doc = {
    result: [
      {
        scriptId: "1",
        url: `file://${srcFile}`,
        functions: [
          { ranges: [{ startOffset: 0, endOffset: src.length, count: opts.covered ? 1 : 0 }] },
        ],
      },
    ],
  }
  const p = join(workDir, opts.jsonName ?? "coverage.json")
  await writeFile(p, JSON.stringify(doc), "utf8")
  return p
}

// ────────────────────────────────────────────────────────────────────────────
// A. TOOL SURFACE (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage_check / A. surface", () => {
  test("HELL-28: metadata — name + isReadOnly + isConcurrencySafe", () => {
    expect(coverageCheckTool.name).toBe("coverage_check")
    expect(coverageCheckTool.isReadOnly()).toBe(true)
    expect(coverageCheckTool.isConcurrencySafe({} as never)).toBe(true)
  })

  test("HELL-29: missing path → ok:false invalid input", async () => {
    const r = await collect({})
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/invalid input/)
  })

  test("HELL-30: threshold out of range → ok:false invalid input", async () => {
    const r1 = await collect({ coverageJsonPath: "a.json", thresholdLines: 150 })
    expect(r1.ok).toBe(false)
    const r2 = await collect({ coverageJsonPath: "a.json", thresholdLines: -5 })
    expect(r2.ok).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. EXECUTION (7)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage_check / B. execution", () => {
  test("HELL-31: happy path → ok:true with summary table", async () => {
    const cov = await buildCovJson({ basename: "src.ts", covered: true })
    const r = await collect({ coverageJsonPath: cov })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/Coverage report \(1 files\)/)
    expect(r.output).toMatch(/Totals:/)
    expect(r.output).toMatch(/PASS/)
  })

  test("HELL-32: threshold met → ok:true PASS", async () => {
    const cov = await buildCovJson({ basename: "src.ts", covered: true })
    const r = await collect({
      coverageJsonPath: cov,
      thresholdLines: 90,
      thresholdBranches: 0,
      thresholdStatements: 90,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/PASS/)
  })

  test("HELL-33: threshold crossed → ok:false with FAIL reasons", async () => {
    const cov = await buildCovJson({ basename: "src.ts", covered: false })
    const r = await collect({
      coverageJsonPath: cov,
      thresholdLines: 80,
    })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/FAIL/)
    expect(r.output).toMatch(/lines:/)
    expect(r.failure?.mode).toBe("rejected")
  })

  test("HELL-34: absolute path accepted (under cwd)", async () => {
    const cov = await buildCovJson({ basename: "src.ts", covered: true })
    // `cov` is already absolute, pointing inside workDir (cwd)
    const r = await collect({ coverageJsonPath: cov })
    expect(r.ok).toBe(true)
  })

  test("HELL-35: `..` escape rejected by FS jail", async () => {
    const r = await collect({ coverageJsonPath: "../../etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/path outside cwd/)
    expect(r.failure?.mode).toBe("permission_denied")
  })

  test("HELL-36: symlink to coverage JSON rejected", async () => {
    const real = await buildCovJson({ basename: "src.ts", covered: true })
    const link = join(workDir, "link.json")
    await symlink(real, link)
    const r = await collect({ coverageJsonPath: link })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/symlink not allowed/)
    expect(r.failure?.mode).toBe("permission_denied")
  })

  test("HELL-37: empty V8 result → ok:false no-coverage-data", async () => {
    const p = join(workDir, "empty.json")
    await writeFile(p, JSON.stringify({ result: [] }), "utf8")
    const r = await collect({ coverageJsonPath: p })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/no-coverage-data/)
  })
})
