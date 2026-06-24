/**
 * Hellgate (real report projection + red-on-injection) for bench-knob-unit-display.
 * Drives the REAL report path —
 *   env → resolveBenchKnobs (registry resolution) → knobsForReport (the SSOT the
 *   bench report serialises) — and asserts a numeric knob value never surfaces as
 *   a bare count: an object-wrapped knob (localize-phase ⇒ {phase1Turns:3}) renders
 *   "3 turns", and a unit-less boolean knob renders "on".
 *
 * Red-on-injection: if `formatKnobValue` stopped pulling the numeric field from
 * the wrapper (bare "[object Object]") or dropped the unit (bare "3"), the
 * assertions below flip. This is the report-readability invariant the feature
 * exists to guarantee, exercised through the real resolver — not the formatter
 * in isolation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { knobsForReport } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

const ENV_KEYS = [
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
] as const

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  __resetKnobOverrides()
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetKnobOverrides()
})

const report = (env: Record<string, string>): ReturnType<typeof knobsForReport> =>
  knobsForReport(resolveBenchKnobs({ envVars: env as unknown as NodeJS.ProcessEnv }))

describe("bench-knob-unit-display (report projection)", () => {
  test("object-wrapped numeric knob (localize-phase) ⇒ 'N unit', never a bare count", () => {
    const r = report({ QUANTA_BENCH_LOCALIZE_PHASE: "3" })
    expect(r["localize-phase"]).toBeDefined()
    expect(r["localize-phase"]?.display).toBe("3 turns")
    // teeth: the display must NOT be a bare number or a stringified object.
    expect(r["localize-phase"]?.display).not.toBe("3")
    expect(r["localize-phase"]?.display).not.toContain("[object")
  })

  test("unit-less boolean knob ⇒ 'on' flag (not a count)", () => {
    const r = report({ QUANTA_BENCH_LSP: "1" })
    expect(r.lsp?.display).toBe("on")
  })
})
