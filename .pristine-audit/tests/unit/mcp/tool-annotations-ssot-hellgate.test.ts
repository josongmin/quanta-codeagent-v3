/** §19.1 (Finding 2) — MCP `ToolAnnotations` knob ⇄ runtime-config SSOT.
 *
 *  The `mcp-tool-annotations` knob accepts the truthy vocabulary `{1,on,true}`,
 *  but the LIVE consumer is `runtimeConfig().mcpToolAnnotations` (read by
 *  `buildMcpLoadOpts` in `@/apps/cli/internal`). If the runtime-config parse
 *  recognized ONLY `=== "1"`, then `QUANTA_MCP_TOOL_ANNOTATIONS=on` / `=true`
 *  would be ON in the knob registry/telemetry but OFF in the bridge — a silent
 *  divergence. These tests pin the two channels to the SAME vocabulary:
 *    - `1` / `on` / `true` ⇒ runtime-config flag is ON (bridge activates),
 *    - unset ⇒ OFF (byte-identical default),
 *    - garbage / off-vocabulary ⇒ OFF. */

import { afterEach, describe, expect, test } from "bun:test"
import { mcpToolAnnotationsKnob } from "@/runner/knobs/knobs/mcp-tool-annotations"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const KEY = "QUANTA_MCP_TOOL_ANNOTATIONS"

const withEnv = (value: string | undefined): boolean => {
  const prev = process.env[KEY]
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  __resetRuntimeConfig()
  try {
    return runtimeConfig().mcpToolAnnotations
  } finally {
    if (prev === undefined) delete process.env[KEY]
    else process.env[KEY] = prev
    __resetRuntimeConfig()
  }
}

afterEach(() => {
  __resetRuntimeConfig()
})

describe("runtime-config mcpToolAnnotations — knob-vocabulary SSOT", () => {
  test("=1 ⇒ ON (live channel activates the bridge)", () => {
    expect(withEnv("1")).toBe(true)
  })

  test("=on ⇒ ON (identical to =1, no longer silently OFF)", () => {
    expect(withEnv("on")).toBe(true)
  })

  test("=true ⇒ ON (identical to =1, no longer silently OFF)", () => {
    expect(withEnv("true")).toBe(true)
  })

  test("unset ⇒ OFF (byte-identical default)", () => {
    expect(withEnv(undefined)).toBe(false)
  })

  test("=0 / =off / garbage ⇒ OFF", () => {
    expect(withEnv("0")).toBe(false)
    expect(withEnv("off")).toBe(false)
    expect(withEnv("yes")).toBe(false)
    expect(withEnv("")).toBe(false)
  })

  test("the knob's parse vocabulary agrees with the runtime-config channel", () => {
    // The knob is the canonical truthy vocabulary; every value it accepts must
    // also flip the LIVE runtime-config flag (no channel disagreement).
    for (const v of ["1", "on", "true"]) {
      expect(mcpToolAnnotationsKnob.parse(v)).toBe(true)
      expect(withEnv(v)).toBe(true)
    }
    for (const v of ["0", "off", "garbage", ""]) {
      expect(mcpToolAnnotationsKnob.parse(v)).toBeUndefined()
      expect(withEnv(v)).toBe(false)
    }
  })
})
