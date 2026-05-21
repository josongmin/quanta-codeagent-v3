/**
 * file_tree_summary integration — drives the REAL ripgrep `--files` path
 * against a tmpdir tree (no mock). Asserts structure rendering, depth bound,
 * file cap, and FS-jail enforcement. Integration tier because it spawns rg.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { fileTreeSummaryTool } from "@/tool"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "file-tree-summary-"))
  mkdirSync(join(dir, "src", "agent"), { recursive: true })
  mkdirSync(join(dir, "src", "tool", "deep", "deeper"), { recursive: true })
  mkdirSync(join(dir, "tests"), { recursive: true })
  writeFileSync(join(dir, "README.md"), "# x\n")
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1\n")
  writeFileSync(join(dir, "src", "agent", "loop.ts"), "export const loop = 1\n")
  writeFileSync(join(dir, "src", "tool", "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "src", "tool", "deep", "deeper", "buried.ts"), "export const b = 1\n")
  writeFileSync(join(dir, "tests", "x.test.ts"), "test('x', () => {})\n")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: Record<string, unknown>, cwd = dir): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of fileTreeSummaryTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("file_tree_summary", () => {
  test("renders directory tree with per-dir file counts", async () => {
    const r = await run({})
    expect(r.ok).toBe(true)
    // Top-level files grouped under "." ; src/ + nested dirs present.
    expect(r.output).toContain("README.md")
    expect(r.output).toMatch(/src\/agent\/ \(\d+\)/)
    expect(r.output).toContain("loop.ts")
  })

  test("depth bound rolls up deeper files into a marker", async () => {
    const r = await run({ max_depth: 2 })
    expect(r.ok).toBe(true)
    // buried.ts is at src/tool/deep/deeper/ (depth 4) — beyond max_depth 2.
    expect(r.output).not.toContain("buried.ts")
    expect(r.output).toContain("deeper")
  })

  test("deep files visible when max_depth is raised", async () => {
    const r = await run({ max_depth: 6 })
    expect(r.output).toContain("buried.ts")
  })

  test("file cap truncates with a marker", async () => {
    const r = await run({ max_files: 2 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("file cap 2 reached")
  })

  test("FS jail: escaping path → ok:false", async () => {
    const r = await run({ path: "/etc" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toMatch(/outside|jail|fs_jail|escape/)
  })

  test("read-only + concurrency-safe", () => {
    expect(fileTreeSummaryTool.isReadOnly?.()).toBe(true)
    expect(fileTreeSummaryTool.isConcurrencySafe?.({})).toBe(true)
  })

  test("summarize:true annotates files with first declaration/comment (R-Phase8 #3)", async () => {
    const r = await run({ summarize: true })
    expect(r.ok).toBe(true)
    // index.ts / loop.ts / a.ts all start with `export const ...` — the purpose
    // pass should attach that line after the filename with a ` — ` separator.
    expect(r.output).toMatch(/index\.ts\s+— export const x/)
    expect(r.output).toMatch(/loop\.ts\s+— export const loop/)
  })

  test("summarize omitted → structure only (no ` — ` annotations)", async () => {
    const r = await run({})
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain(" — export")
  })
})

describe("parsePurposeRows (pure)", () => {
  test("first match per file wins; trims; caps length", async () => {
    const { parsePurposeRows } = await import("@/tool/file-tree-summary")
    const stdout = [
      "src/a.ts:1:  export const a = 1",
      "src/a.ts:5:  export const b = 2", // second hit ignored
      "src/b.ts:3:// a comment",
    ].join("\n")
    const map = parsePurposeRows(stdout)
    expect(map.get("src/a.ts")).toBe("export const a = 1")
    expect(map.get("src/b.ts")).toBe("// a comment")
    expect(map.size).toBe(2)
  })
})
