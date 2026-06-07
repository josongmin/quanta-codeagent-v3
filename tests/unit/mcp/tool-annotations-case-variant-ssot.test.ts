/** §19.1 (SSOT finding) — MCP `ToolAnnotations` knob ⇄ runtime-config agree on
 *  CASE-VARIANT truthy values.
 *
 *  The knob `parse` previously used a case-SENSITIVE Set `{"1","on","true"}`,
 *  while `runtimeConfig().mcpToolAnnotations` parses with the case-INSENSITIVE
 *  `parseBool`. So `"TRUE"` / `"ON"` reported OFF in the knob registry/telemetry
 *  but ON in the live bridge — observability drift. The fix routes the knob's
 *  `parse` through the SAME exported `parseBool`, so the two channels are
 *  byte-equal on EVERY value, including mixed/upper case. These tests pin that
 *  agreement (the pre-fix code FAILS the `"TRUE"`/`"On"`/`"TrUe"` rows). */

import { afterEach, describe, expect, test } from "bun:test"
import { mcpToolAnnotationsKnob } from "@/runner/knobs/knobs/mcp-tool-annotations"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const KEY = "QUANTA_MCP_TOOL_ANNOTATIONS"

const liveRead = (value: string | undefined): boolean => {
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

describe("mcpToolAnnotations — case-variant knob⇄runtime-config SSOT", () => {
  // Every spelling that should be TRUE in BOTH channels (case-insensitive).
  const TRUTHY_VARIANTS = ["1", "on", "ON", "On", "true", "TRUE", "True", "TrUe"]
  // Every spelling that should be FALSE/undefined in BOTH channels.
  const FALSY_VARIANTS = ["0", "off", "OFF", "false", "FALSE", "yes", "garbage", ""]

  test("case-variant truthy values are ON in BOTH channels (no drift)", () => {
    for (const v of TRUTHY_VARIANTS) {
      // knob parse: true; live runtime-config: true — byte-equal.
      expect(mcpToolAnnotationsKnob.parse(v)).toBe(true)
      expect(liveRead(v)).toBe(true)
    }
  })

  test("falsy / off-vocabulary / garbage are OFF in BOTH channels", () => {
    for (const v of FALSY_VARIANTS) {
      expect(mcpToolAnnotationsKnob.parse(v)).toBeUndefined()
      expect(liveRead(v)).toBe(false)
    }
  })

  test("knob.parse(v) truthiness === runtimeConfig flag for the full variant set", () => {
    for (const v of [...TRUTHY_VARIANTS, ...FALSY_VARIANTS]) {
      const knobOn = mcpToolAnnotationsKnob.parse(v) === true
      expect(knobOn).toBe(liveRead(v))
    }
  })

  test("apply is an identity no-op (the dead AgentConfig field is removed)", () => {
    // The knob no longer writes any config field; apply returns the input cfg.
    const cfg = { sentinel: true } as unknown as Parameters<typeof mcpToolAnnotationsKnob.apply>[0]
    expect(mcpToolAnnotationsKnob.apply(cfg, true, { surface: "cli" })).toBe(cfg)
  })
})
