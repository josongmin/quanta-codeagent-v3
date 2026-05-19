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

  test("matches top-level files and returns sorted relative paths", async () => {
    const r = await run({ pattern: "*.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("a.ts\nb.ts")
  })

  test("recursive ** pattern reaches nested files", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    expect(r.output.split("\n").sort()).toEqual(["a.ts", "b.ts", join("src", "nested", "deep.ts")])
  })

  test("explicit path overrides ctx.cwd", async () => {
    const other = mkdtempSync(join(tmpdir(), "glob-test-other-"))
    try {
      writeFileSync(join(other, "only.ts"), "x")
      const r = await run({ pattern: "*.ts", path: other }, dir)
      expect(r.ok).toBe(true)
      expect(r.output).toBe("only.ts")
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
