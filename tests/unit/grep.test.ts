import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { grepTool } from "@/tool/grep"

const dir = mkdtempSync(join(tmpdir(), "grep-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const collect = async (input: unknown): Promise<{ result: ToolResult; events: ToolEvent[] }> => {
  const events: ToolEvent[] = []
  let result: ToolResult | undefined
  for await (const ev of grepTool.execute(input as never, ctx(dir))) {
    events.push(ev)
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, events }
}

mkdirSync(join(dir, "sub"), { recursive: true })
writeFileSync(join(dir, "a.ts"), "const needle = 1\nconst other = 2\n")
writeFileSync(join(dir, "b.ts"), "// no match here\n")
writeFileSync(join(dir, "sub", "c.ts"), "function needle() {}\n")
writeFileSync(join(dir, "notes.md"), "needle in markdown\n")

describe("grepTool", () => {
  test("metadata: read-only and concurrency-safe", () => {
    expect(grepTool.name).toBe("grep")
    expect(grepTool.isReadOnly()).toBe(true)
    expect(grepTool.isConcurrencySafe({ pattern: "x" })).toBe(true)
  })

  test("emits a progress event before the result", async () => {
    const { events } = await collect({ pattern: "needle" })
    expect(events[0]).toEqual({ type: "progress", message: "searching for needle…" })
  })

  test("finds matches across files as path:line:match rows", async () => {
    const { result } = await collect({ pattern: "needle" })
    expect(result.ok).toBe(true)
    const rows = result.output.split("\n").sort()
    expect(rows).toContain("a.ts:1:const needle = 1")
    expect(rows).toContain(`${join("sub", "c.ts")}:1:function needle() {}`)
    expect(rows).toContain("notes.md:1:needle in markdown")
  })

  test("glob filter restricts the searched files", async () => {
    const { result } = await collect({ pattern: "needle", glob: "*.md" })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("notes.md:1:needle in markdown")
  })

  test("path argument scopes the search to a single file", async () => {
    // rg on a single explicit file omits the path prefix (line:match only).
    const { result } = await collect({ pattern: "needle", path: "a.ts" })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("1:const needle = 1")
  })

  test("path argument rejects a whitespace-joined multi-path string before spawning rg", async () => {
    const { result } = await collect({ pattern: "needle", path: "a.ts sub" })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("grep path must name one existing file or directory")
    expect(result.output).toContain("received: a.ts sub")
  })

  test("no matches returns ok with (no matches)", async () => {
    const { result } = await collect({ pattern: "zzz_absent_zzz" })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("(no matches)")
  })

  test("regex syntax is honored", async () => {
    const { result } = await collect({ pattern: "^const \\w+ = \\d" })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("a.ts:1:const needle = 1")
  })

  test("schema rejects missing pattern", () => {
    expect(grepTool.inputSchema.safeParse({}).success).toBe(false)
  })

  test("output_mode=count returns per-file match counts", async () => {
    // rg -c emits `path:count` rows; two files contain `needle`.
    const { result } = await collect({ pattern: "needle", output_mode: "count" })
    expect(result.ok).toBe(true)
    const rows = result.output.split("\n").sort()
    expect(rows).toContain("a.ts:1")
    expect(rows).toContain("notes.md:1")
  })

  test("output_mode=files_with_matches returns paths only", async () => {
    const { result } = await collect({ pattern: "needle", output_mode: "files_with_matches" })
    expect(result.ok).toBe(true)
    const rows = result.output.split("\n").sort()
    expect(rows).toContain("a.ts")
    expect(rows).toContain("notes.md")
    // No `:line:` content rows under -l.
    expect(result.output).not.toContain("const needle")
  })

  test("context lines (-A) include the following line", async () => {
    const { result } = await collect({ pattern: "needle", path: "a.ts", A: 1 })
    expect(result.ok).toBe(true)
    // rg -A 1 emits the match then the trailing context line.
    expect(result.output).toContain("const needle = 1")
    expect(result.output).toContain("const other = 2")
  })

  test("case-insensitive flag matches mixed case", async () => {
    const { result } = await collect({ pattern: "NEEDLE", i: true, path: "a.ts" })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("const needle = 1")
  })
})
