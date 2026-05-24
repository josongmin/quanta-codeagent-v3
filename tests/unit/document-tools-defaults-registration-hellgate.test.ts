/**
 * Hellgate: 5 document/structured-data tools (ADR-0133/0137) MUST be
 * registered as global defaults AND classified read-only in
 * `MUTATING_TOOL_TABLE` (ADR-0142 wire-finalization).
 *
 * The ADR-0133 / ADR-0137 slices shipped `csv_read` / `ndjson_read` /
 * `yaml_read` / `pdf_read` / `xlsx_read` as barrel-exports but DEFERRED
 * the `buildDefaultTools` registration because adding any of them without
 * a matching `MUTATING_TOOL_TABLE` entry would crash the plan-mode
 * cross-check (`mode-mutating-table.test.ts`) with `UnknownToolError`.
 * ADR-0142 closes this loop atomically: defaults registry + table entries
 * land together. This hellgate co-asserts both legs so a future refactor
 * that silently drops either side fails CI.
 */

import { describe, expect, test } from "bun:test"
import { isMutatingTool, planModeMutatingTable } from "@/agent/mode"
import { buildDefaultTools } from "@/tool"

const DOC_TOOL_NAMES = ["csv_read", "ndjson_read", "yaml_read", "pdf_read", "xlsx_read"] as const

describe("document tools defaults registration (ADR-0142 / ADR-0133/0137)", () => {
  test("1. buildDefaultTools() includes csv_read", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("csv_read")
  })

  test("2. buildDefaultTools() includes ndjson_read", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("ndjson_read")
  })

  test("3. buildDefaultTools() includes yaml_read", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("yaml_read")
  })

  test("4. buildDefaultTools() includes pdf_read", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("pdf_read")
  })

  test("5. buildDefaultTools() includes xlsx_read", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("xlsx_read")
  })

  test("6. all 5 classified `null` (read-only) in MUTATING_TOOL_TABLE", () => {
    const table = planModeMutatingTable()
    for (const name of DOC_TOOL_NAMES) {
      // Explicit `null` (table entry exists AND is the read-only sentinel)
      expect(table[name]).toBeNull()
      // `isMutatingTool` round-trip — must not throw `UnknownToolError`
      // and must report `false` (read-only).
      expect(isMutatingTool(name)).toBe(false)
    }
    // Round-trip the metadata: defaults registry agrees the tools are
    // read-only at the Tool surface as well (defense-in-depth — table
    // says read-only, tool agrees).
    const defaults = buildDefaultTools()
    for (const name of DOC_TOOL_NAMES) {
      const tool = defaults.find((t) => t.name === name)
      expect(tool).toBeDefined()
      expect(tool?.isReadOnly()).toBe(true)
    }
  })
})
