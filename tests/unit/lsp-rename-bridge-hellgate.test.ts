/**
 * Hellgate — LSP rename bridge wiring (ADR-0404, S2).
 *
 * Seals that the agent-slice bridge assembles a real `RenameApplyPort` (backed
 * by an `LspClient` + `DefaultRenameApplyAdapter`) into the `lsp_rename_apply`
 * tool, and that the tool joins the `lspNavToolList()` opt-in surface (so the
 * existing `QUANTA_LSP_TOOLS=full` gate covers it — default-OFF when unset).
 *
 * Seal:
 *   A. lspNavToolList() now includes `lsp_rename_apply` (9 tools total)
 *   B. the rename tool is mutating + always-confirm HITL (matches ADR-0141)
 *   C. degrade-gracefully — unavailable server ⇒ clean ok:false, never throws
 */

import { describe, expect, test } from "bun:test"
import { lspNavToolList } from "@/agent/lsp-bridge"

describe("LSP rename bridge — registration", () => {
  test("HELL-A1: lspNavToolList() includes lsp_rename_apply", () => {
    const tools = lspNavToolList()
    const names = tools.map((t) => t.name)
    expect(names).toContain("lsp_rename_apply")
  })

  test("HELL-A2: rename is additive — 8 nav tools + 1 rename = 9", () => {
    const tools = lspNavToolList()
    expect(tools).toHaveLength(9)
  })

  test("HELL-B3: lsp_rename_apply is mutating + always-confirm + not concurrency-safe", () => {
    const tool = lspNavToolList().find((t) => t.name === "lsp_rename_apply")
    expect(tool).toBeDefined()
    expect(tool?.isReadOnly()).toBe(false)
    expect(tool?.isConcurrencySafe?.({ path: "x.ts", line: 1, character: 1, newName: "Bar" })).toBe(
      false,
    )
    expect(tool?.hitlTier?.({ path: "x.ts", line: 1, character: 1, newName: "Bar" })).toBe(
      "always-confirm",
    )
  })

  test("HELL-C4: unavailable server ⇒ clean ok:false (no throw, no hang)", async () => {
    const tool = lspNavToolList().find((t) => t.name === "lsp_rename_apply")
    if (!tool) throw new Error("tool not registered")
    let result: { ok: boolean; output: string } | undefined
    // .ts file with no language server on PATH in the test env ⇒ provider open
    // returns null ⇒ computeRename throws "unavailable" ⇒ tool emits ok:false.
    for await (const ev of tool.execute(
      { path: "/tmp/quanta-rename-missing.ts", line: 1, character: 1, newName: "Bar" },
      { cwd: "/tmp", signal: new AbortController().signal },
    )) {
      if (ev.type === "result") result = ev.result
    }
    expect(result).toBeDefined()
    expect(result?.ok).toBe(false)
  })
})
