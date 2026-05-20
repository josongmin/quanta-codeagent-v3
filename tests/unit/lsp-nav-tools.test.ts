import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"
import { lspNavTools, nullLspNavProvider } from "@/tool/lsp_nav"
import type {
  LspNavProvider,
  LspNavSession,
  NavHover,
  NavLocation,
  NavPos,
  NavRenamePreview,
  NavSymbolInfo,
} from "@/tool/lsp_nav/types"

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const run = async <I>(
  tool: Tool<I>,
  input: I,
): Promise<{ progress: string[]; result: ToolResult }> => {
  const progress: string[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "progress") progress.push(ev.message)
    else result = ev.result
  }
  if (!result) throw new Error("tool produced no result")
  return { progress, result }
}

const findTool = <I>(name: string, provider: LspNavProvider): Tool<I> => {
  const tools = lspNavTools(provider) as Tool<I>[]
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool '${name}' not registered`)
  return t
}

/** Capture which session methods were called and stop-tracking. */
interface Trace {
  stopped: boolean
  opened: { filePath?: string; cwd?: string }
  pos?: NavPos
  filePath?: string
  query?: string
  includeDeclaration?: boolean
}

const loc = (path: string, line: number, character: number): NavLocation => ({
  uri: pathToFileURL(path).toString(),
  range: {
    start: { line, character },
    end: { line, character: character + 1 },
  },
})

/** Build a provider whose session methods can be selectively overridden. */
const fakeProvider = (overrides: Partial<LspNavSession>, trace: Trace): LspNavProvider => ({
  unavailableReason: () => "no language server configured",
  open: async (filePath: string, cwd: string) => {
    trace.opened = { filePath, cwd }
    const session: LspNavSession = {
      definition: async (fp, p) => {
        trace.filePath = fp
        trace.pos = p
        return []
      },
      references: async (fp, p, inc) => {
        trace.filePath = fp
        trace.pos = p
        trace.includeDeclaration = inc
        return []
      },
      hover: async (fp, p) => {
        trace.filePath = fp
        trace.pos = p
        return null
      },
      typeDefinition: async (fp, p) => {
        trace.filePath = fp
        trace.pos = p
        return []
      },
      implementation: async (fp, p) => {
        trace.filePath = fp
        trace.pos = p
        return []
      },
      documentSymbol: async (fp) => {
        trace.filePath = fp
        return []
      },
      workspaceSymbol: async (q) => {
        trace.query = q
        return []
      },
      prepareRename: async (fp, p) => {
        trace.filePath = fp
        trace.pos = p
        return null
      },
      stop: async () => {
        trace.stopped = true
      },
      ...overrides,
    }
    return session
  },
})

const emptyTrace = (): Trace => ({ stopped: false, opened: {} })

const TOOL_NAMES = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
  "lsp_rename_preview",
] as const

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

describe("lsp_references", () => {
  test("forwards includeDeclaration with default true", async () => {
    const trace = emptyTrace()
    const t = findTool<{
      path: string
      line: number
      character: number
      includeDeclaration?: boolean
    }>(
      "lsp_references",
      fakeProvider(
        {
          references: async (fp, p, inc) => {
            trace.filePath = fp
            trace.pos = p
            trace.includeDeclaration = inc
            return [loc("/abs/a.ts", 1, 2), loc("/abs/b.ts", 3, 0)]
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "a.ts", line: 2, character: 3 })
    expect(trace.includeDeclaration).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("references: 2 result(s)")
  })

  test("explicit includeDeclaration:false is honored", async () => {
    const trace = emptyTrace()
    const t = findTool<{
      path: string
      line: number
      character: number
      includeDeclaration?: boolean
    }>("lsp_references", fakeProvider({}, trace))
    await run(t, { path: "a.ts", line: 1, character: 1, includeDeclaration: false })
    expect(trace.includeDeclaration).toBe(false)
  })

  test("null ⇒ ok:true / not supported", async () => {
    const t = findTool(
      "lsp_references",
      fakeProvider({ references: async () => null }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.output).toBe("references: not supported here")
  })

  test("unavailable + spawn error", async () => {
    const nullT = findTool("lsp_references", nullLspNavProvider)
    const r1 = await run(nullT, { path: "a.ts", line: 1, character: 1 })
    expect(r1.result.ok).toBe(false)
    const errT = findTool("lsp_references", {
      unavailableReason: () => "n/a",
      open: async () => {
        throw new Error("boom")
      },
    })
    const r2 = await run(errT, { path: "a.ts", line: 1, character: 1 })
    expect(r2.result.output).toBe("lsp_references unavailable: boom")
  })
})

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

describe("lsp_implementation", () => {
  test("golden + empty + null", async () => {
    const t1 = findTool(
      "lsp_implementation",
      fakeProvider({ implementation: async () => [loc("/abs/i.ts", 2, 2)] }, emptyTrace()),
    )
    const r1 = await run(t1, { path: "a.ts", line: 1, character: 1 })
    expect(r1.result.output).toContain("implementation: 1 result(s)")
    expect(r1.result.output).toContain("/abs/i.ts:3:3")

    const t2 = findTool("lsp_implementation", fakeProvider({}, emptyTrace()))
    const r2 = await run(t2, { path: "a.ts", line: 1, character: 1 })
    expect(r2.result.output).toBe("implementation: no results")

    const t3 = findTool(
      "lsp_implementation",
      fakeProvider({ implementation: async () => null }, emptyTrace()),
    )
    const r3 = await run(t3, { path: "a.ts", line: 1, character: 1 })
    expect(r3.result.output).toBe("implementation: not supported here")
  })

  test("spawn error", async () => {
    const r = await run(
      findTool("lsp_implementation", {
        unavailableReason: () => "n/a",
        open: async () => {
          throw new Error("blew up")
        },
      }),
      { path: "a.ts", line: 1, character: 1 },
    )
    expect(r.result.output).toBe("lsp_implementation unavailable: blew up")
  })
})

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

describe("lsp_workspace_symbol", () => {
  test("golden: query forwarded to session.workspaceSymbol", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string; query: string }>(
      "lsp_workspace_symbol",
      fakeProvider(
        {
          workspaceSymbol: async (q) => {
            trace.query = q
            return [
              {
                name: "MyClass",
                kind: "class",
                range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                selectionRange: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 13 },
                },
                uri: pathToFileURL("/abs/m.ts").toString(),
              },
            ]
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "src/a.ts", query: "MyCl" })
    expect(trace.query).toBe("MyCl")
    expect(result.output).toContain("workspace 'MyCl': 1 result(s)")
    expect(result.output).toContain("class MyClass /abs/m.ts:1:7")
  })

  test("null ⇒ ok:true / not supported", async () => {
    const t = findTool<{ path: string; query: string }>(
      "lsp_workspace_symbol",
      fakeProvider({ workspaceSymbol: async () => null }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", query: "x" })
    expect(result.output).toBe("workspace 'x': not supported here")
  })

  test("unavailable", async () => {
    const r = await run(
      findTool<{ path: string; query: string }>("lsp_workspace_symbol", nullLspNavProvider),
      {
        path: "a.ts",
        query: "Foo",
      },
    )
    expect(r.result.ok).toBe(false)
  })
})

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
