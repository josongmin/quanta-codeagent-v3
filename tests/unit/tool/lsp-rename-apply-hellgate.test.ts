/**
 * Hellgate — `lsp_rename_apply` tool (ADR-0141).
 *
 * Seal:
 *   A. metadata             — name / isReadOnly=false / isConcurrencySafe=false / hitlTier=always-confirm
 *   B. input validation     — schema rejects malformed input + 1-based coords
 *   C. port conversion      — 1-based → 0-based; newName propagated
 *   D. apply / no-apply     — null edit ⇒ ok:false + apply NOT called
 *                              empty changes ⇒ ok:true + apply NOT called
 *                              non-empty ⇒ apply called with same edit
 *   E. error & signal       — computeRename throw / applyEdit throw / abort
 *   F. determinism          — same input + same fake ⇒ byte-identical output
 */

import { describe, expect, test } from "bun:test"
import type { RenameApplyPort, RenameWorkspaceEdit } from "@/lsp"
import { lspRenameApplyTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

interface FakePort extends RenameApplyPort {
  readonly computeCalls: { file: string; line: number; col: number; newName: string }[]
  readonly applyCalls: RenameWorkspaceEdit[]
}

const fakePort = (overrides?: Partial<RenameApplyPort>): FakePort => {
  const computeCalls: FakePort["computeCalls"] = []
  const applyCalls: FakePort["applyCalls"] = []
  const base: RenameApplyPort = {
    computeRename: async () => ({ changes: [] }),
    applyEdit: async () => {},
  }
  const merged: RenameApplyPort = { ...base, ...(overrides ?? {}) }
  const realCompute = merged.computeRename
  merged.computeRename = async (file, line, col, newName) => {
    computeCalls.push({ file, line, col, newName })
    return realCompute(file, line, col, newName)
  }
  const realApply = merged.applyEdit
  merged.applyEdit = async (edit) => {
    applyCalls.push(edit)
    return realApply(edit)
  }
  return Object.assign(merged, { computeCalls, applyCalls }) as FakePort
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

const edit = (files: number, perFile = 1): RenameWorkspaceEdit => ({
  changes: Array.from({ length: files }, (_, i) => ({
    uri: `file:///work/proj/src/f${i}.ts`,
    edits: Array.from({ length: perFile }, () => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      newText: "Bar",
    })),
  })),
})

/* ------------------------------------------------------------------ */
/* A. Metadata                                                         */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — metadata", () => {
  test("HELL-A1: name === 'lsp_rename_apply'", () => {
    const t = lspRenameApplyTool(fakePort())
    expect(t.name).toBe("lsp_rename_apply")
  })

  test("HELL-A2: isReadOnly() === false", () => {
    const t = lspRenameApplyTool(fakePort())
    expect(t.isReadOnly()).toBe(false)
  })

  test("HELL-A3: isConcurrencySafe() === false", () => {
    const t = lspRenameApplyTool(fakePort())
    expect(
      t.isConcurrencySafe({
        path: "x.ts",
        line: 1,
        character: 1,
        newName: "Bar",
      }),
    ).toBe(false)
  })

  test("HELL-A4: hitlTier() === 'always-confirm'", () => {
    const t = lspRenameApplyTool(fakePort())
    expect(t.hitlTier?.({
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })).toBe("always-confirm")
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — input validation", () => {
  test("HELL-B5: missing newName ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
    expect(port.computeCalls).toHaveLength(0)
  })

  test("HELL-B6: empty newName ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "",
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
  })

  test("HELL-B7: line=0 (must be ≥1) ⇒ ok:false 'invalid input:'", async () => {
    const port = fakePort()
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 0,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("invalid input:")).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* C. Port conversion                                                  */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — port conversion", () => {
  test("HELL-C8: 1-based input → 0-based port args; newName passed through", async () => {
    const port = fakePort({ computeRename: async () => edit(1) })
    await collect(lspRenameApplyTool(port), {
      path: "src/x.ts",
      line: 7,
      character: 13,
      newName: "newSymbol",
    })
    expect(port.computeCalls[0]).toEqual({
      file: "src/x.ts",
      line: 6,
      col: 12,
      newName: "newSymbol",
    })
  })
})

