/**
 * Hellgate (real knob→posture composition + gate-OFF baseline + red-on-injection)
 * for the adversarial-repro knob. Drives the SAME path the bench driver consumes:
 *   QUANTA_BENCH_ADVERSARIAL_REPRO → resolveBenchKnobs (real registry resolution)
 *   → benchPostureFromState → posture.adversarialRepro.
 * knobs-bench.ts documents `benchPostureFromState` as the EFFECT SITE for these
 * NOOP-apply registry knobs (the knob file is `(cfg)=>cfg`; the real read is the
 * posture projection that the driver's repro-generation arg builders consume via
 * `posture.adversarialRepro === true ? { adversarial: true } : {}`).
 *
 * Contract:
 *   - env UNSET ⇒ adversarialRepro false (default-OFF, byte-identical baseline).
 *   - env="1"   ⇒ adversarialRepro true  (operator opt-in → adversarial repro block).
 * Red-on-injection: a flipped default (seed true) reds the unset case; a dropped
 * barrel import / posture read (knob no longer SEEN) reds the "=1" case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

const ENV_KEYS = [
  "QUANTA_BENCH_ADVERSARIAL_REPRO",
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

const adversarialRepro = (env: Record<string, string>): boolean => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e).adversarialRepro
}

describe("adversarial-repro knob (default-OFF)", () => {
  test("unset ⇒ adversarialRepro false (byte-identical baseline)", () => {
    expect(adversarialRepro({})).toBe(false)
  })

  test("QUANTA_BENCH_ADVERSARIAL_REPRO=1 ⇒ adversarialRepro true (opt-in)", () => {
    expect(adversarialRepro({ QUANTA_BENCH_ADVERSARIAL_REPRO: "1" })).toBe(true)
  })

  test('falsy opt-out "0" ⇒ stays false (no accidental enable)', () => {
    expect(adversarialRepro({ QUANTA_BENCH_ADVERSARIAL_REPRO: "0" })).toBe(false)
  })
})
