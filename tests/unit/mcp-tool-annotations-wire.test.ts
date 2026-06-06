/**
 * §19.1 — `QUANTA_MCP_TOOL_ANNOTATIONS` composition-root wiring.
 *
 * The knob sets `AgentConfig.mcpToolAnnotations` (typed field) AND, at the CLI
 * composition root, drives `runtimeConfig().mcpToolAnnotations`, which
 * `buildMcpLoadOpts` (src/apps/cli/internal.ts) reads to spread
 * `annotationsHonored:true` onto the `loadMcpTools` opts bag. This test pins the
 * SSOT the spread reads:
 *   - env unset / not "1" ⇒ `mcpToolAnnotations === false` ⇒ slot omitted ⇒ the
 *     bridge's `annotationsHonored` stays false ⇒ `honored = annotationsHonored
 *     && trusted` is false for every tool (byte-identical default).
 *   - env "1" ⇒ `mcpToolAnnotations === true` ⇒ opts carry `annotationsHonored`.
 *
 * The exact opts-spread predicate (`runtimeConfig().mcpToolAnnotations ? {…} : {}`)
 * is replicated here so a regression that drops the knob read is caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const KEY = "QUANTA_MCP_TOOL_ANNOTATIONS"
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
  __resetRuntimeConfig()
})
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
  __resetRuntimeConfig()
})

// Mirror of the `buildMcpLoadOpts` spread so the contract is asserted directly.
const annotationsSlot = (): { annotationsHonored?: true } =>
  runtimeConfig().mcpToolAnnotations ? { annotationsHonored: true } : {}

describe("QUANTA_MCP_TOOL_ANNOTATIONS — runtime-config knob read", () => {
  test("unset ⇒ mcpToolAnnotations false ⇒ slot omitted (byte-identical)", () => {
    expect(runtimeConfig().mcpToolAnnotations).toBe(false)
    expect(Object.hasOwn(annotationsSlot(), "annotationsHonored")).toBe(false)
  })

  test("'0' / 'true' (not strict '1') ⇒ false ⇒ slot omitted", () => {
    process.env[KEY] = "0"
    __resetRuntimeConfig()
    expect(runtimeConfig().mcpToolAnnotations).toBe(false)
    process.env[KEY] = "true"
    __resetRuntimeConfig()
    expect(runtimeConfig().mcpToolAnnotations).toBe(false)
    expect(Object.hasOwn(annotationsSlot(), "annotationsHonored")).toBe(false)
  })

  test("strict '1' ⇒ true ⇒ opts carry annotationsHonored:true", () => {
    process.env[KEY] = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().mcpToolAnnotations).toBe(true)
    expect(annotationsSlot()).toEqual({ annotationsHonored: true })
  })
})
