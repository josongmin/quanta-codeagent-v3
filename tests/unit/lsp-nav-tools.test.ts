import { describe, expect, test } from "bun:test"
import type { Tool } from "@/tool"
import { lspNavTools, nullLspNavProvider } from "@/tool/lsp_nav"
import { emptyTrace, fakeProvider, findTool, run, TOOL_NAMES } from "./lsp-nav-fixtures"

describe("lspNavTools registration", () => {
  test("exposes all 8 tools, read-only, not concurrency-safe", () => {
    const tools = lspNavTools(nullLspNavProvider)
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const t of tools) {
      expect(t.isReadOnly()).toBe(true)
      // Cast to Tool<unknown> to call isConcurrencySafe with a dummy input.
      const concurrent = (t as Tool<unknown>).isConcurrencySafe({} as unknown)
      expect(concurrent).toBe(false)
    }
  })

  test("input schemas require `path`", () => {
    for (const t of lspNavTools(nullLspNavProvider)) {
      expect(t.inputSchema.safeParse({}).success).toBe(false)
    }
  })

  test("workspace_symbol additionally requires a query", () => {
    const t = findTool("lsp_workspace_symbol", nullLspNavProvider)
    expect(t.inputSchema.safeParse({ path: "a.ts" }).success).toBe(false)
    expect(t.inputSchema.safeParse({ path: "a.ts", query: "Foo" }).success).toBe(true)
  })
})

describe("absolute vs relative path handling", () => {
  test("absolute path is passed through unchanged", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string; line: number; character: number }>(
      "lsp_definition",
      fakeProvider({}, trace),
    )
    await run(t, { path: "/abs/x.ts", line: 1, character: 1 })
    expect(trace.opened.filePath).toBe("/abs/x.ts")
  })

  test("relative path resolved against ctx.cwd", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string; line: number; character: number }>(
      "lsp_definition",
      fakeProvider({}, trace),
    )
    await run(t, { path: "src/y.ts", line: 1, character: 1 })
    expect(trace.opened.filePath).toBe("/repo/src/y.ts")
  })
})
