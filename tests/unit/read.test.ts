import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { readTool } from "@/tool/read"

const dir = mkdtempSync(join(tmpdir(), "read-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("readTool", () => {
  test("metadata: read-only and concurrency-safe", () => {
    expect(readTool.name).toBe("read")
    expect(readTool.isReadOnly()).toBe(true)
    expect(readTool.isConcurrencySafe({ path: "x" })).toBe(true)
  })

  test("reads a file with 1-based line numbers", async () => {
    const f = join(dir, "lines.txt")
    writeFileSync(f, "alpha\nbeta\ngamma")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\talpha\n2\tbeta\n3\tgamma")
  })

  test("empty file yields a single numbered blank line", async () => {
    const f = join(dir, "empty.txt")
    writeFileSync(f, "")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\t")
  })

  test("offset past EOF produces the (empty file) sentinel", async () => {
    const f = join(dir, "past-eof.txt")
    writeFileSync(f, "only\n")
    const r = await run({ path: f, offset: 99 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("(empty file)")
  })

  test("offset starts from the given 1-based line", async () => {
    const f = join(dir, "offset.txt")
    writeFileSync(f, "l1\nl2\nl3\nl4")
    const r = await run({ path: f, offset: 3 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("3\tl3\n4\tl4")
  })

  test("limit caps lines and appends a more-lines note", async () => {
    const f = join(dir, "limit.txt")
    writeFileSync(f, "a\nb\nc\nd\ne")
    const r = await run({ path: f, limit: 2 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\ta\n2\tb\n… (3 more lines, use offset)")
  })

  test("offset + limit windows the file without a note when reaching EOF", async () => {
    const f = join(dir, "window.txt")
    writeFileSync(f, "x1\nx2\nx3\nx4")
    const r = await run({ path: f, offset: 3, limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("3\tx3\n4\tx4")
  })

  test("directory path returns ok:false", async () => {
    const sub = join(dir, "adir")
    mkdirSync(sub)
    const r = await run({ path: sub })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("is a directory")
  })

  test("directory path → failure.mode not_found with path (absorb #2)", async () => {
    const sub = join(dir, "adir-typed")
    mkdirSync(sub)
    const r = await run({ path: sub })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "not_found", path: sub })
    // Human-readable output preserved.
    expect(r.output).toContain("is a directory")
  })

  test("FS jail escape → failure.mode permission_denied isReadonly:false (absorb #2)", async () => {
    const jail = mkdtempSync(join(tmpdir(), "read-jail-typed-"))
    const outside = mkdtempSync(join(tmpdir(), "read-outside-typed-"))
    const victim = join(outside, "secret.txt")
    writeFileSync(victim, "top-secret")
    try {
      const prev = process.env.QUANTA_FS_JAIL
      delete process.env.QUANTA_FS_JAIL
      let result: ToolResult | undefined
      for await (const ev of readTool.execute({ path: victim } as never, ctx(jail))) {
        if (ev.type === "result") result = ev.result
      }
      expect(result?.ok).toBe(false)
      expect(result?.failure).toEqual({
        mode: "permission_denied",
        path: victim,
        isReadonly: false,
      })
      if (prev !== undefined) process.env.QUANTA_FS_JAIL = prev
    } finally {
      rmSync(jail, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("missing file rejects with a not-found error", async () => {
    // statFile() runs first and surfaces the OS ENOENT for a missing path.
    await expect(run({ path: join(dir, "ghost.txt") })).rejects.toThrow(/ENOENT|not found/i)
  })

  test("schema rejects a non-string path", () => {
    expect(readTool.inputSchema.safeParse({ path: 123 }).success).toBe(false)
  })

  test("schema rejects limit:0 / negative / non-int (avoids misleading empty read)", () => {
    // A `limit:0` or negative value previously sliced to empty and surfaced the
    // "(empty file)" sentinel on a NON-empty file. The tightened schema rejects
    // these at the boundary with a clear validation error instead.
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 0 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", limit: -5 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1.5 }).success).toBe(false)
    // A positive integer limit is still accepted.
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1 }).success).toBe(true)
  })

  test("schema rejects a negative / non-int offset, accepts 0 and positive ints", () => {
    expect(readTool.inputSchema.safeParse({ path: "x", offset: -1 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 2.5 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 0 }).success).toBe(true)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 3 }).success).toBe(true)
  })

  test("a relative path resolves against ctx.cwd, not process.cwd()", async () => {
    // The file lives only under the session cwd (dir); a bare name must hit it.
    writeFileSync(join(dir, "relative-read.txt"), "from-ctx-cwd")
    const r = await run({ path: "relative-read.txt" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\tfrom-ctx-cwd")
  })
})
