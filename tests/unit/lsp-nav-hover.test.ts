import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import type { NavHover } from "@/tool/lsp_nav/types"
import { emptyTrace, fakeProvider, findTool, run } from "./lsp-nav-fixtures"

describe("lsp_hover", () => {
  test("golden path renders hover contents", async () => {
    const trace = emptyTrace()
    const hover: NavHover = { contents: "function f(): void" }
    const t = findTool(
      "lsp_hover",
      fakeProvider(
        {
          hover: async (fp, p) => {
            trace.filePath = fp
            trace.pos = p
            return hover
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "a.ts", line: 3, character: 4 })
    expect(trace.pos).toEqual({ line: 2, character: 3 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("a.ts:3:4: hover")
    expect(result.output).toContain("function f(): void")
  })

  test("null hover ⇒ ok:true with 'no hover'", async () => {
    const t = findTool("lsp_hover", fakeProvider({}, emptyTrace()))
    const { result } = await run(t, { path: "a.ts", line: 3, character: 4 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("a.ts:3:4: no hover")
  })

  test("unavailable + spawn error", async () => {
    const r1 = await run(findTool("lsp_hover", nullLspNavProvider), {
      path: "a.ts",
      line: 1,
      character: 1,
    })
    expect(r1.result.ok).toBe(false)
    const r2 = await run(
      findTool("lsp_hover", {
        unavailableReason: () => "n/a",
        open: async () => {
          throw new Error("nope")
        },
      }),
      { path: "a.ts", line: 1, character: 1 },
    )
    expect(r2.result.output).toBe("lsp_hover unavailable: nope")
  })
})
