import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  formatDiagnostics,
  nullDiagnosticsProvider,
} from "@/tool"

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

/** Drain a tool run into its progress messages and single terminal result. */
const run = async (
  tool: ReturnType<typeof diagnosticsTool>,
  input: { path: string },
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

const diag = (over: Partial<DiagnosticItem> = {}): DiagnosticItem => ({
  severity: "error",
  message: "Type mismatch",
  range: { start: { line: 0, character: 0 } },
  ...over,
})

describe("formatDiagnostics (pure)", () => {
  test("reports a clean file with no diagnostics", () => {
    expect(formatDiagnostics("a.ts", [])).toBe("a.ts: no diagnostics")
  })

  test("1-based line/col, severity-then-line ordering, summary header", () => {
    const out = formatDiagnostics("a.ts", [
      diag({ severity: "warning", message: "unused", range: { start: { line: 9, character: 2 } } }),
      diag({ message: "bad type", range: { start: { line: 4, character: 0 } } }),
      diag({ message: "early err", range: { start: { line: 1, character: 7 } } }),
    ])
    const lines = out.split("\n")
    expect(lines[0]).toBe("a.ts: 2 error(s), 1 warning(s)")
    // Errors first (sorted by line), then the warning.
    expect(lines[1]).toBe("a.ts:2:8 error early err")
    expect(lines[2]).toBe("a.ts:5:1 error bad type")
    expect(lines[3]).toBe("a.ts:10:3 warning unused")
  })

  test("appends source/code tag and collapses whitespace in the message", () => {
    const out = formatDiagnostics("x.py", [
      diag({ message: "line\n  wrapped", source: "Pyright", code: "reportGeneralTypeIssues" }),
    ])
    expect(out.split("\n")[1]).toBe("x.py:1:1 error line wrapped [Pyright reportGeneralTypeIssues]")
  })
})

describe("diagnostics tool — graceful degradation", () => {
  test("null provider: clean ok:false no-op, never throws", async () => {
    const { result } = await run(diagnosticsTool(nullDiagnosticsProvider), { path: "a.ts" })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("diagnostics unavailable")
    expect(result.output).toContain("no language server configured")
  })

  test("provider that throws on open degrades to a clean error result", async () => {
    const provider: DiagnosticsProvider = {
      unavailableReason: () => "n/a",
      open: async () => {
        throw new Error("spawn ENOENT")
      },
    }
    const { result } = await run(diagnosticsTool(provider), { path: "a.py" })
    expect(result.ok).toBe(false)
    expect(result.output).toBe("diagnostics unavailable: spawn ENOENT")
  })

  test("session.diagnostics rejection degrades and still stops the session", async () => {
    let stopped = false
    const provider: DiagnosticsProvider = {
      unavailableReason: () => "n/a",
      open: async () => ({
        diagnostics: async () => {
          throw new Error("server died")
        },
        stop: async () => {
          stopped = true
        },
      }),
    }
    const { result } = await run(diagnosticsTool(provider), { path: "a.ts" })
    expect(result.ok).toBe(false)
    expect(result.output).toBe("diagnostics failed: server died")
    expect(stopped).toBe(true)
  })
})

describe("diagnostics tool — happy path with an injected fake client", () => {
  const fakeProvider = (diags: DiagnosticItem[], seen: { path?: string }): DiagnosticsProvider => ({
    unavailableReason: () => "n/a",
    open: async (): Promise<DiagnosticsSession> => ({
      diagnostics: async (filePath: string) => {
        seen.path = filePath
        return diags
      },
      stop: async () => undefined,
    }),
  })

  test("resolves a relative path against ctx.cwd and emits progress", async () => {
    const seen: { path?: string } = {}
    const { progress, result } = await run(diagnosticsTool(fakeProvider([], seen)), {
      path: "src/a.ts",
    })
    expect(seen.path).toBe("/repo/src/a.ts")
    expect(progress).toEqual(["analyzing src/a.ts"])
    expect(result.ok).toBe(true)
    expect(result.output).toBe("src/a.ts: no diagnostics")
  })

  test("ok:false when any error diagnostic is present", async () => {
    // S14: paths now go through the FS jail (`ctx.cwd === "/repo"`). Use an
    // in-jail abs path so the jail accepts it; the original `/abs/a.py` was
    // an escape and is now refused upstream of the provider.
    const { result } = await run(diagnosticsTool(fakeProvider([diag()], {})), {
      path: "/repo/a.py",
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("/repo/a.py: 1 error(s)")
  })

  test("ok:true when only warnings are present", async () => {
    const { result } = await run(
      diagnosticsTool(fakeProvider([diag({ severity: "warning", message: "w" })], {})),
      { path: "a.ts" },
    )
    expect(result.ok).toBe(true)
  })
})

describe("tool metadata / conservative flags", () => {
  const tool = diagnosticsTool(nullDiagnosticsProvider)
  test("named 'diagnostics', read-only, not concurrency-safe", () => {
    expect(tool.name).toBe("diagnostics")
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe({ path: "x" })).toBe(false)
  })
  test("input schema requires a path string", () => {
    expect(tool.inputSchema.safeParse({}).success).toBe(false)
    expect(tool.inputSchema.safeParse({ path: "a.ts" }).success).toBe(true)
  })
})
