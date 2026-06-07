/**
 * Hellgate — `lsp_format` tool (ADR-0141).
 *
 * Seal:
 *   A. metadata             — name / isReadOnly=false / isConcurrencySafe=false / hitlTier=pre-approval-ok
 *   B. input validation     — schema rejects malformed input
 *   C. port conversion      — whole-file vs range; 1-based → 0-based
 *   D. output formatting    — null / [] / non-empty
 *   E. error & signal       — port throw / abort
 *   F. determinism          — same input + same fake ⇒ byte-identical output
 */

import { describe, expect, test } from "bun:test"
import type { FormatPort, FormatRange, TextEdit } from "@/lsp"
import { lspFormatTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

interface FakePort extends FormatPort {
  readonly calls: { file: string; range?: FormatRange }[]
  readonly signals: Array<AbortSignal | undefined>
}

const fakePort = (overrides?: Partial<FormatPort>): FakePort => {
  const calls: FakePort["calls"] = []
  const signals: FakePort["signals"] = []
  const base: FormatPort = { format: async () => [] }
  const merged: FormatPort = { ...base, ...(overrides ?? {}) }
  const real = merged.format
  merged.format = async (file, range, signal) => {
    calls.push(range === undefined ? { file } : { file, range })
    signals.push(signal)
    return real(file, range, signal)
  }
  return Object.assign(merged, { calls, signals }) as FakePort
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/work/proj",
  signal: signal ?? new AbortController().signal,
})

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  context: ToolContext = ctx(),
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, context)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

const tEdit = (line: number): TextEdit => ({
  range: { start: { line, character: 0 }, end: { line, character: 10 } },
  newText: "  ",
})

/* ------------------------------------------------------------------ */
/* A. Metadata                                                         */
/* ------------------------------------------------------------------ */

describe("lsp_format — metadata", () => {
  test("HELL-A1: name === 'lsp_format'", () => {
    const t = lspFormatTool(fakePort())
    expect(t.name).toBe("lsp_format")
  })

  test("HELL-A2: isReadOnly() === false", () => {
    const t = lspFormatTool(fakePort())
    expect(t.isReadOnly()).toBe(false)
  })

  test("HELL-A3: isConcurrencySafe() === false", () => {
    const t = lspFormatTool(fakePort())
    expect(t.isConcurrencySafe({ path: "x.ts" })).toBe(false)
  })

  test("HELL-A4: hitlTier() === 'pre-approval-ok'", () => {
    const t = lspFormatTool(fakePort())
    expect(t.hitlTier?.({ path: "x.ts" })).toBe("pre-approval-ok")
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("lsp_format — input validation", () => {
  test("HELL-B5: missing path ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspFormatTool(port), {})
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.calls).toHaveLength(0)
  })

  test("HELL-B6: partial range (missing endLine) ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspFormatTool(port), {
      path: "x.ts",
      range: { startLine: 1, startCharacter: 1, endCharacter: 5 },
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* C. Port conversion                                                  */
/* ------------------------------------------------------------------ */

describe("lsp_format — port conversion", () => {
  test("HELL-C7: omit range ⇒ format called with file only (no 'range' key)", async () => {
    const port = fakePort()
    await collect(lspFormatTool(port), { path: "x.ts" })
    expect(port.calls).toHaveLength(1)
    expect(port.calls[0]).toEqual({ file: "x.ts" })
    expect("range" in (port.calls[0] ?? {})).toBe(false)
  })

  test("HELL-C8: range present ⇒ converted to 0-based on both endpoints", async () => {
    const port = fakePort()
    await collect(lspFormatTool(port), {
      path: "x.ts",
      range: { startLine: 2, startCharacter: 3, endLine: 5, endCharacter: 1 },
    })
    expect(port.calls[0]?.range).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 4, character: 0 },
    })
  })

  test("HELL-C9: tool forwards ctx.signal to the port", async () => {
    const ac = new AbortController()
    const port = fakePort()
    await collect(lspFormatTool(port), { path: "x.ts" }, ctx(ac.signal))
    expect(port.signals[0]).toBe(ac.signal)
  })
})

/* ------------------------------------------------------------------ */
/* D. Output formatting                                                */
/* ------------------------------------------------------------------ */

describe("lsp_format — output formatting", () => {
  test("HELL-D9: null ⇒ '… format not supported here'", async () => {
    const port = fakePort({ format: async () => null })
    const r = await collect(lspFormatTool(port), { path: "x.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts: format not supported here")
  })

  test("HELL-D10: [] (whole-file) ⇒ '… already formatted (no edits)'", async () => {
    const port = fakePort({ format: async () => [] })
    const r = await collect(lspFormatTool(port), { path: "x.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts: format already formatted (no edits)")
  })

  test("HELL-D11: non-empty (whole-file) ⇒ '… produced N edits'", async () => {
    const port = fakePort({ format: async () => [tEdit(0), tEdit(1), tEdit(2)] })
    const r = await collect(lspFormatTool(port), { path: "x.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts: format produced 3 edits")
  })

  test("HELL-D12: range scope label ⇒ 'range format' in output", async () => {
    const port = fakePort({ format: async () => [tEdit(0)] })
    const r = await collect(lspFormatTool(port), {
      path: "x.ts",
      range: { startLine: 1, startCharacter: 1, endLine: 2, endCharacter: 1 },
    })
    expect(r.output).toBe("x.ts: range format produced 1 edit")
  })
})

/* ------------------------------------------------------------------ */
/* E. Error & signal                                                   */
/* ------------------------------------------------------------------ */

describe("lsp_format — error & signal", () => {
  test("HELL-E13: port throw ⇒ ok:false 'lsp_format unavailable: …'", async () => {
    const port = fakePort({
      format: async () => {
        throw new Error("not-implemented: format wire methods missing on LspClient")
      },
    })
    const r = await collect(lspFormatTool(port), { path: "x.ts" })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("lsp_format unavailable:")).toBe(true)
    expect(r.output).toContain("not-implemented")
  })

  test("HELL-E14: signal aborted ⇒ port NOT called", async () => {
    const ac = new AbortController()
    ac.abort()
    const port = fakePort({ format: async () => [tEdit(0)] })
    const r = await collect(lspFormatTool(port), { path: "x.ts" }, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(port.calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* F. Determinism                                                      */
/* ------------------------------------------------------------------ */

describe("lsp_format — determinism", () => {
  test("HELL-F15: same input + same fake data ⇒ byte-identical output", async () => {
    const data = [tEdit(0), tEdit(5)]
    const r1 = await collect(lspFormatTool(fakePort({ format: async () => data })), {
      path: "x.ts",
    })
    const r2 = await collect(lspFormatTool(fakePort({ format: async () => data })), {
      path: "x.ts",
    })
    expect(r1.output).toBe(r2.output)
    expect(r1.ok).toBe(r2.ok)
  })
})
