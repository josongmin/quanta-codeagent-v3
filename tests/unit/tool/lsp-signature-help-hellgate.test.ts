/**
 * Hellgate — `lsp_signature_help` tool (ADR-0141).
 *
 * Seal:
 *   A. metadata             — name / isReadOnly=true / isConcurrencySafe=true
 *   B. input validation     — schema rejects malformed input + 1-based coords
 *   C. port conversion      — 1-based → 0-based
 *   D. output formatting    — null / [] / single / multi with active param
 *   E. error & signal       — port throw / abort
 *   F. determinism          — same input + same fake ⇒ byte-identical output
 */

import { describe, expect, test } from "bun:test"
import type { SignatureHelpPort, SignatureInfo } from "@/lsp"
import { lspSignatureHelpTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

interface FakePort extends SignatureHelpPort {
  readonly calls: { file: string; line: number; col: number }[]
  readonly signals: Array<AbortSignal | undefined>
}

const fakePort = (overrides?: Partial<SignatureHelpPort>): FakePort => {
  const calls: FakePort["calls"] = []
  const signals: FakePort["signals"] = []
  const base: SignatureHelpPort = { signatureHelp: async () => [] }
  const merged: SignatureHelpPort = { ...base, ...(overrides ?? {}) }
  const real = merged.signatureHelp
  merged.signatureHelp = async (file, line, col, signal) => {
    calls.push({ file, line, col })
    signals.push(signal)
    return real(file, line, col, signal)
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

const sig = (label: string, params: string[], active?: number | null): SignatureInfo => {
  const out: SignatureInfo = {
    label,
    parameters: params.map((p) => ({ label: p })),
  }
  if (active !== undefined) out.activeParameter = active
  return out
}

/* ------------------------------------------------------------------ */
/* A. Metadata                                                         */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — metadata", () => {
  test("HELL-A1: name === 'lsp_signature_help'", () => {
    const t = lspSignatureHelpTool(fakePort())
    expect(t.name).toBe("lsp_signature_help")
  })

  test("HELL-A2: isReadOnly() === true", () => {
    const t = lspSignatureHelpTool(fakePort())
    expect(t.isReadOnly()).toBe(true)
  })

  test("HELL-A3: isConcurrencySafe() === true", () => {
    const t = lspSignatureHelpTool(fakePort())
    expect(t.isConcurrencySafe({ path: "x.ts", line: 1, character: 1 })).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — input validation", () => {
  test("HELL-B4: missing path ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspSignatureHelpTool(port), { line: 1, character: 1 })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.calls).toHaveLength(0)
  })

  test("HELL-B5: character=0 ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 0,
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* C. Port conversion                                                  */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — port conversion", () => {
  test("HELL-C6: 1-based input ⇒ 0-based port args", async () => {
    const port = fakePort()
    await collect(lspSignatureHelpTool(port), {
      path: "src/x.ts",
      line: 9,
      character: 12,
    })
    expect(port.calls[0]).toEqual({ file: "src/x.ts", line: 8, col: 11 })
  })

  test("HELL-C7: tool forwards ctx.signal to signatureHelp", async () => {
    const ac = new AbortController()
    const port = fakePort()
    await collect(
      lspSignatureHelpTool(port),
      { path: "src/x.ts", line: 1, character: 1 },
      ctx(ac.signal),
    )
    expect(port.signals[0]).toBe(ac.signal)
  })
})

/* ------------------------------------------------------------------ */
/* D. Output formatting                                                */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — output formatting", () => {
  test("HELL-D7: null ⇒ '… signature help not supported here'", async () => {
    const port = fakePort({ signatureHelp: async () => null })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts:1:1: signature help not supported here")
  })

  test("HELL-D8: [] ⇒ '… no signature help (not in a call)'", async () => {
    const port = fakePort({ signatureHelp: async () => [] })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts:1:1: no signature help (not in a call)")
  })

  test("HELL-D9: 1 sig with activeParameter ⇒ '← active param: <label>' marker", async () => {
    const port = fakePort({
      signatureHelp: async () => [sig("foo(a: number, b: string)", ["a: number", "b: string"], 1)],
    })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("x.ts:1:1: 1 signature(s)")
    expect(r.output).toContain("foo(a: number, b: string)")
    expect(r.output).toContain("← active param: b: string")
  })

  test("HELL-D10: 2 sigs ⇒ header '2 signature(s)' + 2 numbered rows", async () => {
    const port = fakePort({
      signatureHelp: async () => [
        sig("foo(a: number)", ["a: number"], 0),
        sig("foo(a: string)", ["a: string"], 0),
      ],
    })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 3,
      character: 4,
    })
    expect(r.output).toContain("x.ts:3:4: 2 signature(s)")
    expect(r.output.split("\n")).toHaveLength(3) // header + 2 rows
  })

  test("HELL-D11: activeParameter absent ⇒ no '← active param:' marker rendered", async () => {
    const port = fakePort({
      signatureHelp: async () => [sig("foo(a: number)", ["a: number"])],
    })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.output).not.toContain("active param")
  })
})

/* ------------------------------------------------------------------ */
/* E. Error & signal                                                   */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — error & signal", () => {
  test("HELL-E12: port throw ⇒ ok:false 'lsp_signature_help unavailable: …'", async () => {
    const port = fakePort({
      signatureHelp: async () => {
        throw new Error("not-implemented: signatureHelp wire method missing on LspClient")
      },
    })
    const r = await collect(lspSignatureHelpTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("lsp_signature_help unavailable:")).toBe(true)
    expect(r.output).toContain("not-implemented")
  })

  test("HELL-E13: signal aborted ⇒ port NOT called", async () => {
    const ac = new AbortController()
    ac.abort()
    const port = fakePort({
      signatureHelp: async () => [sig("foo()", [], null)],
    })
    const r = await collect(
      lspSignatureHelpTool(port),
      { path: "x.ts", line: 1, character: 1 },
      ctx(ac.signal),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(port.calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* F. Determinism                                                      */
/* ------------------------------------------------------------------ */

describe("lsp_signature_help — determinism", () => {
  test("HELL-F14: same input + same fake data ⇒ byte-identical output", async () => {
    const data = [sig("foo(a: number, b: string)", ["a: number", "b: string"], 1)]
    const r1 = await collect(lspSignatureHelpTool(fakePort({ signatureHelp: async () => data })), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    const r2 = await collect(lspSignatureHelpTool(fakePort({ signatureHelp: async () => data })), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r1.output).toBe(r2.output)
    expect(r1.ok).toBe(r2.ok)
  })
})
