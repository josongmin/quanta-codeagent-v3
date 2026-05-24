/**
 * Hellgate: `web_fetch` (ADR-0127) + `read_image` (ADR-0126) MUST be registered
 * as global defaults AND classified read-only in `MUTATING_TOOL_TABLE`.
 *
 * Both ADRs deferred this atomic registration step because adding either tool
 * to `defaultTools` without a matching `MUTATING_TOOL_TABLE` entry would crash
 * the plan-mode cross-check (`mode-mutating-table.test.ts`) with an
 * `UnknownToolError`. This hellgate seals the closed cycle: defaults registry,
 * table entry, and read-only posture are co-asserted so a future refactor that
 * silently drops either side fails CI.
 */

import { describe, expect, test } from "bun:test"
import { isMutatingTool, planModeMutatingTable } from "@/agent/mode"
import { buildDefaultTools } from "@/tool"

describe("defaults registration: web_fetch + read_image (ADR-0126/0127)", () => {
  test("buildDefaultTools() includes web_fetch", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("web_fetch")
  })

  test("buildDefaultTools() includes read_image", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain("read_image")
  })

  test("both tools report isReadOnly() === true", () => {
    const defaults = buildDefaultTools()
    const webFetch = defaults.find((t) => t.name === "web_fetch")
    const readImage = defaults.find((t) => t.name === "read_image")
    expect(webFetch).toBeDefined()
    expect(readImage).toBeDefined()
    expect(webFetch?.isReadOnly()).toBe(true)
    expect(readImage?.isReadOnly()).toBe(true)
  })

  test("MUTATING_TOOL_TABLE classifies both as read-only (null)", () => {
    const table = planModeMutatingTable()
    expect(table.web_fetch).toBeNull()
    expect(table.read_image).toBeNull()
    // Direct lookup via `isMutatingTool` (throws on unknown) must not throw
    // and must return false (read-only).
    expect(isMutatingTool("web_fetch")).toBe(false)
    expect(isMutatingTool("read_image")).toBe(false)
  })
})
