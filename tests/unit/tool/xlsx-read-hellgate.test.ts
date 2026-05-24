import { describe, expect, test } from "bun:test"
import { xlsxReadTool } from "@/tool/document/xlsx-read"
import type { ToolContext } from "@/tool"

const tool = xlsxReadTool

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

const exec = async (input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | null = null
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last ?? { ok: false, output: "no result" }
}

describe("xlsx_read — stub (ADR-0137 Part 3; deps deferred to ADR-0138)", () => {
  test("HELL-1: metadata — name + read-only + concurrency-safe", () => {
    expect(tool.name).toBe("xlsx_read")
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.isConcurrencySafe?.({ path: "x.xlsx" } as never)).toBe(true)
  })

  test("HELL-2: input validation rejects bad shape BEFORE deferral", async () => {
    const r = await exec({})
    expect(r.ok).toBe(false)
  })

  test("HELL-3: execute on valid input returns typed deferral message", async () => {
    const r = await exec({ path: "file.xlsx" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not yet implemented")
    expect(r.output).toContain("ADR-0138")
  })
})
