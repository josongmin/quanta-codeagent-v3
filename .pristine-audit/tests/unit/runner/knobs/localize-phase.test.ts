/**
 * Knob: `localize-phase` — parse + apply + surface filter.
 *
 * Locks behavior migrated from `parseLocalizePhaseEnv` in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("localize-phase knob — parse", () => {
  test("'0' ⇒ explicit OFF sentinel", () => {
    expect(localizePhaseKnob.parse("0")).toEqual({ phase1Turns: 0 })
  })

  test("integer N in [1, 20] ⇒ { phase1Turns: N }", () => {
    expect(localizePhaseKnob.parse("1")).toEqual({ phase1Turns: 1 })
    expect(localizePhaseKnob.parse("10")).toEqual({ phase1Turns: 10 })
    expect(localizePhaseKnob.parse("20")).toEqual({ phase1Turns: 20 })
  })

  test("undefined / empty ⇒ undefined", () => {
    expect(localizePhaseKnob.parse(undefined)).toBeUndefined()
    expect(localizePhaseKnob.parse("")).toBeUndefined()
  })

  test("negative ⇒ undefined", () => {
    expect(localizePhaseKnob.parse("-1")).toBeUndefined()
  })

  test("non-integer / NaN ⇒ undefined (Number(...) cleanly fails)", () => {
    expect(localizePhaseKnob.parse("1.5")).toBeUndefined()
    expect(localizePhaseKnob.parse("1abc")).toBeUndefined()
    expect(localizePhaseKnob.parse("abc")).toBeUndefined()
    expect(localizePhaseKnob.parse("NaN")).toBeUndefined()
    expect(localizePhaseKnob.parse("Infinity")).toBeUndefined()
  })

  test("> 20 ⇒ undefined (measurement-integrity cap)", () => {
    expect(localizePhaseKnob.parse("21")).toBeUndefined()
    expect(localizePhaseKnob.parse("100")).toBeUndefined()
  })
})

describe("localize-phase knob — apply", () => {
  test("bench surface + explicit OFF sentinel ⇒ cfg unchanged", () => {
    const cfg = baseCfg()
    const out = localizePhaseKnob.apply(cfg, { phase1Turns: 0 }, { surface: "bench" })
    expect(out).toBe(cfg)
    expect(out.localizePhase).toBeUndefined()
  })

  test("bench surface ⇒ cfg.localizePhase = { phase1Turns: N }", () => {
    const out = localizePhaseKnob.apply(baseCfg(), { phase1Turns: 5 }, { surface: "bench" })
    expect(out.localizePhase).toEqual({ phase1Turns: 5 })
  })

  test("non-bench surface ⇒ cfg unchanged", () => {
    const cfg = baseCfg()
    const out = localizePhaseKnob.apply(cfg, { phase1Turns: 5 }, { surface: "cli" })
    expect(out).toEqual(cfg)
    expect(out.localizePhase).toBeUndefined()
  })
})

describe("localize-phase knob — metadata", () => {
  test("conflicts ['branch-search'] + source pinned", () => {
    expect(localizePhaseKnob.id).toBe("localize-phase")
    expect(localizePhaseKnob.envKey).toBe("QUANTA_BENCH_LOCALIZE_PHASE")
    expect(localizePhaseKnob.category).toBe("agent")
    expect(localizePhaseKnob.conflicts).toEqual(["branch-search"])
    expect(localizePhaseKnob.source).toBe("Agentless absorption")
  })
})
