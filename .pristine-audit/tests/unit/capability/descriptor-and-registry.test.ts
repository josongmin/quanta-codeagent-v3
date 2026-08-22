/**
 * Capability layer — descriptor shape + registry SSOT (ADR-0503 P3 / RFC §4).
 *
 * Asserts the seed registry is well-formed: unique ids, every gate.envKey is a
 * `QUANTA_*` token, at least one surface is exposed per capability, and the seed
 * set covers the REAL existing gated features (workflow / artifact / image-gen).
 */

import { describe, expect, test } from "bun:test"
import { allCapabilities, CAPABILITIES } from "@/capability"

describe("capability registry (ADR-0503 P3)", () => {
  test("allCapabilities() returns the frozen CAPABILITIES seed", () => {
    expect(allCapabilities()).toBe(CAPABILITIES)
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(3)
  })

  test("ids are unique", () => {
    const ids = CAPABILITIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every gate.envKey is a QUANTA_* token", () => {
    for (const c of CAPABILITIES) {
      expect(c.gate.envKey.startsWith("QUANTA_")).toBe(true)
    }
  })

  test("every capability exposes at least one surface", () => {
    for (const c of CAPABILITIES) {
      const s = c.surfaces
      const any = [s.llmTool, s.slash, s.skill, s.hook, s.thinClient].some((v) => v === true)
      expect(any).toBe(true)
    }
  })

  test("every capability has a non-empty describe", () => {
    for (const c of CAPABILITIES) {
      expect(c.describe.length).toBeGreaterThan(0)
    }
  })

  test("seed covers the real existing gated features", () => {
    const byEnv = new Set(CAPABILITIES.map((c) => c.gate.envKey))
    expect(byEnv.has("QUANTA_WORKFLOW")).toBe(true)
    expect(byEnv.has("QUANTA_ARTIFACT_STORE")).toBe(true)
    expect(byEnv.has("QUANTA_IMAGE_GEN")).toBe(true)
  })
})
