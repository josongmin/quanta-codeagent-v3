import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import { emptyTrace, fakeProvider, findTool, loc, run } from "./lsp-nav-fixtures"

describe("lsp_type_definition", () => {
  test("golden + empty + null", async () => {
    const t1 = findTool(
      "lsp_type_definition",
      fakeProvider({ typeDefinition: async () => [loc("/abs/t.ts", 0, 0)] }, emptyTrace()),
    )
    const r1 = await run(t1, { path: "a.ts", line: 1, character: 1 })
    expect(r1.result.output).toContain("typeDefinition: 1 result(s)")

    const t2 = findTool("lsp_type_definition", fakeProvider({}, emptyTrace()))
    const r2 = await run(t2, { path: "a.ts", line: 1, character: 1 })
    expect(r2.result.output).toBe("typeDefinition: no results")

    const t3 = findTool(
      "lsp_type_definition",
      fakeProvider({ typeDefinition: async () => null }, emptyTrace()),
    )
    const r3 = await run(t3, { path: "a.ts", line: 1, character: 1 })
    expect(r3.result.output).toBe("typeDefinition: not supported here")
  })

  test("unavailable", async () => {
    const r = await run(findTool("lsp_type_definition", nullLspNavProvider), {
      path: "a.ts",
      line: 1,
      character: 1,
    })
    expect(r.result.ok).toBe(false)
  })
})
