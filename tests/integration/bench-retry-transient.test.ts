/**
 * Bench retry-transient integration tests.
 *
 * Validates the full `runRetryLoop` orchestration with realistic
 * `InstanceResult` sequences that mirror what `runInstanceOnce` would
 * produce in production:
 *   - LLM provider blip (empty patch) → recovery on retry → pass
 *   - Real model failure → terminal (no retry, measurement integrity)
 *   - Persistent transient → exhaust budget (no infinite loop)
 *   - Mixed sequences (transient → real-fail breaks loop early)
 *
 * The test mocks at the `runOne` callback boundary (one level above
 * `runInstanceOnce`), so we don't need a real sandbox / LLM / fs. This
 * pins the retry-loop CONTRACT, not the agent/verify internals.
 *
 * Also pins the budget-stamping seam: the per-attempt outcomes are echoed
 * into `InstanceResult.budget.attemptOutcomes` so the report carries the
 * full retry history.
 */
import { describe, expect, test } from "bun:test"
import {
  type AttemptOutcome,
  classifyOutcome,
  DEFAULT_POLICY,
  type RetryPolicy,
  runRetryLoop,
} from "@/runner/batch/eval/retry-policy"
import type { InstanceResult } from "@/runner/batch/types"

const mkResult = (overrides: Partial<InstanceResult>): InstanceResult => ({
  id: "scenario-1",
  passed: false,
  patch: "",
  turns: 0,
  ...overrides,
})

/** Step through a fixed sequence safely (no non-null assertion). Throws if the
 *  loop runs past the scripted length, which fails the test loud-and-clear
 *  instead of returning `undefined` and corrupting downstream assertions. */
const stepper = (sequence: readonly InstanceResult[]) => {
  let i = 0
  return async (): Promise<InstanceResult> => {
    const r = sequence[i++]
    if (r === undefined) throw new Error("retry-loop sequence exhausted")
    return r
  }
}

describe("bench retry-transient — scenario coverage", () => {
  test("1st attempt empty_patch → 2nd attempt pass ⇒ final result pass", async () => {
    const { result, loop } = await runRetryLoop(
      stepper([
        mkResult({ id: "scenario", passed: false, patch: "", error: "" }),
        mkResult({ id: "scenario", passed: true, patch: "diff" }),
      ]),
      3,
    )
    expect(result.passed).toBe(true)
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("empty-patch")
    expect(loop.outcomes[1]?.kind).toBe("pass")
  })

  test("1st attempt real-fail ⇒ no retry, final result real-fail", async () => {
    let calls = 0
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({
        passed: false,
        patch: "real diff",
        error: "verifier reported failure",
      })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
    expect(result.passed).toBe(false)
    expect(result.patch).toBe("real diff")
  })

  test("3 attempts all empty ⇒ final result is the last empty (exhausted)", async () => {
    let calls = 0
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: false, patch: "", error: "" })
    }, 3)
    expect(calls).toBe(3)
    expect(loop.attempts).toBe(3)
    expect(loop.outcomes.every((o) => o.kind === "empty-patch")).toBe(true)
    expect(result.passed).toBe(false)
  })

  test("infra-fail (env_prep_failed) → pass on retry", async () => {
    const { result, loop } = await runRetryLoop(
      stepper([
        mkResult({
          verdict: "env_prep_failed",
          error: "env prep (setupCmd) failed (code 1): something",
        }),
        mkResult({ passed: true, patch: "diff" }),
      ]),
      3,
    )
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("infra-fail")
    expect(loop.outcomes[1]?.kind).toBe("pass")
    expect(result.passed).toBe(true)
  })

  test("empty → real-fail mid-loop ⇒ stops on real-fail (signal precedence)", async () => {
    const { result, loop } = await runRetryLoop(
      stepper([
        mkResult({ patch: "", error: "" }),
        mkResult({
          patch: "diff",
          error: "verifier: completed_unresolved",
        }),
        // Should never be consumed:
        mkResult({ passed: true, patch: "should not see this" }),
      ]),
      5,
    )
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("empty-patch")
    expect(loop.outcomes[1]?.kind).toBe("real-fail")
    expect(result.patch).toBe("diff")
  })

  test("timeout → default policy stops (no retry on ambiguous)", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ patch: "x", error: "operation timed out after 600000ms" })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]).toEqual({ kind: "timeout" })
  })

  test("byte-identical: maxAttempts=1 ⇒ single call, single outcome", async () => {
    let calls = 0
    const r = mkResult({ passed: false, patch: "", error: "" })
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return r
    }, 1)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes.length).toBe(1)
    // The returned result is the same shape as if no retry layer existed.
    expect(result).toBe(r)
  })

  test("budget projection: outcomes preserve subkind + reason for the report", async () => {
    const { loop } = await runRetryLoop(
      stepper([
        mkResult({ patch: "", error: "no patch produced" }),
        mkResult({ patch: "x", error: "max turns reached" }),
      ]),
      3,
    )
    expect(loop.outcomes[0]?.kind).toBe("empty-patch")
    expect(loop.outcomes[1]).toEqual({
      kind: "real-fail",
      subkind: "max_turns_exhausted",
    })
  })

  test("classifyOutcome is consistent with runRetryLoop outcomes", async () => {
    // The loop ALWAYS classifies via classifyOutcome — pin that the two
    // entry points agree for a representative shape.
    const r = mkResult({ patch: "", error: "" })
    const direct = classifyOutcome(r)
    const { loop } = await runRetryLoop(async () => r, 1)
    expect(loop.outcomes[0]).toEqual(direct)
  })

  test("custom policy that retries timeout once ⇒ second attempt passes", async () => {
    const permissive: RetryPolicy = {
      shouldRetry(o: AttemptOutcome, attempt, max) {
        if (attempt >= max) return undefined
        if (o.kind === "timeout") return { reason: "longer budget" }
        return undefined
      },
    }
    const { result, loop } = await runRetryLoop(
      stepper([
        mkResult({ patch: "x", error: "operation timed out" }),
        mkResult({ passed: true, patch: "diff" }),
      ]),
      2,
      permissive,
    )
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("timeout")
    expect(result.passed).toBe(true)
  })

  test("verify_loop_stuck signal terminates retry (measurement integrity)", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ patch: "diff", error: "verify_loop_stuck after 5 trips" })
    }, 5)
    expect(calls).toBe(1)
    expect(loop.outcomes[0]).toEqual({
      kind: "real-fail",
      subkind: "verify_loop_stuck",
    })
  })

  test("DEFAULT_POLICY is the production export (sanity)", () => {
    expect(DEFAULT_POLICY).toBeDefined()
    expect(typeof DEFAULT_POLICY.shouldRetry).toBe("function")
  })
})
