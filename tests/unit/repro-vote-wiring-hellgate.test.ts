/**
 * #2 repro-vote WIRING hellgate.
 *
 * Proves the `repro-vote` knob actually GATES the validator composition through
 * the PROD driver's exported `buildReproVoteValidate` (the same symbol both the
 * apps prod wrapper and the runner core call). Teeth = identity:
 *   - knob OFF                ⇒ returns the fallback UNCHANGED (byte-identical
 *                               default-OFF: the repair loop's validator is the
 *                               exact legacy gate, no wrapping).
 *   - knob ON + reproducing   ⇒ returns a DIFFERENT function (the K-of-N vote).
 *   - knob ON + empty set     ⇒ wraps; the strict validator fail-closes empty set.
 *
 * Red-on-injection: flipping ONLY `QUANTA_BENCH_REPRO_VOTE` flips the identity,
 * so a regression that drops the knob read (always-on or always-off) trips here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { benchOptIns, buildReproVoteValidate } from "@/runner/batch/eval/driver"
import type { ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"
import type { Instance } from "@/runner/batch/types"

const ENV_KEYS = ["QUANTA_BENCH_REPRO_VOTE", "QUANTA_BENCH_PRESET"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const INSTANCE = { swebench: { repo: "django/django" } } as unknown as Instance
const FALLBACK = async (_a: ValidateArgs): Promise<ValidatorResult> => ({
  ok: false,
  failTail: "legacy",
})

describe("repro-vote knob gates the validator (PROD buildReproVoteValidate)", () => {
  test("DEFAULT-OFF: returns the fallback UNCHANGED (byte-identical legacy gate)", () => {
    // sanity: the knob really is off in this env
    expect(benchOptIns().reproVote).toBe(false)
    const v = buildReproVoteValidate(INSTANCE, ["repro-a", "repro-b"], FALLBACK)
    expect(v).toBe(FALLBACK) // same reference — no wrapping at all
  })

  test("ON + reproducing set: returns a DIFFERENT function (the K-of-N vote)", () => {
    process.env.QUANTA_BENCH_REPRO_VOTE = "1"
    expect(benchOptIns().reproVote).toBe(true)
    const v = buildReproVoteValidate(INSTANCE, ["repro-a", "repro-b"], FALLBACK)
    expect(v).not.toBe(FALLBACK) // wrapped with the vote
  })

  test("ON + EMPTY set: still wraps (empty set fails closed inside the vote)", () => {
    process.env.QUANTA_BENCH_REPRO_VOTE = "1"
    const v = buildReproVoteValidate(INSTANCE, [], FALLBACK)
    expect(v).not.toBe(FALLBACK)
  })

  test("preset agentless-v2 leaves the knob OFF (repair baseline, repro-vote off)", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v2"
    expect(benchOptIns().reproVote).toBe(false)
  })

  // NOTE: the agentless-v2-reprovote / agentless-v2-repair A/B presets were
  // retired (jun-23 preset cleanup). The repro-vote KNOB wiring itself stays
  // covered by the env-driven cases above (`QUANTA_BENCH_REPRO_VOTE`).
})
