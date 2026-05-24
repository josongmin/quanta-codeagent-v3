/**
 * Hellgate — `lsp_code_action` tool (ADR-0141).
 *
 * Seal:
 *   A. metadata             — name / isReadOnly=true / isConcurrencySafe=true
 *   B. input validation     — schema rejects malformed input + 1-based coords
 *   C. port conversion      — 1-based → 0-based propagated to port
 *   D. output formatting    — null/empty/non-empty rendering
 *   E. error & signal       — port throw mapped to ok:false + abort short-circuit
 *   F. determinism          — same input + same fake ⇒ byte-identical output
 *
 * Test uses an in-memory fake satisfying both the canonical `CodeActionPort`
 * (`@/lsp/ports/code-action-port`) and the tool-side duck-typed mirror
 * (`@/tool/lsp_nav` re-export) — they are structurally identical by design.
 */

import { describe, expect, test } from "bun:test"
import type {
  CodeAction,
  CodeActionKind,
  CodeActionPort,
  CodeActionWorkspaceEdit,
} from "@/lsp"
import { lspCodeActionTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface FakePort extends CodeActionPort {
  readonly resolveCalls: {
    file: string
    line: number
    col: number
    kind?: CodeActionKind
  }[]
  readonly applyCalls: CodeActionWorkspaceEdit[]
}

const fakePort = (overrides?: Partial<CodeActionPort>): FakePort => {
  const resolveCalls: FakePort["resolveCalls"] = []
  const applyCalls: FakePort["applyCalls"] = []
  const base: CodeActionPort = {
    resolveCodeActions: async () => [],
    applyEdit: async () => {},
  }
  const merged: CodeActionPort = { ...base, ...(overrides ?? {}) }
  const realResolve = merged.resolveCodeActions
  merged.resolveCodeActions = async (file, line, col, kind) => {
    resolveCalls.push(
      kind === undefined ? { file, line, col } : { file, line, col, kind },
    )
    return realResolve(file, line, col, kind)
  }
  const realApply = merged.applyEdit
  merged.applyEdit = async (edit) => {
    applyCalls.push(edit)
    return realApply(edit)
  }
  return Object.assign(merged, { resolveCalls, applyCalls }) as FakePort
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

const action = (
  title: string,
  kind: CodeActionKind = "quickfix",
  editFiles = 0,
): CodeAction => {
  const a: CodeAction = { title, kind }
  if (editFiles > 0) {
    const changes = Array.from({ length: editFiles }, (_, i) => ({
      uri: `file:///work/proj/src/f${i}.ts`,
      edits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "// patched",
        },
      ],
    }))
    a.edit = { changes }
  }
  return a
}

/* ------------------------------------------------------------------ */
/* A. Metadata                                                         */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — metadata", () => {
  test("HELL-A1: name === 'lsp_code_action'", () => {
    const t = lspCodeActionTool(fakePort())
    expect(t.name).toBe("lsp_code_action")
  })

  test("HELL-A2: isReadOnly() === true", () => {
    const t = lspCodeActionTool(fakePort())
    expect(t.isReadOnly()).toBe(true)
  })

  test("HELL-A3: isConcurrencySafe() === true", () => {
    const t = lspCodeActionTool(fakePort())
    expect(
      t.isConcurrencySafe({ path: "x.ts", line: 1, character: 1 }),
    ).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — input validation", () => {
  test("HELL-B4: missing path ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspCodeActionTool(port), { line: 1, character: 1 })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.resolveCalls).toHaveLength(0)
  })

  test("HELL-B5: line=0 (must be ≥1) ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 0,
      character: 1,
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.resolveCalls).toHaveLength(0)
  })

  test("HELL-B6: unknown kind enum ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      kind: "totally-not-a-kind",
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.resolveCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* C. Port conversion (1-based → 0-based)                              */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — port conversion", () => {
  test("HELL-C7: input {line:5, character:8} ⇒ port called with (line=4,col=7)", async () => {
    const port = fakePort()
    await collect(lspCodeActionTool(port), {
      path: "src/x.ts",
      line: 5,
      character: 8,
    })
    expect(port.resolveCalls).toHaveLength(1)
    expect(port.resolveCalls[0]).toEqual({ file: "src/x.ts", line: 4, col: 7 })
  })

  test("HELL-C8: optional kind passed through", async () => {
    const port = fakePort()
    await collect(lspCodeActionTool(port), {
      path: "src/x.ts",
      line: 1,
      character: 1,
      kind: "refactor.extract",
    })
    expect(port.resolveCalls[0]?.kind).toBe("refactor.extract")
  })

  test("HELL-C9: omitted kind ⇒ resolveCalls entry has no 'kind' field", async () => {
    const port = fakePort()
    await collect(lspCodeActionTool(port), {
      path: "src/x.ts",
      line: 1,
      character: 1,
    })
    expect("kind" in (port.resolveCalls[0] ?? {})).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* D. Output formatting                                                */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — output formatting", () => {
  test("HELL-D10: null ⇒ '… code actions not supported here'", async () => {
    const port = fakePort({ resolveCodeActions: async () => null })
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts:1:1: code actions not supported here")
  })

  test("HELL-D11: [] ⇒ '… no code actions available'", async () => {
    const port = fakePort({ resolveCodeActions: async () => [] })
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("x.ts:1:1: no code actions available")
  })

  test("HELL-D12: 2 actions ⇒ header '2 code action(s)' + numbered rows", async () => {
    const port = fakePort({
      resolveCodeActions: async () => [
        action("Add missing import", "quickfix", 1),
        action("Extract function", "refactor.extract", 2),
      ],
    })
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 3,
      character: 4,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("x.ts:3:4: 2 code action(s)")
    expect(r.output).toContain("[quickfix] Add missing import (edits 1 file)")
    expect(r.output).toContain("[refactor.extract] Extract function (edits 2 files)")
  })
})

/* ------------------------------------------------------------------ */
/* E. Error & signal                                                   */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — error & signal", () => {
  test("HELL-E13: port throw ⇒ ok:false 'lsp_code_action unavailable: …'", async () => {
    const port = fakePort({
      resolveCodeActions: async () => {
        throw new Error("not-implemented: code-action wire methods missing on LspClient")
      },
    })
    const r = await collect(lspCodeActionTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("lsp_code_action unavailable:")).toBe(true)
    expect(r.output).toContain("not-implemented")
  })

  test("HELL-E14: signal aborted ⇒ port NOT called", async () => {
    const ac = new AbortController()
    ac.abort()
    const port = fakePort({ resolveCodeActions: async () => [action("nope")] })
    const r = await collect(
      lspCodeActionTool(port),
      { path: "x.ts", line: 1, character: 1 },
      ctx(ac.signal),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(port.resolveCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* F. Determinism                                                      */
/* ------------------------------------------------------------------ */

describe("lsp_code_action — determinism", () => {
  test("HELL-F15: same input + same fake data ⇒ byte-identical output", async () => {
    const data = [action("Fix it", "quickfix", 1), action("Refactor it", "refactor")]
    const r1 = await collect(
      lspCodeActionTool(fakePort({ resolveCodeActions: async () => data })),
      { path: "x.ts", line: 1, character: 1 },
    )
    const r2 = await collect(
      lspCodeActionTool(fakePort({ resolveCodeActions: async () => data })),
      { path: "x.ts", line: 1, character: 1 },
    )
    expect(r1.output).toBe(r2.output)
    expect(r1.ok).toBe(r2.ok)
  })
})
