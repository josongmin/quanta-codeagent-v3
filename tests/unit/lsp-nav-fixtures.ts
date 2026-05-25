// Shared fixtures for the lsp-nav per-tool test suites.
// Extracted from `lsp-nav-tools.test.ts` as part of refactor C (split 500+ line
// multi-concern test files into focused suites). Pure helpers — no describe/test.

import { pathToFileURL } from "node:url"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"
import { lspNavTools } from "@/tool/lsp_nav"
import type { LspNavProvider, LspNavSession, NavLocation, NavPos } from "@/tool/lsp_nav/types"

export const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/repo",
  signal: signal ?? new AbortController().signal,
})

export const run = async <I>(
  tool: Tool<I>,
  input: I,
  signal?: AbortSignal,
): Promise<{ progress: string[]; result: ToolResult }> => {
  const progress: string[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx(signal)) as AsyncIterable<ToolEvent>) {
    if (ev.type === "progress") progress.push(ev.message)
    else result = ev.result
  }
  if (!result) throw new Error("tool produced no result")
  return { progress, result }
}

export const findTool = <I>(name: string, provider: LspNavProvider): Tool<I> => {
  const tools = lspNavTools(provider) as Tool<I>[]
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool '${name}' not registered`)
  return t
}

/** Capture which session methods were called and stop-tracking. */
export interface Trace {
  stopped: boolean
  opened: { filePath?: string; cwd?: string }
  pos?: NavPos
  filePath?: string
  query?: string
  includeDeclaration?: boolean
  signal?: AbortSignal | undefined
}

export const loc = (path: string, line: number, character: number): NavLocation => ({
  uri: pathToFileURL(path).toString(),
  range: {
    start: { line, character },
    end: { line, character: character + 1 },
  },
})

/** Build a provider whose session methods can be selectively overridden. */
export const fakeProvider = (overrides: Partial<LspNavSession>, trace: Trace): LspNavProvider => ({
  unavailableReason: () => "no language server configured",
  open: async (filePath: string, cwd: string) => {
    trace.opened = { filePath, cwd }
    const session: LspNavSession = {
      definition: async (fp, p, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.signal = signal
        return []
      },
      references: async (fp, p, inc, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.includeDeclaration = inc
        trace.signal = signal
        return []
      },
      hover: async (fp, p, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.signal = signal
        return null
      },
      typeDefinition: async (fp, p, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.signal = signal
        return []
      },
      implementation: async (fp, p, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.signal = signal
        return []
      },
      documentSymbol: async (fp, signal) => {
        trace.filePath = fp
        trace.signal = signal
        return []
      },
      workspaceSymbol: async (q, signal) => {
        trace.query = q
        trace.signal = signal
        return []
      },
      prepareRename: async (fp, p, signal) => {
        trace.filePath = fp
        trace.pos = p
        trace.signal = signal
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

export const emptyTrace = (): Trace => ({ stopped: false, opened: {} })

export const TOOL_NAMES = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
  "lsp_rename_preview",
] as const
