/**
 * Capability layer — resolveExposure unit truth-table (ADR-0503 P3 / RFC §4).
 *
 * resolveExposure(cap, surface, env) === true IFF the capability declares the
 * surface (surfaces[surface] === true) AND its env gate is on. Pure: env injected.
 */

import { describe, expect, test } from "bun:test"
import type { CapabilityDescriptor, Surface } from "@/capability"
import { resolveExposure } from "@/capability"

const cap: CapabilityDescriptor = {
  id: "test-cap",
  gate: { envKey: "QUANTA_TEST_CAP" },
  surfaces: { llmTool: true, slash: false, skill: true },
  describe: "test capability",
}

const on = { QUANTA_TEST_CAP: "1" }
const off = { QUANTA_TEST_CAP: "0" }
const unset: Record<string, string | undefined> = {}

describe("resolveExposure (ADR-0503 P3)", () => {
  test("exposed surface + gate on ⇒ true", () => {
    expect(resolveExposure(cap, "llmTool", on)).toBe(true)
    expect(resolveExposure(cap, "skill", on)).toBe(true)
  })

  test("NON-exposed surface + gate on ⇒ false (surface flag respected)", () => {
    expect(resolveExposure(cap, "slash", on)).toBe(false)
    // hook / thinClient are absent (undefined) ⇒ not exposed
    expect(resolveExposure(cap, "hook", on)).toBe(false)
    expect(resolveExposure(cap, "thinClient", on)).toBe(false)
  })

  test("exposed surface + gate off ⇒ false", () => {
    expect(resolveExposure(cap, "llmTool", off)).toBe(false)
    expect(resolveExposure(cap, "skill", off)).toBe(false)
  })

  test("exposed surface + gate unset ⇒ false (default-OFF opt-in)", () => {
    expect(resolveExposure(cap, "llmTool", unset)).toBe(false)
  })

  test("gate accepts the canonical truthy vocabulary", () => {
    for (const v of ["1", "on", "true", "yes"] as const) {
      expect(resolveExposure(cap, "llmTool", { QUANTA_TEST_CAP: v })).toBe(true)
    }
    for (const v of ["", "0", "off", "false", "no", "bogus"] as const) {
      expect(resolveExposure(cap, "llmTool", { QUANTA_TEST_CAP: v })).toBe(false)
    }
  })

  test("every Surface value is handled", () => {
    const surfaces: Surface[] = ["llmTool", "slash", "skill", "hook", "thinClient"]
    for (const s of surfaces) {
      // must not throw for any declared surface key
      expect(typeof resolveExposure(cap, s, on)).toBe("boolean")
    }
  })
})
