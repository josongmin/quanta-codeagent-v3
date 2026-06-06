import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"

const dir = mkdtempSync(join(tmpdir(), "glob-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown, cwd = dir): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of globTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// Tree:
//   a.ts, b.ts, c.txt
//   src/nested/deep.ts
//   .hidden/secret.ts
mkdirSync(join(dir, "src", "nested"), { recursive: true })
mkdirSync(join(dir, ".hidden"), { recursive: true })
writeFileSync(join(dir, "a.ts"), "1")
writeFileSync(join(dir, "b.ts"), "2")
writeFileSync(join(dir, "c.txt"), "3")
writeFileSync(join(dir, "src", "nested", "deep.ts"), "4")
writeFileSync(join(dir, ".hidden", "secret.ts"), "5")

describe("globTool", () => {
  test("metadata: read-only and concurrency-safe", () => {
    expect(globTool.name).toBe("glob")
    expect(globTool.isReadOnly()).toBe(true)
    expect(globTool.isConcurrencySafe({ pattern: "*" })).toBe(true)
  })

  test("matches files and returns relative paths (rg glob semantics)", async () => {
    // NOTE (engine swap): under ripgrep `-g` semantics a bare `*.ts` glob
    // matches a basename at ANY depth (it is the gitignore-style glob Claude /
    // Cursor use), unlike Bun.Glob's top-level-only `*.ts`. Order is mtime-DESC
    // now, so compare set-wise.
    const r = await run({ pattern: "*.ts" })
    expect(r.ok).toBe(true)
    expect(r.output.split("\n").sort()).toEqual(["a.ts", "b.ts", join("src", "nested", "deep.ts")])
  })

  test("recursive ** pattern reaches nested files", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    expect(r.output.split("\n").sort()).toEqual(["a.ts", "b.ts", join("src", "nested", "deep.ts")])
  })

  test("explicit path overrides ctx.cwd (in-jail subdir)", async () => {
    // S14: globTool's explicit `path` is now JAIL-VALIDATED — must resolve
    // inside ctx.cwd. The old test used `tmpdir()` siblings; that's an
    // intentional escape under the new contract and is rejected with
    // `Path escapes the working-directory jail`. We test the legitimate
    // "override to a SUBDIR of cwd" path which is what real callers use.
    const sub = join(dir, "sub-override")
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, "only.ts"), "x")
    const r = await run({ pattern: "*.ts", path: sub }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toBe("only.ts")
  })

  test("explicit path OUTSIDE ctx.cwd is REFUSED (S14)", async () => {
    const other = mkdtempSync(join(tmpdir(), "glob-test-other-"))
    try {
      writeFileSync(join(other, "only.ts"), "x")
      const r = await run({ pattern: "*.ts", path: other }, dir)
      expect(r.ok).toBe(false)
      expect(r.output).toContain("escapes the working-directory jail")
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test("dotfiles directories are excluded by default", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.output).not.toContain("secret.ts")
  })

  test("no match returns ok with a friendly message", async () => {
    const r = await run({ pattern: "*.md" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("(no files matched)")
  })

  test("schema rejects missing pattern", () => {
    expect(globTool.inputSchema.safeParse({}).success).toBe(false)
  })
})
