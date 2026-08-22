/**
 * `maxDescendantDepth` runtime-config PIN (RFC jul-13 §4.2/§6.5 A, rev.4).
 *
 * This is the DEDICATED intent pin the RFC calls for: `maxDescendantDepth` is a
 * NUMERIC POLICY (not a bool-default-off gate), so the auto bool-default-off
 * guard covers it only via its allowlist. Here we pin the actual policy value:
 * the default is exactly 1 (rev.4 canonical, RFC line 273 "현재 default 1 유지"
 * — root-only, the user's leaf intent; this IS an immediate behavior change,
 * depth-1 children become leaves), and the `QUANTA_MAX_DESCENDANT_DEPTH` env is a
 * working escape hatch with a non-negative parse so `0` is a valid total
 * kill-switch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

describe("runtime-config maxDescendantDepth", () => {
  test("DEFAULT is the rev.4 canonical policy: maxDescendantDepth === 1 (root-only)", () => {
    expect(runtimeConfig().maxDescendantDepth).toBe(1)
  })

  test("env escape hatch: QUANTA_MAX_DESCENDANT_DEPTH=2 ⇒ 2", () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "2"
    __resetRuntimeConfig()
    expect(runtimeConfig().maxDescendantDepth).toBe(2)
  })

  test("env escape hatch: QUANTA_MAX_DESCENDANT_DEPTH=1 ⇒ 1 (root-only)", () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().maxDescendantDepth).toBe(1)
  })

  test("negative / non-integer / empty floors to the default 1 (non-negative-int parser)", () => {
    for (const bad of ["-3", "", "abc", "1.5", " ", "0x1"]) {
      process.env.QUANTA_MAX_DESCENDANT_DEPTH = bad
      __resetRuntimeConfig()
      expect(runtimeConfig().maxDescendantDepth).toBe(1)
    }
  })

  // 0 is a VALID kill-switch value, not floored to the default.
  // `parseNonNegativeInt` accepts 0 (distinct from absent); the spawn predicate
  // then reads `depth < 0` = false for EVERY agent incl. root.
  test("kill-switch: QUANTA_MAX_DESCENDANT_DEPTH=0 ⇒ 0 (not floored to 1)", () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "0"
    __resetRuntimeConfig()
    expect(runtimeConfig().maxDescendantDepth).toBe(0)
  })
})
