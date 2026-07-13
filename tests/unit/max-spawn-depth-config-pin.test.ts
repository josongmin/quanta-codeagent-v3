/**
 * `maxSpawnDepth` runtime-config PIN (RFC jul-13 §6.5 A).
 *
 * This is the DEDICATED intent pin the RFC calls for: `maxSpawnDepth` is a
 * NUMERIC POLICY (not a bool-default-off gate), so the auto bool-default-off
 * guard covers it only via its allowlist. Here we pin the actual policy value:
 * the default is exactly 1 (root-only spawn — the user's intended nesting
 * policy), and the `QUANTA_MAX_SPAWN_DEPTH` env is a working escape hatch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.QUANTA_MAX_SPAWN_DEPTH
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

describe("runtime-config maxSpawnDepth", () => {
  test("DEFAULT is the intent policy: maxSpawnDepth === 1 (root-only)", () => {
    expect(runtimeConfig().maxSpawnDepth).toBe(1)
  })

  test("env escape hatch: QUANTA_MAX_SPAWN_DEPTH=2 ⇒ 2", () => {
    process.env.QUANTA_MAX_SPAWN_DEPTH = "2"
    __resetRuntimeConfig()
    expect(runtimeConfig().maxSpawnDepth).toBe(2)
  })

  test("negative / non-integer / empty floors to the default 1 (non-negative-int parser)", () => {
    for (const bad of ["-3", "", "abc", "1.5", " ", "0x1"]) {
      process.env.QUANTA_MAX_SPAWN_DEPTH = bad
      __resetRuntimeConfig()
      expect(runtimeConfig().maxSpawnDepth).toBe(1)
    }
  })

  // FIX-B (jul-13 nesting-control): 0 is now a VALID kill-switch value, not
  // floored to 1. `parseNonNegativeInt` accepts 0 (distinct from absent); the
  // spawn predicate then reads `depth < 0` = false for EVERY agent incl. root.
  test("kill-switch: QUANTA_MAX_SPAWN_DEPTH=0 ⇒ 0 (not floored to 1)", () => {
    process.env.QUANTA_MAX_SPAWN_DEPTH = "0"
    __resetRuntimeConfig()
    expect(runtimeConfig().maxSpawnDepth).toBe(0)
  })
})
