import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { writeTool } from "@/tool/write"

const dir = mkdtempSync(join(tmpdir(), "write-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of writeTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("writeTool", () => {
  test("metadata: not read-only, not concurrency-safe", () => {
    expect(writeTool.name).toBe("write")
    expect(writeTool.isReadOnly()).toBe(false)
    expect(writeTool.isConcurrencySafe({ path: "x", content: "y" })).toBe(false)
  })

  test("creates a new file and reports Created with byte count", async () => {
    const f = join(dir, "new.txt")
    const r = await run({ path: f, content: "hello world" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Created")
    expect(r.output).toContain("(11 bytes)")
    expect(readFileSync(f, "utf8")).toBe("hello world")
  })

  test("overwrites an existing file and reports Overwrote", async () => {
    const f = join(dir, "over.txt")
    writeFileSync(f, "old")
    const r = await run({ path: f, content: "brand new" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Overwrote")
    expect(readFileSync(f, "utf8")).toBe("brand new")
  })

  test("creates missing parent directories", async () => {
    const f = join(dir, "deep", "nested", "file.txt")
    expect(existsSync(join(dir, "deep"))).toBe(false)
    const r = await run({ path: f, content: "data" })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("data")
  })

  test("content round-trips including newlines and unicode", async () => {
    const f = join(dir, "round.txt")
    const content = "line1\nline2\n日本語\n"
    const r = await run({ path: f, content })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe(content)
    const bytes = Buffer.byteLength(content, "utf8")
    expect(r.output).toContain(`(${bytes} bytes)`)
  })

  test("writes empty content as a zero-byte file", async () => {
    const f = join(dir, "zero.txt")
    const r = await run({ path: f, content: "" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("(0 bytes)")
    expect(readFileSync(f, "utf8")).toBe("")
  })

  test("schema rejects missing content", () => {
    expect(writeTool.inputSchema.safeParse({ path: "p" }).success).toBe(false)
  })

  test("a relative path resolves against ctx.cwd, not process.cwd()", async () => {
    const r = await run({ path: "relative-write.txt", content: "based" })
    expect(r.ok).toBe(true)
    // Written under the session cwd (dir), not the process cwd.
    expect(readFileSync(join(dir, "relative-write.txt"), "utf8")).toBe("based")
    expect(existsSync(join(process.cwd(), "relative-write.txt"))).toBe(false)
  })

  test("FS jail escape → failure.mode permission_denied isReadonly:false (absorb #2)", async () => {
    const jail = mkdtempSync(join(tmpdir(), "write-jail-typed-"))
    const outside = mkdtempSync(join(tmpdir(), "write-outside-typed-"))
    const victim = join(outside, "secret.txt")
    try {
      const prev = process.env.QUANTA_FS_JAIL
      delete process.env.QUANTA_FS_JAIL
      let result: ToolResult | undefined
      for await (const ev of writeTool.execute(
        { path: victim, content: "pwned" } as never,
        ctx(jail),
      )) {
        if (ev.type === "result") result = ev.result
      }
      expect(result?.ok).toBe(false)
      expect(result?.failure).toEqual({
        mode: "permission_denied",
        path: victim,
        isReadonly: false,
      })
      // Denied write is never partial — the victim file was never created.
      expect(existsSync(victim)).toBe(false)
      if (prev !== undefined) process.env.QUANTA_FS_JAIL = prev
    } finally {
      rmSync(jail, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
