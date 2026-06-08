/**
 * §4.3 / §4.4 — runtime-config gate byte-identity.
 *
 * Both new gates (`QUANTA_SUBAGENT_TYPED_KIND`, `QUANTA_SIDE_AGENT_PROCESS`)
 * default OFF: absent ⇒ false (the legacy in-process / free-string path is
 * byte-identical). Present truthy ⇒ true. Asserts via the canonical
 * `runtimeConfig()` accessor + its `__resetRuntimeConfig` test seam.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "../../src/shared"

const KEYS = ["QUANTA_SUBAGENT_TYPED_KIND", "QUANTA_SIDE_AGENT_PROCESS"] as const

const snapshot = (): Record<string, string | undefined> => {
  const s: Record<string, string | undefined> = {}
  for (const k of KEYS) s[k] = process.env[k]
  return s
}

afterEach(() => {
  // restore + reset cache so tests don't bleed.
  __resetRuntimeConfig()
})

describe("§4.3/§4.4 new gates — DEFAULT-OFF", () => {
  test("absent ⇒ both false (byte-identical legacy path)", () => {
    const prev = snapshot()
    for (const k of KEYS) delete process.env[k]
    __resetRuntimeConfig()
    const cfg = runtimeConfig()
    expect(cfg.subagentTypedKind).toBe(false)
    expect(cfg.sideAgentProcess).toBe(false)
    for (const k of KEYS) if (prev[k] !== undefined) process.env[k] = prev[k]
  })

  test("=1 ⇒ true (opt-in)", () => {
    const prev = snapshot()
    process.env["QUANTA_SUBAGENT_TYPED_KIND"] = "1"
    process.env["QUANTA_SIDE_AGENT_PROCESS"] = "1"
    __resetRuntimeConfig()
    const cfg = runtimeConfig()
    expect(cfg.subagentTypedKind).toBe(true)
    expect(cfg.sideAgentProcess).toBe(true)
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
})
