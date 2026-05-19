import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import { applyExactEdit } from "../../src/tool/edit/exact"

const dir = mkdtempSync(join(tmpdir(), "edit-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("editTool path resolution", () => {
  test("a relative path resolves against ctx.cwd, not process.cwd()", async () => {
    // File exists only under the session cwd (dir); a bare name must hit it.
    writeFileSync(join(dir, "relative-edit.txt"), "const a = 1")
    const r = await run({
      path: "relative-edit.txt",
      old_string: "1",
      new_string: "2",
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "relative-edit.txt"), "utf8")).toBe("const a = 2")
  })
})

describe("applyExactEdit", () => {
  test("replaces a unique occurrence", () => {
    const r = applyExactEdit("const a = 1", "1", "2", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("const a = 2")
  })

  test("rejects ambiguous match without replace_all", () => {
    const r = applyExactEdit("a a a", "a", "b", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
  })

  test("replace_all rewrites every occurrence", () => {
    const r = applyExactEdit("a a a", "a", "b", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("b b b")
  })

  test("rejects missing old_string", () => {
    expect(applyExactEdit("xyz", "q", "w", false).ok).toBe(false)
  })
})
