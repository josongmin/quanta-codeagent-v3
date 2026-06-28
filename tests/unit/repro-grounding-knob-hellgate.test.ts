/**
 * Hellgate (real knob→posture composition + gate-OFF baseline + red-on-injection)
 * for the jun-29 `repro-grounding` knob. Drives the SAME path the bench driver
 * consumes:
 *   QUANTA_BENCH_REPRO_GROUNDING → resolveBenchKnobs (real registry resolution)
 *   → benchPostureFromState → posture.reproGrounding
 * which the driver reads when deciding whether to retrieve + inject exemplar
 * skeletons + issue signatures into the repro prompt. This proves the ON toggle
 * ENGAGES (the knob is registered + read), not just that OFF is byte-identical —
 * i.e. it is not orphaned or wired-but-inert.
 *
 * Contract:
 *   - env UNSET ⇒ reproGrounding false (default-OFF, byte-identical prompt).
 *   - env="1"   ⇒ reproGrounding true  (operator opt-in → grounding injection).
 * Red-on-injection: a flipped default reds the unset case; a dropped barrel import
 * / posture read (knob no longer SEEN) reds the "=1" case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

const ENV_KEYS = [
  "QUANTA_BENCH_REPRO_GROUNDING",
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

const reproGrounding = (env: Record<string, string>): boolean => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e).reproGrounding
}

describe("repro-grounding knob (default-OFF) — ON engages, OFF byte-identical", () => {
  test("unset ⇒ reproGrounding false (un-grounded prompt)", () => {
    expect(reproGrounding({})).toBe(false)
  })

  test("QUANTA_BENCH_REPRO_GROUNDING=1 ⇒ true (opt-in ENGAGES grounding injection)", () => {
    expect(reproGrounding({ QUANTA_BENCH_REPRO_GROUNDING: "1" })).toBe(true)
  })

  test('falsy opt-out "0" ⇒ stays false (no accidental enable)', () => {
    expect(reproGrounding({ QUANTA_BENCH_REPRO_GROUNDING: "0" })).toBe(false)
  })

  test('"off"/"false" ⇒ stays false', () => {
    expect(reproGrounding({ QUANTA_BENCH_REPRO_GROUNDING: "off" })).toBe(false)
    expect(reproGrounding({ QUANTA_BENCH_REPRO_GROUNDING: "false" })).toBe(false)
  })
})
