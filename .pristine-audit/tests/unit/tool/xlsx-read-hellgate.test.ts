import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@/tool"
import { xlsxReadTool } from "@/tool/document/xlsx-read"

const tool = xlsxReadTool

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

const exec = async (input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | null = null
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last ?? { ok: false, output: "no result" }
}

// jun-04 — the stub (ADR-0138 deferral) is RESOLVED; xlsx_read is a real pure-TS
// OOXML reader. Full round-trip/adversarial coverage lives in
// `tests/unit/xlsx-docx-read-hellgate.test.ts`; this file pins the tool surface.
describe("xlsx_read — real reader (tool surface)", () => {
  test("HELL-1: metadata — name + read-only + concurrency-safe", () => {
    expect(tool.name).toBe("xlsx_read")
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.isConcurrencySafe?.({ path: "x.xlsx" } as never)).toBe(true)
  })

  test("HELL-2: input validation rejects bad shape", async () => {
    const r = await exec({})
    expect(r.ok).toBe(false)
  })

  test("HELL-3: a nonexistent file yields a typed not-found (no throw, no deferral)", async () => {
    const r = await exec({ path: "definitely-not-here.xlsx" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("not found")
  })
})
