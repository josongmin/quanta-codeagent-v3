import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import type { NavRenamePreview } from "@/tool/lsp_nav/types"
import { emptyTrace, fakeProvider, findTool, run } from "./lsp-nav-fixtures"

describe("lsp_rename_preview", () => {
  test("golden: 1-based range + placeholder", async () => {
    const preview: NavRenamePreview = {
      placeholder: "oldName",
      range: { start: { line: 4, character: 6 }, end: { line: 4, character: 13 } },
    }
    const trace = emptyTrace()
    const t = findTool(
      "lsp_rename_preview",
      fakeProvider(
        {
          prepareRename: async (fp, p) => {
            trace.filePath = fp
            trace.pos = p
            return preview
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "a.ts", line: 5, character: 7 })
    expect(trace.pos).toEqual({ line: 4, character: 6 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("Renameable identifier 'oldName' at a.ts:5:7 (range 5:7..5:14)")
  })

  test("null ⇒ rename not available", async () => {
    const t = findTool("lsp_rename_preview", fakeProvider({}, emptyTrace()))
    const { result } = await run(t, { path: "a.ts", line: 5, character: 7 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("a.ts:5:7: rename not available")
  })

  test("unavailable + spawn error", async () => {
    const r1 = await run(findTool("lsp_rename_preview", nullLspNavProvider), {
      path: "a.ts",
      line: 1,
      character: 1,
    })
    expect(r1.result.ok).toBe(false)
    const r2 = await run(
      findTool("lsp_rename_preview", {
        unavailableReason: () => "n/a",
        open: async () => {
          throw new Error("xxx")
        },
      }),
      { path: "a.ts", line: 1, character: 1 },
    )
    expect(r2.result.output).toBe("lsp_rename_preview unavailable: xxx")
  })

  test("session crash still calls stop()", async () => {
    const trace = emptyTrace()
    const t = findTool(
      "lsp_rename_preview",
      fakeProvider(
        {
          prepareRename: async () => {
            throw new Error("rip")
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toBe("lsp_rename_preview failed: rip")
    expect(trace.stopped).toBe(true)
  })
})
