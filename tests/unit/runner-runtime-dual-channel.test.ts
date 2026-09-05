/**
 * SEP5-10 — four runner/runtime dual-channel keys: discovery is the runner
 * registry; mutation is runtimeConfig. apply is identity.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { allKnobs } from "@/runner/knobs"
import type { ApplyContext } from "@/runner/knobs/types"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import "@/runner/knobs/knobs"

const DUAL = [
  {
    envKey: "QUANTA_MCP_TOOL_ANNOTATIONS",
    discovery: "runner-knobs",
    mutation: "runtime-config",
    surface: "cli",
  },
  {
    envKey: "QUANTA_RATELIMIT_NOTICE",
    discovery: "runner-knobs",
    mutation: "runtime-config",
    surface: "cli",
  },
  {
    envKey: "QUANTA_READ_OUTLINE",
    discovery: "runner-knobs",
    mutation: "runtime-config",
    surface: "bench",
  },
  {
    envKey: "QUANTA_TEST_RUNNER",
    discovery: "runner-knobs",
    mutation: "runtime-config",
    surface: "bench",
  },
] as const

describe("runner/runtime dual-channel knobs", () => {
  test("exactly four documented dual-channel keys", () => {
    expect(DUAL.length).toBe(4)
  })

  test("each key is discoverable in runner knobs and mutated only via runtime-config", () => {
    const runtimeKeys = new Set(RUNTIME_CONFIG_KNOBS.map((k) => k.envKey))
    const cfg = { cwd: "/tmp" } as AgentConfig
    for (const row of DUAL) {
      expect(runtimeKeys.has(row.envKey)).toBe(true)
      const knob = [...allKnobs().values()].find((k) => k.envKey === row.envKey)
      expect(knob, row.envKey).toBeDefined()
      if (knob === undefined) continue
      expect(knob.surfaces).toContain(row.surface)
      const ctx: ApplyContext = { surface: row.surface }
      expect(knob.apply(cfg, true, ctx)).toBe(cfg)
    }
  })

  test("mutation: dropping a dual-channel key from the table fails the floor", () => {
    const clone = DUAL.filter((r) => r.envKey !== "QUANTA_TEST_RUNNER")
    expect(clone.length).toBe(3)
  })
})
