/**
 * Hellgate (real knob→posture composition + gate-OFF baseline + red-on-injection)
 * for the H1 `dynamic-message-matcher` knob. Drives the SAME path the bench driver
 * consumes:
 *   QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER → resolveBenchKnobs (real registry
 *   resolution) → benchPostureFromState → posture.dynamicMessageMatcher.
 *
 * knobs-bench.ts documents `benchPostureFromState` as the EFFECT SITE for these
 * NOOP-apply registry knobs (the knob file is `(cfg)=>cfg`). The DRIVER read site
 * (apps/bench/eval/driver.ts) consumes the projection as:
 *   buildPublicDeclaredExpectedPort(spec, { dynamicSkeleton: posture.dynamicMessageMatcher })
 * so this test pairs the env→posture projection with a proof that the SAME boolean,
 * fed into the matcher exactly as the driver feeds it, flips a dynamic wrong-message
 * verdict from abstain (null) to veto (false). That is the live behavior branch.
 *
 * Contract:
 *   - env UNSET ⇒ dynamicMessageMatcher false (default-OFF, byte-identical baseline);
 *     a dynamic wrong message ABSTAINS (legacy T2b behavior).
 *   - env="1"   ⇒ dynamicMessageMatcher true (operator opt-in); the SAME dynamic
 *     wrong message VETOES via fixed-skeleton comparison.
 * Red-on-injection: a flipped default (seed true) reds the unset case; a dropped
 * barrel import / posture read (knob no longer SEEN) reds the "=1" case; a matcher
 * that ignores the threaded option reds the verdict-flip pair.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import type { IssueDeclaredExpected } from "@/agent/verification-plan/extract-issue-declared-expected"
import {
  buildPublicDeclaredExpectedPort,
  matchCandidateAgainstDeclaredExpected,
} from "@/runner/batch/eval/declared-expected-matcher"
import { resolveBenchKnobs } from "@/runner/batch/eval/driver"
import { benchPostureFromState } from "@/runner/batch/eval/knobs-bench"
import type { Candidate } from "@/runner/batch/eval/selection-types"
import { __resetKnobOverrides } from "@/shared/knob-overrides"

const ENV_KEYS = [
  "QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER",
  "QUANTA_BENCH_SPEC_FIDELITY_INVARIANT",
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

const dynamicMessageMatcher = (env: Record<string, string>): boolean => {
  const e = env as unknown as NodeJS.ProcessEnv
  return benchPostureFromState(resolveBenchKnobs({ envVars: e }), e).dynamicMessageMatcher
}

const V = "TimeSeries object is invalid - expected ['time'] as the first columns"
const publicExpected = (value: string): IssueDeclaredExpected => ({
  kind: "stdout",
  value,
  provenance: "public-issue-text",
})
const candidate = (patch: string): Candidate => ({
  id: "c0",
  patch,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: null,
})
// f-string whose hard-coded skeleton ("completely unrelated boom:", "happened") is
// NOT a fragment of V — a WRONG dynamic message. Legacy T2b abstains; H1 vetoes.
const WRONG_DYNAMIC = candidate(
  [
    "--- a/x.py",
    "+++ b/x.py",
    "@@ -1 +1 @@",
    '+raise ValueError(f"completely unrelated boom: {x} happened")',
  ].join("\n"),
)

describe("dynamic-message-matcher knob (default-OFF) — env→posture projection", () => {
  test("unset ⇒ dynamicMessageMatcher false (byte-identical baseline)", () => {
    expect(dynamicMessageMatcher({})).toBe(false)
  })

  test("QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER=1 ⇒ dynamicMessageMatcher true (opt-in)", () => {
    expect(dynamicMessageMatcher({ QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER: "1" })).toBe(true)
  })

  test('falsy opt-out "0" ⇒ stays false (no accidental enable)', () => {
    expect(dynamicMessageMatcher({ QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER: "0" })).toBe(false)
  })
})

describe("dynamic-message-matcher — projection drives the live matcher exactly as the driver does", () => {
  test("posture=false ⇒ port abstains on a wrong DYNAMIC message (null)", async () => {
    const on = dynamicMessageMatcher({})
    const port = buildPublicDeclaredExpectedPort(publicExpected(V), { dynamicSkeleton: on })
    expect(await port?.(WRONG_DYNAMIC)).toBeNull()
  })

  test("posture=true ⇒ SAME port vetoes the SAME wrong DYNAMIC message (false)", async () => {
    const on = dynamicMessageMatcher({ QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER: "1" })
    const port = buildPublicDeclaredExpectedPort(publicExpected(V), { dynamicSkeleton: on })
    expect(await port?.(WRONG_DYNAMIC)).toBe(false)
  })

  test("posture=true MUST NOT veto a skeleton-CONSISTENT dynamic fix (the teeth: no PASS→FAIL)", () => {
    const on = dynamicMessageMatcher({ QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER: "1" })
    const correct = [
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1 +1 @@",
      '+raise ValueError(f"TimeSeries object is invalid - expected {required} as the first columns")',
    ].join("\n")
    expect(
      matchCandidateAgainstDeclaredExpected(correct, publicExpected(V), { dynamicSkeleton: on }),
    ).toBeNull()
  })
})
