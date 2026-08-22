/**
 * Knob: `repro-test` — parse + noop apply + surface filter.
 *
 * Locks behavior migrated from `parseBenchReproTestK` in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("repro-test knob — parse", () => {
  test("integer K in [1, 40] ⇒ { samples: K }", () => {
    expect(reproTestKnob.parse("1")).toEqual({ samples: 1 })
    expect(reproTestKnob.parse("20")).toEqual({ samples: 20 })
    expect(reproTestKnob.parse("40")).toEqual({ samples: 40 })
  })

  test("0 / negative ⇒ undefined", () => {
    expect(reproTestKnob.parse("0")).toBeUndefined()
    expect(reproTestKnob.parse("-1")).toBeUndefined()
  })

  test("> 40 ⇒ undefined (paper cap bounds LLM cost)", () => {
    expect(reproTestKnob.parse("41")).toBeUndefined()
    expect(reproTestKnob.parse("1000")).toBeUndefined()
  })

  test("non-integer / garbage / empty / whitespace ⇒ undefined", () => {
    expect(reproTestKnob.parse(undefined)).toBeUndefined()
    expect(reproTestKnob.parse("")).toBeUndefined()
    expect(reproTestKnob.parse("   ")).toBeUndefined()
    expect(reproTestKnob.parse("2.5")).toBeUndefined()
    expect(reproTestKnob.parse("2abc")).toBeUndefined()
    expect(reproTestKnob.parse("abc")).toBeUndefined()
  })
})

describe("repro-test knob — apply (noop)", () => {
  test("apply NEVER mutates cfg (consumed out-of-band by driver)", () => {
    const cfg = baseCfg()
    const out = reproTestKnob.apply(cfg, { samples: 5 }, { surface: "bench" })
    expect(out).toBe(cfg)
  })

  test("non-bench surface ⇒ still noop", () => {
    const cfg = baseCfg()
    const out = reproTestKnob.apply(cfg, { samples: 5 }, { surface: "ide" })
    expect(out).toBe(cfg)
  })
})

describe("repro-test knob — metadata", () => {
  test("category 'validation' / surfaces / source pinned", () => {
    expect(reproTestKnob.id).toBe("repro-test")
    expect(reproTestKnob.envKey).toBe("QUANTA_BENCH_REPRO_TEST")
    expect(reproTestKnob.category).toBe("validation")
    expect(reproTestKnob.surfaces).toEqual(["bench"])
    expect(reproTestKnob.costMultiplier).toBeGreaterThan(1)
    expect(reproTestKnob.source).toBe("Agentless paper §3.3.1")
  })
})
