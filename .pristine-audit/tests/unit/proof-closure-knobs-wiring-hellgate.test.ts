/**
 * Hellgate (wiring proof + ratchet): the six jun-17 proof-driven bench-closure
 * knobs are SEEN by the bench posture projector. Each maps a default-OFF NOOP-
 * apply registry knob (src/runner/knobs/knobs/{fault-evidence,verification-plan,
 * primary-rail,patch-hygiene,no-patch-breaker,repair-escalation}.ts) to a
 * `BenchPosture` boolean field via `benchPostureFromState`.
 *
 * Contract under test (per knob):
 *   - env UNSET ⇒ posture field falsy (default-OFF, byte-identical baseline).
 *   - env="1"   ⇒ posture field true (the operator opted in).
 *
 * Red-on-injection: if any of the six knobs were to default ON (e.g. someone
 * flips the parse default or seeds the field `true`), the "unset ⇒ falsy" cases
 * below fail. If the barrel import / posture read is removed (knob no longer
 * SEEN), the "=1 ⇒ true" cases fail.
 *
 * Env save/restore + `__resetKnobOverrides` mirrors the bench knob wiring tests
 * (measurement-integrity: a stray QUANTA_BENCH_* in the dev shell must not leak).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { type BenchPosture, benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

// envKey ↔ BenchPosture field for each of the six closure knobs.
const CASES = [
  { envKey: "QUANTA_BENCH_FAULT_EVIDENCE", field: "faultEvidence" },
  { envKey: "QUANTA_BENCH_VERIFICATION_PLAN", field: "verificationPlan" },
  { envKey: "QUANTA_BENCH_PRIMARY_RAIL", field: "primaryRail" },
  { envKey: "QUANTA_BENCH_PATCH_HYGIENE", field: "patchHygiene" },
  { envKey: "QUANTA_BENCH_NO_PATCH_BREAKER", field: "noPatchBreaker" },
  { envKey: "QUANTA_BENCH_REPAIR_ESCALATION", field: "repairEscalation" },
] as const satisfies ReadonlyArray<{ envKey: string; field: keyof BenchPosture }>

// Every env var that could perturb the posture — cleared per-test so a stray
// shell export (preset / sota / another closure knob) can't leak in.
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  ...CASES.map((c) => c.envKey),
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

const posture = (env: Record<string, string>): BenchPosture => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e)
}

describe("proof-driven bench closure knobs — posture wiring (default-OFF)", () => {
  // Ratchet: with NOTHING set, all six fields are OFF. If any knob defaults ON,
  // this fails — the byte-identical baseline guard.
  test("all six fields falsy when no env set (byte-identical baseline)", () => {
    const p = posture({})
    for (const { field } of CASES) {
      expect(p[field]).toBeFalsy()
    }
  })

  for (const { envKey, field } of CASES) {
    test(`${field}: env unset ⇒ falsy`, () => {
      expect(posture({})[field]).toBeFalsy()
    })

    test(`${field}: ${envKey}=1 ⇒ true (knob SEEN by posture)`, () => {
      const p = posture({ [envKey]: "1" })
      expect(p[field]).toBe(true)
      // Isolation: turning one knob on must not flip the others.
      for (const other of CASES) {
        if (other.field === field) continue
        expect(p[other.field]).toBeFalsy()
      }
    })
  }
})
