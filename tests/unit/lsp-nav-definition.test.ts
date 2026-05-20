import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import type { LspNavProvider } from "@/tool/lsp_nav/types"
import { emptyTrace, fakeProvider, findTool, loc, run } from "./lsp-nav-fixtures"

describe("lsp_definition", () => {
  test("unavailable: null provider ⇒ ok:false", async () => {
    const t = findTool("lsp_definition", nullLspNavProvider)
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("lsp_definition unavailable: no language server configured")
  })

  test("spawn error ⇒ ok:false", async () => {
    const provider: LspNavProvider = {
      unavailableReason: () => "n/a",
      open: async () => {
        throw new Error("spawn ENOENT")
      },
    }
    const t = findTool("lsp_definition", provider)
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toBe("lsp_definition unavailable: spawn ENOENT")
  })

  test("golden path: returns locations and 0-based pos", async () => {
    const trace = emptyTrace()
    const provider = fakeProvider(
      {
        definition: async (fp, p) => {
          trace.filePath = fp
          trace.pos = p
          return [loc("/abs/x.ts", 9, 4)]
        },
      },
      trace,
    )
    const t = findTool<{ path: string; line: number; character: number }>(
      "lsp_definition",
      provider,
    )
    const { progress, result } = await run(t, { path: "src/a.ts", line: 5, character: 7 })
    expect(trace.opened.filePath).toBe("/repo/src/a.ts")
    expect(trace.pos).toEqual({ line: 4, character: 6 })
    expect(progress).toEqual(["analyzing src/a.ts"])
    expect(result.ok).toBe(true)
    expect(result.output).toContain("definition: 1 result(s)")
    expect(result.output).toContain("/abs/x.ts:10:5")
    expect(trace.stopped).toBe(true)
  })

  test("empty result ⇒ ok:true with 'no results'", async () => {
    const t = findTool("lsp_definition", fakeProvider({}, emptyTrace()))
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("definition: no results")
  })

  test("null (unsupported) ⇒ ok:true with 'not supported here'", async () => {
    const t = findTool(
      "lsp_definition",
      fakeProvider({ definition: async () => null }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("definition: not supported here")
  })

  test("session crash ⇒ ok:false and session.stop still called", async () => {
    const trace = emptyTrace()
    const t = findTool(
      "lsp_definition",
      fakeProvider(
        {
          definition: async () => {
            throw new Error("server died")
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toBe("lsp_definition failed: server died")
    expect(trace.stopped).toBe(true)
  })
})