/* ------------------------------------------------------------------ */
/* D. Apply / no-apply branches                                        */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — apply branches", () => {
  test("HELL-D9: null edit ⇒ ok:false 'rename not available'; apply NOT called", async () => {
    const port = fakePort({ computeRename: async () => null })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(false)
    expect(r.output).toBe("x.ts:1:1: rename not available")
    expect(port.applyCalls).toHaveLength(0)
  })

  test("HELL-D10: empty changes ⇒ ok:true 'no edits (symbol unused)'; apply NOT called", async () => {
    const port = fakePort({ computeRename: async () => ({ changes: [] }) })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("rename produced no edits (symbol unused)")
    expect(port.applyCalls).toHaveLength(0)
  })

  test("HELL-D11: non-empty ⇒ apply called with SAME edit object; ok:true summary", async () => {
    const e = edit(2, 3)
    const port = fakePort({ computeRename: async () => e })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(true)
    expect(port.applyCalls).toHaveLength(1)
    expect(port.applyCalls[0]).toBe(e)
    expect(r.output).toContain("Renamed symbol at x.ts:1:1 to 'Bar'")
    expect(r.output).toContain("Applied 6 edits across 2 files")
  })

  test("HELL-D12: singular pluralization — 1 file / 1 edit", async () => {
    const port = fakePort({ computeRename: async () => edit(1, 1) })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.output).toContain("Applied 1 edit across 1 file.")
  })
})

/* ------------------------------------------------------------------ */
/* E. Error & signal                                                   */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — error & signal", () => {
  test("HELL-E13: computeRename throw ⇒ ok:false 'unavailable: …'", async () => {
    const port = fakePort({
      computeRename: async () => {
        throw new Error("not-implemented: rename wire methods missing on LspClient")
      },
    })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("lsp_rename_apply unavailable:")).toBe(true)
    expect(port.applyCalls).toHaveLength(0)
  })

  test("HELL-E14: applyEdit throw ⇒ ok:false 'applyEdit failed: …'", async () => {
    const port = fakePort({
      computeRename: async () => edit(1),
      applyEdit: async () => {
        throw new Error("write protected")
      },
    })
    const r = await collect(lspRenameApplyTool(port), {
      path: "x.ts",
      line: 1,
      character: 1,
      newName: "Bar",
    })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("lsp_rename_apply applyEdit failed:")).toBe(true)
  })

  test("HELL-E15: signal aborted ⇒ neither computeRename nor applyEdit called", async () => {
    const ac = new AbortController()
    ac.abort()
    const port = fakePort({ computeRename: async () => edit(1) })
    const r = await collect(
      lspRenameApplyTool(port),
      { path: "x.ts", line: 1, character: 1, newName: "Bar" },
      ctx(ac.signal),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(port.computeCalls).toHaveLength(0)
    expect(port.applyCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* F. Determinism                                                      */
/* ------------------------------------------------------------------ */

describe("lsp_rename_apply — determinism", () => {
  test("HELL-F16: same input + same fake edit ⇒ byte-identical output", async () => {
    const e = edit(2, 2)
    const r1 = await collect(
      lspRenameApplyTool(fakePort({ computeRename: async () => e })),
      { path: "x.ts", line: 1, character: 1, newName: "Bar" },
    )
    const r2 = await collect(
      lspRenameApplyTool(fakePort({ computeRename: async () => e })),
      { path: "x.ts", line: 1, character: 1, newName: "Bar" },
    )
    expect(r1.output).toBe(r2.output)
    expect(r1.ok).toBe(r2.ok)
  })
})
