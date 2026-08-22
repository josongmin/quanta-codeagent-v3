/**
 * Hellgate (real knob→posture composition + gate-OFF baseline + red-on-injection)
 * for the SOTA++ `acceptance` knob. Drives the SAME path the bench driver consumes:
 *   QUANTA_BENCH_ACCEPTANCE → resolveBenchKnobs (real registry resolution)
 *   → benchPostureFromState → posture.acceptance
 * which the driver reads as `repairPosture.acceptance` when building
 * `makeAcceptanceSelectCandidates`. This proves the ON toggle ENGAGES (the knob is
 * registered + read), not just that OFF is byte-identical — i.e. it is not orphaned
 * or wired-but-inert.
 *
 * Contract:
 *   - env UNSET ⇒ acceptance false (default-OFF, byte-identical legacy selection).
 *   - env="1"   ⇒ acceptance true  (operator opt-in → score-once acceptance selector).
 * Red-on-injection: a flipped default (seed true) reds the unset case; a dropped
 * barrel import / posture read (knob no longer SEEN) reds the "=1" case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

const ENV_KEYS = [
  "QUANTA_BENCH_ACCEPTANCE",
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

const acceptance = (env: Record<string, string>): boolean => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e).acceptance
}

describe("acceptance knob (default-OFF) — ON engages, OFF byte-identical", () => {
  test("unset ⇒ acceptance false (legacy validator-rank selection)", () => {
    expect(acceptance({})).toBe(false)
  })

  test("QUANTA_BENCH_ACCEPTANCE=1 ⇒ acceptance true (opt-in ENGAGES the selector)", () => {
    expect(acceptance({ QUANTA_BENCH_ACCEPTANCE: "1" })).toBe(true)
  })

  test('falsy opt-out "0" ⇒ stays false (no accidental enable)', () => {
    expect(acceptance({ QUANTA_BENCH_ACCEPTANCE: "0" })).toBe(false)
  })

  test('"off"/"false" ⇒ stays false', () => {
    expect(acceptance({ QUANTA_BENCH_ACCEPTANCE: "off" })).toBe(false)
    expect(acceptance({ QUANTA_BENCH_ACCEPTANCE: "false" })).toBe(false)
  })
})
