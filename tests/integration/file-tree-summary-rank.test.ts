/**
 * Integration tests for file_tree_summary rank + ext-breakdown + unified rollup.
 * Items #4, #5, #7 from the SOTA++ hardening round.
 *
 * Drives the real ripgrep path against a tmpdir tree (no mock for rg).
 * For recency tests we use a mini git repo to avoid needing a real git history,
 * and verify git-failure fallback via a non-git tmpdir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { fileTreeSummaryTool } from "@/tool"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Non-git tmpdir with a multi-dir tree for rank tests */
let dir: string
/** Git-initialized tmpdir for recency rank tests */
let gitDir: string

const mkContext = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: Record<string, unknown>, cwd = dir): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of fileTreeSummaryTool.execute(input as never, mkContext(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

beforeAll(() => {
  // -------------------------------------------------------------------------
  // Non-git fixture: 3 dirs with different file counts + mixed extensions
  // -------------------------------------------------------------------------
  dir = mkdtempSync(join(tmpdir(), "fts-rank-"))
  mkdirSync(join(dir, "small"), { recursive: true })
  mkdirSync(join(dir, "large"), { recursive: true })
  mkdirSync(join(dir, "medium"), { recursive: true })

  // small/ — 1 file (bare count: no breakdown)
  writeFileSync(join(dir, "small", "a.ts"), "export const a = 1\n")

  // large/ — 5 files, 3 distinct exts (ts=3 md=1 json=1)
  writeFileSync(join(dir, "large", "x.ts"), "export const x = 1\n")
  writeFileSync(join(dir, "large", "y.ts"), "export const y = 1\n")
  writeFileSync(join(dir, "large", "z.ts"), "export const z = 1\n")
  writeFileSync(join(dir, "large", "README.md"), "# large\n")
  writeFileSync(join(dir, "large", "config.json"), "{}\n")

  // medium/ — 3 files, all same ext (no breakdown: only 1 distinct ext)
  writeFileSync(join(dir, "medium", "p.ts"), "export const p = 1\n")
  writeFileSync(join(dir, "medium", "q.ts"), "export const q = 1\n")
  writeFileSync(join(dir, "medium", "r.ts"), "export const r = 1\n")

  // -------------------------------------------------------------------------
  // Git fixture: same structure but in a git repo with a commit
  // -------------------------------------------------------------------------
  gitDir = mkdtempSync(join(tmpdir(), "fts-recency-"))
  mkdirSync(join(gitDir, "hot"), { recursive: true })
  mkdirSync(join(gitDir, "cold"), { recursive: true })
  mkdirSync(join(gitDir, "nested", "hot"), { recursive: true })
  mkdirSync(join(gitDir, "nested", "cold"), { recursive: true })

  writeFileSync(join(gitDir, "hot", "a.ts"), "export const a = 1\n")
  writeFileSync(join(gitDir, "hot", "b.ts"), "export const b = 1\n")
  writeFileSync(join(gitDir, "hot", "c.ts"), "export const c = 1\n")
  writeFileSync(join(gitDir, "cold", "x.ts"), "export const x = 1\n")
  writeFileSync(join(gitDir, "cold", "y.ts"), "export const y = 1\n")
  writeFileSync(join(gitDir, "cold", "z.ts"), "export const z = 1\n")
  writeFileSync(join(gitDir, "nested", "hot", "a.ts"), "export const a = 1\n")
  writeFileSync(join(gitDir, "nested", "hot", "b.ts"), "export const b = 1\n")
  writeFileSync(join(gitDir, "nested", "cold", "x.ts"), "export const x = 1\n")
  writeFileSync(join(gitDir, "nested", "cold", "y.ts"), "export const y = 1\n")

  try {
    // Initialize git repo and commit all files so git log picks them up
    const gitOpts = { cwd: gitDir, stdio: "pipe" as const }
    execSync("git init -q", gitOpts)
    execSync("git config user.email test@test.com", gitOpts)
    execSync("git config user.name Test", gitOpts)
    execSync("git add .", gitOpts)
    execSync("git commit -qm 'init' --allow-empty", gitOpts)
    // Add another commit modifying only hot/ files to boost recency score
    writeFileSync(join(gitDir, "hot", "a.ts"), "export const a = 2\n")
    writeFileSync(join(gitDir, "nested", "hot", "a.ts"), "export const a = 2\n")
    execSync("git add .", gitOpts)
    execSync("git commit -qm 'update hot' --allow-empty", gitOpts)
  } catch {
    // git may not be available; recency test will verify fallback
  }
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(gitDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// #4 — rank option
// ---------------------------------------------------------------------------
describe("rank: alpha (default — byte-identical baseline)", () => {
  test("explicit rank:alpha produces same output as omitted rank", async () => {
    const withDefault = await run({})
    const withAlpha = await run({ rank: "alpha" })
    expect(withAlpha.output).toBe(withDefault.output)
  })

  test("dirs are byte-sorted (alpha order)", async () => {
    const r = await run({ rank: "alpha" })
    expect(r.ok).toBe(true)
    // large < medium < small in byte order
    const posLarge = r.output.indexOf("large/")
    const posMedium = r.output.indexOf("medium/")
    const posSmall = r.output.indexOf("small/")
    expect(posLarge).toBeLessThan(posMedium)
    expect(posMedium).toBeLessThan(posSmall)
  })
})

describe("rank: size", () => {
  test("orders dirs by file count desc", async () => {
    const r = await run({ rank: "size" })
    expect(r.ok).toBe(true)
    // large(5) > medium(3) > small(1)
    const posLarge = r.output.indexOf("large/")
    const posMedium = r.output.indexOf("medium/")
    const posSmall = r.output.indexOf("small/")
    expect(posLarge).toBeLessThan(posMedium)
    expect(posMedium).toBeLessThan(posSmall)
  })

  test("file count in parens still present", async () => {
    const r = await run({ rank: "size" })
    expect(r.output).toMatch(/large\/\s*\(\d+/)
  })
})

describe("rank: recency — git-failure path (non-git dir)", () => {
  test("silently falls back to alpha order when cwd is not a git repo", async () => {
    // dir is a non-git tmpdir — git log will fail → fallback to alpha
    const rRecency = await run({ rank: "recency" }, dir)
    const rAlpha = await run({ rank: "alpha" }, dir)
    expect(rRecency.ok).toBe(true)
    expect(rRecency.output).toBe(rAlpha.output)
  })
})

describe("rank: recency — git repo", () => {
  test("succeeds and returns structured output", async () => {
    const r = await run({ rank: "recency" }, gitDir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("hot/")
    expect(r.output).toContain("cold/")
  })

  test("hot/ dir appears before cold/ (hot has more recent commits)", async () => {
    const r = await run({ rank: "recency" }, gitDir)
    const posHot = r.output.indexOf("hot/")
    const posCold = r.output.indexOf("cold/")
    // hot/ should appear first because it has more recent activity
    expect(posHot).toBeLessThan(posCold)
  })

  test("scoped path keeps recency ordering after prefix stripping", async () => {
    const r = await run({ rank: "recency", path: "nested" }, gitDir)
    expect(r.ok).toBe(true)
    const posHot = r.output.indexOf("hot/")
    const posCold = r.output.indexOf("cold/")
    expect(posHot).toBeLessThan(posCold)
  })
})

// ---------------------------------------------------------------------------
// #5 — ext breakdown on dir lines
// ---------------------------------------------------------------------------
describe("ext breakdown", () => {
  test("large/ (≥3 files, ≥2 exts) shows breakdown", async () => {
    const r = await run({})
    // large/ has ts=3, md=1, json=1
    // Tie-break for count=1: json < md in byte-sort → ts=3 json=1 md=1
    expect(r.output).toMatch(/large\/\s*\(\s*5,\s*ts=3\s+json=1\s+md=1\s*\)/)
  })

  test("medium/ (≥3 files but only 1 ext) shows bare count", async () => {
    const r = await run({})
    expect(r.output).toMatch(/medium\/\s*\(\s*3\s*\)/)
  })

  test("small/ (1 file) shows bare count", async () => {
    const r = await run({})
    expect(r.output).toMatch(/small\/\s*\(\s*1\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// #7 — unified rollup display
// ---------------------------------------------------------------------------
describe("unified rollup display", () => {
  let rollupDir: string

  beforeAll(() => {
    // Build a tree where BOTH rollup forms are triggered:
    //   - src/tool/ (in byDir at depth 2, max_depth=2) has deeper files → in-byDir rollup
    //   - src/tool/deep/ is NOT in byDir but has deeper descendants → orphan rollup
    rollupDir = mkdtempSync(join(tmpdir(), "fts-rollup-"))
    mkdirSync(join(rollupDir, "src", "tool", "deep", "deeper"), { recursive: true })
    writeFileSync(join(rollupDir, "src", "tool", "a.ts"), "a\n")
    // This file at depth 4 creates a deepRollup entry for ancestor src/tool (in byDir)
    writeFileSync(join(rollupDir, "src", "tool", "deep", "deeper", "buried.ts"), "b\n")
  })

  afterAll(() => {
    rmSync(rollupDir, { recursive: true, force: true })
  })

  test("both rollup forms match the canonical pattern", async () => {
    const r = await run({ max_depth: 2 }, rollupDir)
    expect(r.ok).toBe(true)

    // Should match at least one rollup line using the canonical pattern
    const lines = r.output.split("\n").filter((l) => l.includes("deeper, increase max_depth"))
    expect(lines.length).toBeGreaterThan(0)

    // Every rollup line must match the canonical template
    for (const line of lines) {
      expect(line).toMatch(/\s+\S+\/\s+…\/\s+\(\+\d+ deeper, increase max_depth\)/)
    }
  })

  test("rollup lines have consistent indent depth-based indentation", async () => {
    const r = await run({ max_depth: 2 }, rollupDir)
    const rollupLines = r.output.split("\n").filter((l) => l.includes("deeper, increase max_depth"))

    // All rollup lines should start with whitespace (indented, not bare)
    for (const line of rollupLines) {
      expect(line).toMatch(/^\s+/)
    }
  })
})
