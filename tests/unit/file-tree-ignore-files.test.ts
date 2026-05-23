/**
 * Unit + integration tests for `collectIgnoreFiles` and the `--ignore-file`
 * injection into `rg --files` in the `file_tree_summary` tool.
 *
 * Coverage:
 *  1. No ignore files present → argv byte-identical to baseline
 *  2. Only `.quantaignore` present → `--ignore-file <abs>` appended
 *  3. All three files present → all three in declared order
 *  4. `.cursorignore` is a symlink outside the jail → silently skipped
 *  5. Integration: tmp dir with `.quantaignore` excluding `dist/` → rg output
 *     excludes dist/ entries
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { fileTreeSummaryTool } from "@/tool"
import { collectIgnoreFiles } from "@/tool/file-tree-summary"

// ---------------------------------------------------------------------------
// Shared tmpdir infrastructure
// ---------------------------------------------------------------------------
let base: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "fts-ignore-"))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// collectIgnoreFiles — pure helper unit tests
// ---------------------------------------------------------------------------
describe("collectIgnoreFiles", () => {
  test("no ignore files present → empty array (argv stays byte-identical)", () => {
    const dir = mkdtempSync(join(base, "none-"))
    const result = collectIgnoreFiles(dir, dir)
    expect(result).toEqual([])
  })

  test("only .quantaignore present → returns its absolute path", () => {
    const dir = mkdtempSync(join(base, "q-only-"))
    const qPath = join(dir, ".quantaignore")
    writeFileSync(qPath, "dist/\n")
    const result = collectIgnoreFiles(dir, dir)
    expect(result).toEqual([qPath])
  })

  test("all three files present → returns all three in declared order", () => {
    const dir = mkdtempSync(join(base, "all-"))
    const qPath = join(dir, ".quantaignore")
    const cPath = join(dir, ".cursorignore")
    const ciPath = join(dir, ".cursorindexignore")
    writeFileSync(qPath, "dist/\n")
    writeFileSync(cPath, "build/\n")
    writeFileSync(ciPath, "coverage/\n")
    const result = collectIgnoreFiles(dir, dir)
    expect(result).toEqual([qPath, cPath, ciPath])
  })

  test("only .cursorignore + .cursorindexignore present → .quantaignore omitted", () => {
    const dir = mkdtempSync(join(base, "ci-"))
    const cPath = join(dir, ".cursorignore")
    const ciPath = join(dir, ".cursorindexignore")
    writeFileSync(cPath, "build/\n")
    writeFileSync(ciPath, "coverage/\n")
    const result = collectIgnoreFiles(dir, dir)
    expect(result).toEqual([cPath, ciPath])
  })

  test(".cursorignore is a symlink pointing outside the jail → silently skipped", () => {
    // Set up: jail root = scopeDir, symlink target = outsideDir
    const scopeDir = mkdtempSync(join(base, "symlink-jail-"))
    const outsideDir = mkdtempSync(join(base, "outside-"))
    // Write the actual file outside the jail
    const outsideFile = join(outsideDir, "outside-ignore")
    writeFileSync(outsideFile, "build/\n")
    // Create symlink inside scope pointing outside
    const symlinkPath = join(scopeDir, ".cursorignore")
    symlinkSync(outsideFile, symlinkPath)

    // Also write .quantaignore inside scope so we can see the rest still works
    const qPath = join(scopeDir, ".quantaignore")
    writeFileSync(qPath, "dist/\n")

    // scopeDir is both scopeRoot and ctxCwd (jail root)
    const result = collectIgnoreFiles(scopeDir, scopeDir)
    // .quantaignore is fine; .cursorignore (symlink→outside) should be skipped
    expect(result).toEqual([qPath])
    expect(result).not.toContain(symlinkPath)
  })
})

// ---------------------------------------------------------------------------
// Integration: rg --files respects .quantaignore
// ---------------------------------------------------------------------------
describe("file_tree_summary — .quantaignore integration", () => {
  let repoDir: string

  beforeAll(() => {
    repoDir = mkdtempSync(join(base, "repo-"))
    // Interesting source files
    mkdirSync(join(repoDir, "src"), { recursive: true })
    writeFileSync(join(repoDir, "src", "index.ts"), "export const x = 1\n")
    // Uninteresting dist tree
    mkdirSync(join(repoDir, "dist"), { recursive: true })
    writeFileSync(join(repoDir, "dist", "bundle.js"), "// generated\n")
    // .quantaignore excludes dist/
    writeFileSync(join(repoDir, ".quantaignore"), "dist/\n")
  })

  const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

  const run = async (input: Record<string, unknown>, cwd = repoDir): Promise<ToolResult> => {
    let result: ToolResult | undefined
    for await (const ev of fileTreeSummaryTool.execute(input as never, ctx(cwd))) {
      if (ev.type === "result") result = ev.result
    }
    if (!result) throw new Error("no result")
    return result
  }

  test("dist/ entries excluded when .quantaignore contains dist/", async () => {
    const r = await run({})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("index.ts")
    expect(r.output).not.toContain("bundle.js")
    expect(r.output).not.toContain("dist/")
  })

  test("without .quantaignore, dist/ would appear", async () => {
    // Create a separate dir without .quantaignore to confirm dist/ shows up
    const noIgnoreDir = mkdtempSync(join(base, "no-ignore-"))
    mkdirSync(join(noIgnoreDir, "src"), { recursive: true })
    mkdirSync(join(noIgnoreDir, "dist"), { recursive: true })
    writeFileSync(join(noIgnoreDir, "src", "index.ts"), "export const x = 1\n")
    writeFileSync(join(noIgnoreDir, "dist", "bundle.js"), "// generated\n")
    const r = await run({}, noIgnoreDir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("bundle.js")
  })
})
