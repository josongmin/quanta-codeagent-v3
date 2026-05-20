import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import type { NavSymbolInfo } from "@/tool/lsp_nav/types"
import { emptyTrace, fakeProvider, findTool, run } from "./lsp-nav-fixtures"

describe("lsp_document_symbol", () => {
  const symA: NavSymbolInfo = {
    name: "myFunc",
    kind: "function",
    range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
  }

  test("golden", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string }>(
      "lsp_document_symbol",
      fakeProvider(
        {
          documentSymbol: async (fp) => {
            trace.filePath = fp
            return [symA]
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "src/a.ts" })
    expect(trace.filePath).toBe("/repo/src/a.ts")
    expect(result.ok).toBe(true)
    expect(result.output).toContain("document src/a.ts: 1 result(s)")
    expect(result.output).toContain("function myFunc")
  })

  test("null ⇒ not supported here", async () => {
    const t = findTool(
      "lsp_document_symbol",
      fakeProvider({ documentSymbol: async () => null }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts" })
    expect(result.output).toBe("document a.ts: not supported here")
  })

  test("empty ⇒ no results", async () => {
    const t = findTool("lsp_document_symbol", fakeProvider({}, emptyTrace()))
    const { result } = await run(t, { path: "a.ts" })
    expect(result.output).toBe("document a.ts: no results")
  })

  test("unavailable", async () => {
    const r = await run(findTool("lsp_document_symbol", nullLspNavProvider), { path: "a.ts" })
    expect(r.result.ok).toBe(false)
  })
})
