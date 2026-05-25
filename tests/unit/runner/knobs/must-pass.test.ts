/**
 * Knob: `must-pass` — verify-guard outcome-gate. NEW knob exposing the
 * previously-hardcoded `verifyGuard` block.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { mustPassKnob } from "@/runner/knobs/knobs/must-pass"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("must-pass knob — parse", () => {
  test("`off` ⇒ { mustPass: false }", () => {
    expect(mustPassKnob.parse("off")).toEqual({ mustPass: false })
  })

  test("`1` / `on` / `strict` ⇒ { mustPass: true, maxTrips: 2 }", () => {
    expect(mustPassKnob.parse("1")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("on")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("strict")).toEqual({ mustPass: true, maxTrips: 2 })
  })

  test("`2` ⇒ maxTrips:2, `3` ⇒ maxTrips:3", () => {
    expect(mustPassKnob.parse("2")).toEqual({ mustPass: true, maxTrips: 2 })
    expect(mustPassKnob.parse("3")).toEqual({ mustPass: true, maxTrips: 3 })
  })

  test("strict allow-list — everything else ⇒ undefined", () => {
    expect(mustPassKnob.parse(undefined)).toBeUndefined()
    expect(mustPassKnob.parse("")).toBeUndefined()
    expect(mustPassKnob.parse("true")).toBeUndefined()
    expect(mustPassKnob.parse("yes")).toBeUndefined()
    expect(mustPassKnob.parse("4")).toBeUndefined()
    expect(mustPassKnob.parse("0")).toBeUndefined()
    expect(mustPassKnob.parse("Off")).toBeUndefined()
    expect(mustPassKnob.parse("Strict")).toBeUndefined()
    expect(mustPassKnob.parse("garbage")).toBeUndefined()
  })
})

describe("must-pass knob — apply", () => {
  test("bench surface + mustPass:true ⇒ cfg.verifyGuard set", () => {
    const out = mustPassKnob.apply(baseCfg(), { mustPass: true, maxTrips: 2 }, { surface: "bench" })
    expect(out.verifyGuard).toEqual({ mustPass: true, maxTrips: 2 })
  })

  test("agent-batch / agent-interactive also wire verifyGuard", () => {
    for (const s of ["agent-batch", "agent-interactive"] as const) {
      const out = mustPassKnob.apply(baseCfg(), { mustPass: true, maxTrips: 3 }, { surface: s })
      expect(out.verifyGuard).toEqual({ mustPass: true, maxTrips: 3 })
    }
  })

  test("`off` ⇒ verifyGuard set with mustPass:false (force guard off)", () => {
    const out = mustPassKnob.apply(baseCfg(), { mustPass: false }, { surface: "bench" })
    expect(out.verifyGuard).toEqual({ mustPass: false })
    // exactOptionalPropertyTypes — `maxTrips` is NOT present (not undefined).
    expect("maxTrips" in (out.verifyGuard ?? {})).toBe(false)
  })

  test("non-supported surface (cli, ide) ⇒ cfg unchanged", () => {
    for (const s of ["cli", "ide"] as const) {
      const out = mustPassKnob.apply(baseCfg(), { mustPass: true, maxTrips: 2 }, { surface: s })
      expect(out.verifyGuard).toBeUndefined()
    }
  })
})

describe("must-pass knob — metadata", () => {
  test("category 'verify' / default undefined / source pinned", () => {
    expect(mustPassKnob.id).toBe("must-pass")
    expect(mustPassKnob.envKey).toBe("QUANTA_BENCH_MUST_PASS")
    expect(mustPassKnob.category).toBe("verify")
    expect(mustPassKnob.surfaces).toEqual(["bench", "agent-batch", "agent-interactive"])
    expect(mustPassKnob.default).toBeUndefined()
    expect(mustPassKnob.source).toBe("RCA 2026-05-25 sanity")
  })
})
