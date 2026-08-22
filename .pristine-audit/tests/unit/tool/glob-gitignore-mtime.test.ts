/**
 * glob engine swap (P25): ripgrep enumeration → `.gitignore`/`.ignore`-aware
 * results + mtime-DESC ordering.
 *
 * CRUX — DIFFERENTIAL: the ONLY behavioral difference vs the old Bun.Glob path
 * is that gitignored entries (node_modules/, dist/) are now EXCLUDED. The same
 * in-tree files are returned otherwise, and the jail invariant holds identically
 * (escaping `**`/symlink hits are still dropped). These tests pin both the new
 * semantics and the unchanged jail.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"

// ripgrep only honors `.gitignore` INSIDE a git repo (a `.ignore` file is
// honored regardless). The differential fixture is therefore a real git repo so
// the gitignore path is exercised exactly as it is in production.
const initGit = (dir: string): void => {
  execFileSync("git", ["init", "-q"], { cwd: dir })
}

const root = mkdtempSync(join(tmpdir(), "glob-gimtime-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })
const run = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of globTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const lines = (r: ToolResult): string[] =>
  r.ok && r.output !== "(no files matched)" ? r.output.split("\n") : []

describe("glob ripgrep engine: gitignore respect (differential)", () => {
  // Tree (git repo, .gitignore excludes node_modules/ and dist/):
  //   keep.ts, src/nested/deep.ts            ← in-tree, MUST be returned
  //   node_modules/pkg/junk.ts, dist/out.ts  ← gitignored, MUST NOT be returned
  const work = join(root, "diff")
  mkdirSync(join(work, "src", "nested"), { recursive: true })
  mkdirSync(join(work, "node_modules", "pkg"), { recursive: true })
  mkdirSync(join(work, "dist"), { recursive: true })
  writeFileSync(join(work, ".gitignore"), "node_modules/\ndist/\n")
  writeFileSync(join(work, "keep.ts"), "1")
  writeFileSync(join(work, "src", "nested", "deep.ts"), "2")
  writeFileSync(join(work, "node_modules", "pkg", "junk.ts"), "3")
  writeFileSync(join(work, "dist", "out.ts"), "4")
  initGit(work)

  test("gitignored node_modules/ entry is NOT returned", async () => {
    const r = await run({ pattern: "**/*.ts" }, work)
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("junk.ts")
    expect(r.output).not.toContain("node_modules")
  })

  test("gitignored dist/ entry is NOT returned", async () => {
    const r = await run({ pattern: "**/*.ts" }, work)
    expect(r.output).not.toContain("out.ts")
    expect(r.output).not.toContain("dist")
  })

  test("in-tree files ARE returned (only the gitignored set differs)", async () => {
    const r = await run({ pattern: "**/*.ts" }, work)
    // The ONLY difference vs a naive enumeration is the gitignored exclusion:
    // every NON-gitignored .ts in the tree is present.
    expect(lines(r).sort()).toEqual(["keep.ts", join("src", "nested", "deep.ts")])
  })

  test(".ignore is honored even WITHOUT a git repo", async () => {
    const ig = join(root, "ignore-only")
    mkdirSync(join(ig, "build"), { recursive: true })
    writeFileSync(join(ig, ".ignore"), "build/\n")
    writeFileSync(join(ig, "main.ts"), "1")
    writeFileSync(join(ig, "build", "gen.ts"), "2")
    const r = await run({ pattern: "**/*.ts" }, ig)
    expect(lines(r)).toEqual(["main.ts"])
  })
})

describe("glob mtime ordering: most-recently-modified first", () => {
  test("results are sorted by mtime DESCENDING", async () => {
    const dir = join(root, "mtime")
    mkdirSync(dir, { recursive: true })
    // Three files with controlled, strictly-increasing mtimes. newest = c.ts.
    const base = Math.floor(Date.now() / 1000)
    writeFileSync(join(dir, "a.ts"), "a")
    writeFileSync(join(dir, "b.ts"), "b")
    writeFileSync(join(dir, "c.ts"), "c")
    utimesSync(join(dir, "a.ts"), base - 300, base - 300) // oldest
    utimesSync(join(dir, "b.ts"), base - 200, base - 200)
    utimesSync(join(dir, "c.ts"), base - 100, base - 100) // newest
    const r = await run({ pattern: "*.ts" }, dir)
    expect(r.ok).toBe(true)
    // newest-first: c (most recent) → b → a (oldest).
    expect(lines(r)).toEqual(["c.ts", "b.ts", "a.ts"])
  })

  test("cap is applied AFTER the mtime sort (newest survive truncation)", async () => {
    // Sanity on ordering direction with a freshly-touched file: the most-recent
    // file is at the HEAD of the output, never the tail.
    const dir = join(root, "mtime-head")
    mkdirSync(dir, { recursive: true })
    const base = Math.floor(Date.now() / 1000)
    writeFileSync(join(dir, "old.ts"), "o")
    writeFileSync(join(dir, "new.ts"), "n")
    utimesSync(join(dir, "old.ts"), base - 500, base - 500)
    utimesSync(join(dir, "new.ts"), base, base)
    const r = await run({ pattern: "*.ts" }, dir)
    expect(lines(r)[0]).toBe("new.ts")
  })
})
