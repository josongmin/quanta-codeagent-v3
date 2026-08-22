/**
 * Unit — jun-26 LSP-nav cost-tier SSOT (REPORT-jun26-tool-impl-vs-frontier §4.5).
 *
 * Pins the cheap/expensive split at its two seams:
 *   - `isCheapLspNavTool` / `LSP_NAV_EXPENSIVE_TOOL_NAMES`: the EXACTLY-two
 *     measured-intractable members (`lsp_references`, `lsp_implementation`) are
 *     the only expensive ones; every other nav member is cheap.
 *   - `lspNavCheapToolList`: the bench/CLI cheap tier = the full read-only nav
 *     list MINUS the two expensive members AND the mutating rename_apply, and
 *     it is a strict subset of the full `lspNavToolList`.
 *
 * red-on-injection: add `lsp_references` to the cheap list (or drop it from
 * EXPENSIVE) and the "cheap excludes expensive" + subset assertions go RED.
 */
import { describe, expect, test } from "bun:test"
import { lspNavCheapToolList, lspNavToolList } from "@/agent"
import { isCheapLspNavTool, LSP_NAV_EXPENSIVE_TOOL_NAMES } from "@/tool"

describe("LSP-nav cost-tier SSOT", () => {
  test("exactly the two measured-intractable members are expensive", () => {
    expect([...LSP_NAV_EXPENSIVE_TOOL_NAMES].sort()).toEqual([
      "lsp_implementation",
      "lsp_references",
    ])
  })

  test("isCheapLspNavTool: expensive names false, everything else true", () => {
    expect(isCheapLspNavTool("lsp_references")).toBe(false)
    expect(isCheapLspNavTool("lsp_implementation")).toBe(false)
    for (const n of [
      "lsp_definition",
      "lsp_hover",
      "lsp_type_definition",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
    ]) {
      expect(isCheapLspNavTool(n)).toBe(true)
    }
  })
})

describe("lspNavCheapToolList composition", () => {
  const cheap = lspNavCheapToolList(() => "/repo").map((t) => t.name)
  const full = lspNavToolList(() => "/repo").map((t) => t.name)

  test("cheap list excludes the expensive members and the mutating rename_apply", () => {
    for (const e of LSP_NAV_EXPENSIVE_TOOL_NAMES) expect(cheap).not.toContain(e)
    expect(cheap).not.toContain("lsp_rename_apply")
  })

  test("cheap list includes the call-hierarchy + symbol moat members", () => {
    expect(cheap).toContain("lsp_incoming_calls")
    expect(cheap).toContain("lsp_outgoing_calls")
    expect(cheap).toContain("lsp_workspace_symbol")
    expect(cheap).toContain("lsp_document_symbol")
  })

  test("every cheap member is read-only and a strict subset of the full list", () => {
    for (const t of lspNavCheapToolList(() => "/repo")) expect(t.isReadOnly()).toBe(true)
    for (const c of cheap) expect(full).toContain(c)
    expect(cheap.length).toBeGreaterThan(0)
    expect(cheap.length).toBeLessThan(full.length)
  })
})
