/**
 * §19.1 — `QUANTA_MCP_TOOL_ANNOTATIONS` composition-root wiring.
 *
 * The knob sets `AgentConfig.mcpToolAnnotations` (typed field) AND, at the CLI
 * composition root, drives `runtimeConfig().mcpToolAnnotations`, which
 * `buildMcpLoadOpts` (src/apps/cli/internal.ts) reads to spread
 * `annotationsHonored:true` onto the `loadMcpTools` opts bag. This test pins the
 * SSOT the spread reads:
 *   - env unset / falsy (`"0"`, `"false"`, `"off"`, garbage) ⇒
 *     `mcpToolAnnotations === false` ⇒ slot omitted ⇒ the bridge's
 *     `annotationsHonored` stays false ⇒ `honored = annotationsHonored &&
 *     trusted` is false for every tool (byte-identical default).
 *   - env truthy (`"1"` / `"true"` / `"on"`, case-insensitive — the SAME
 *     `parseBool` vocab the knob registry uses, so the two channels agree) ⇒
 *     `mcpToolAnnotations === true` ⇒ opts carry `annotationsHonored`.
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

  test("falsy values ('0' / 'false' / garbage) ⇒ false ⇒ slot omitted", () => {
    for (const v of ["0", "false", "off", "nope"]) {
      process.env[KEY] = v
      __resetRuntimeConfig()
      expect(runtimeConfig().mcpToolAnnotations).toBe(false)
      expect(Object.hasOwn(annotationsSlot(), "annotationsHonored")).toBe(false)
    }
  })

  test("truthy vocab ('1' / 'true' / 'on') ⇒ true ⇒ opts carry annotationsHonored", () => {
    // SSOT: runtime-config now uses the SAME parseBool vocab as the knob
    // registry, so '1'/'true'/'on' all activate (the two channels agree).
    for (const v of ["1", "true", "TRUE", "on"]) {
      process.env[KEY] = v
      __resetRuntimeConfig()
      expect(runtimeConfig().mcpToolAnnotations).toBe(true)
      expect(annotationsSlot()).toEqual({ annotationsHonored: true })
    }
  })
})
