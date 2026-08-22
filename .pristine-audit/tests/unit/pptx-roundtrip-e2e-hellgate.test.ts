// e2e Hellgate — H14 PPTX follow-up driven through the REAL tool registry.
//
// Proves the END-TO-END capability: with `officeAuthoring` ON, `buildDefaultTools`
// wires `pptx_write`; driving the real `pptx_write` tool produces a real `.pptx`
// on disk whose slide titles + body text come back through the real `pptx_read`
// tool — a TRUE round-trip proving real-format validity.
//
// Also pins the gate posture: `pptx_write` is GATED on `officeAuthoring`
// (alongside xlsx_write/docx_write) while `pptx_read` is a BASE (always-on)
// read-only tool (alongside xlsx_read/docx_read). Knob OFF ⇒ write absent, read
// present.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefaultTools } from "@/tool"
import type { Tool, ToolContext, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

const toolByName = (tools: Tool[], name: string): Tool | undefined =>
  tools.find((t) => t.name === name)

describe("pptx e2e — gate posture (write gated, read BASE)", () => {
  test("knob ON ⇒ pptx_write registered (alongside xlsx_write/docx_write)", () => {
    const names = buildDefaultTools({ officeAuthoring: true }).map((t) => t.name)
    expect(names).toContain("pptx_write")
    expect(names).toContain("xlsx_write")
    expect(names).toContain("docx_write")
  })

  test("knob OFF ⇒ pptx_write ABSENT but pptx_read PRESENT (BASE)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("pptx_write")
    expect(names).toContain("pptx_read")
  })
})

describe("pptx e2e — TRUE round-trip through the real tools", () => {
  test("pptx_write → on-disk .pptx → pptx_read returns titles + body", async () => {
    const tools = buildDefaultTools({ officeAuthoring: true })
    const pptxWrite = toolByName(tools, "pptx_write")
    const pptxRead = toolByName(tools, "pptx_read")
    expect(pptxWrite).toBeDefined()
    expect(pptxRead).toBeDefined()

    const dir = mkdtempSync(join(tmpdir(), "pptx-e2e-"))
    const input = {
      path: "review.pptx",
      slides: [
        { title: "Q3 Operating Review", body: ["Revenue up 12%", 'Risk: <churn> & "ARR"'] },
        { title: "Next Quarter", body: ["Ship pptx_write", "Beat the reference deck"] },
      ],
    }
    const wres = await run(pptxWrite as Tool, input, ctx(dir))
    expect(wres.ok).toBe(true)

    const rres = await run(pptxRead as Tool, { path: "review.pptx" }, ctx(dir))
    expect(rres.ok).toBe(true)
    if (!rres.ok) return
    expect(rres.output).toContain("Q3 Operating Review")
    expect(rres.output).toContain("Revenue up 12%")
    expect(rres.output).toContain('Risk: <churn> & "ARR"')
    expect(rres.output).toContain("Next Quarter")
    expect(rres.output).toContain("Beat the reference deck")
  })
})
