/**
 * Retry-policy unit tests.
 *
 * Covers:
 *   - `DEFAULT_POLICY.shouldRetry` decision table (every kind × budget state).
 *   - `classifyOutcome` mapping from `InstanceResult` → `AttemptOutcome` —
 *     each branch is pinned in isolation so a future shift in `runAgent`'s
 *     error string format only breaks ONE test.
 *   - `parseRetryTransientEnv` strict integer gate.
 *   - `runRetryLoop` orchestrator: byte-identical 1-attempt, retry on
 *     transient + stop on signal, exhaust budget on persistent transient.
 */
import { describe, expect, test } from "bun:test"
import {
  type AttemptOutcome,
  classifyOutcome,
  DEFAULT_POLICY,
  parseRetryTransientEnv,
  type RetryPolicy,
  runRetryLoop,
} from "@/runner/batch/eval/retry-policy"
import type { InstanceResult } from "@/runner/batch/types"

const mkResult = (overrides: Partial<InstanceResult>): InstanceResult => ({
  id: "test-1",
  passed: false,
  patch: "",
  turns: 0,
  ...overrides,
})

// ──────────────────────────────────────────────────────────────────────────
// DEFAULT_POLICY.shouldRetry
// ──────────────────────────────────────────────────────────────────────────

describe("DEFAULT_POLICY.shouldRetry — transient kinds", () => {
  test("empty-patch attempt 1, max 2 ⇒ retry", () => {
    const decision = DEFAULT_POLICY.shouldRetry({ kind: "empty-patch" }, 1, 2)
    expect(decision).toBeDefined()
    expect(decision?.reason).toContain("empty patch")
  })

  test("empty-patch with reason ⇒ retry reason still uses default text", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "empty-patch", reason: "stream error" },
      1,
      3,
    )
    expect(decision).toBeDefined()
    expect(decision?.reason).toContain("LLM/API failure")
  })

  test("infra-fail attempt 1 ⇒ retry with the underlying reason", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "infra-fail", reason: "spawn ENOENT" },
      1,
      2,
    )
    expect(decision).toBeDefined()
    expect(decision?.reason).toBe("spawn ENOENT")
  })

  test("empty-patch attempt 2 of 2 (max reached) ⇒ NO retry (budget exhausted)", () => {
    const decision = DEFAULT_POLICY.shouldRetry({ kind: "empty-patch" }, 2, 2)
    expect(decision).toBeUndefined()
  })

  test("infra-fail attempt 3 of 3 ⇒ NO retry (budget exhausted)", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "infra-fail", reason: "harness crash" },
      3,
      3,
    )
    expect(decision).toBeUndefined()
  })
})

describe("DEFAULT_POLICY.shouldRetry — terminal kinds (never retry)", () => {
  test("pass attempt 1 of 3 ⇒ NO retry (success is terminal)", () => {
    const decision = DEFAULT_POLICY.shouldRetry({ kind: "pass" }, 1, 3)
    expect(decision).toBeUndefined()
  })

  test("real-fail completed_unresolved ⇒ NO retry (model signal)", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "real-fail", subkind: "completed_unresolved" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })

  test("real-fail verify_loop_stuck ⇒ NO retry", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "real-fail", subkind: "verify_loop_stuck" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })

  test("real-fail max_turns_exhausted ⇒ NO retry", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "real-fail", subkind: "max_turns_exhausted" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })

  test("real-fail budget_exhausted ⇒ NO retry", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "real-fail", subkind: "budget_exhausted" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })

  test("grader-invalid ⇒ NO retry (dataset authority issue)", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "grader-invalid", reason: "gold sanity failed" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })

  test("admission-blocked ⇒ NO retry (bench policy, not transient)", () => {
    const decision = DEFAULT_POLICY.shouldRetry(
      { kind: "admission-blocked", source: "patch_budget_strict", reason: "patch budget exceeded" },
      1,
      3,
    )
    expect(decision).toBeUndefined()
  })
})

describe("DEFAULT_POLICY.shouldRetry — timeout (ambiguous, no retry by default)", () => {
  test("timeout attempt 1 of 3 ⇒ NO retry (ambiguous outcome)", () => {
    const decision = DEFAULT_POLICY.shouldRetry({ kind: "timeout" }, 1, 3)
    expect(decision).toBeUndefined()
  })

  test("custom policy may retry timeout ⇒ shape allows it", () => {
    const permissive: RetryPolicy = {
      shouldRetry(o, attempt, max) {
        if (attempt >= max) return undefined
        if (o.kind === "timeout") return { reason: "extending budget" }
        return undefined
      },
    }
    const decision = permissive.shouldRetry({ kind: "timeout" }, 1, 3)
    expect(decision?.reason).toBe("extending budget")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// classifyOutcome
// ──────────────────────────────────────────────────────────────────────────

describe("classifyOutcome — pass", () => {
  test("passed=true ⇒ pass (ignores everything else)", () => {
    expect(classifyOutcome(mkResult({ passed: true }))).toEqual({ kind: "pass" })
    expect(classifyOutcome(mkResult({ passed: true, patch: "diff", error: "x" }))).toEqual({
      kind: "pass",
    })
  })
})

describe("classifyOutcome — verdict-driven terminal and infra classifications", () => {
  test("verdict=env_prep_failed ⇒ infra-fail", () => {
    const result = mkResult({ verdict: "env_prep_failed", error: "setupCmd died" })
    expect(classifyOutcome(result)).toEqual({ kind: "infra-fail", reason: "setupCmd died" })
  })

  test("verdict=degraded ⇒ infra-fail (recorder failure)", () => {
    const result = mkResult({ verdict: "degraded", error: "observation failed" })
    expect(classifyOutcome(result)).toEqual({ kind: "infra-fail", reason: "observation failed" })
  })

  test("verdict=grader_invalid ⇒ grader-invalid", () => {
    const result = mkResult({ verdict: "grader_invalid", error: "gold sanity failed" })
    expect(classifyOutcome(result)).toEqual({
      kind: "grader-invalid",
      reason: "gold sanity failed",
    })
  })

  test("verdict=env_prep_failed without error ⇒ uses verdict as reason", () => {
    const result = mkResult({ verdict: "env_prep_failed" })
    const out = classifyOutcome(result)
    expect(out.kind).toBe("infra-fail")
    if (out.kind === "infra-fail") expect(out.reason).toBe("env_prep_failed")
  })

  test("admissionBlock=patch_budget_strict ⇒ admission-blocked", () => {
    const result = mkResult({
      patch: "",
      turns: 12,
      error: "patch budget exceeded: new-def budget=0",
      admissionBlock: { kind: "patch_budget_strict" },
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "admission-blocked",
      source: "patch_budget_strict",
      reason: "patch budget exceeded: new-def budget=0",
    })
  })
})

describe("classifyOutcome — empty-patch", () => {
  test("agent/provider generation failure with empty patch ⇒ generation-fail, not empty-patch", () => {
    const result = mkResult({
      patch: "",
      passed: false,
      error:
        "LLM stream failed after retries: chatgpt-oauth responses request failed: 429 Too Many Requests — usage_limit_reached",
    })
    const out = classifyOutcome(result)
    expect(out.kind).toBe("generation-fail")
    if (out.kind === "generation-fail") expect(out.reason).toContain("usage_limit_reached")
  })

  test("error contains 'empty prediction' ⇒ empty-patch", () => {
    const result = mkResult({ error: "agent emitted empty prediction" })
    const out = classifyOutcome(result)
    expect(out.kind).toBe("empty-patch")
    if (out.kind === "empty-patch") expect(out.reason).toContain("empty prediction")
  })

  test("error contains 'no patch produced' ⇒ empty-patch", () => {
    const result = mkResult({ error: "no patch produced after 30 turns" })
    expect(classifyOutcome(result).kind).toBe("empty-patch")
  })

  test("empty patch + no specific error string ⇒ empty-patch", () => {
    const result = mkResult({ patch: "", passed: false })
    expect(classifyOutcome(result).kind).toBe("empty-patch")
  })

  test("completed agent turn with empty patch ⇒ real-fail, not retryable empty-patch", () => {
    const result = mkResult({ patch: "", passed: false, turns: 16 })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("legacy verifier empty-prediction after agent turns ⇒ real-fail, not retryable empty-patch", () => {
    const result = mkResult({
      patch: "",
      passed: false,
      turns: 16,
      error: "empty prediction (agent produced no patch)",
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("empty patch + non-classifying error ⇒ empty-patch with reason", () => {
    const result = mkResult({ patch: "", passed: false, error: "weird thing happened" })
    const out = classifyOutcome(result)
    expect(out.kind).toBe("empty-patch")
    if (out.kind === "empty-patch") expect(out.reason).toBe("weird thing happened")
  })
})

describe("classifyOutcome — timeout", () => {
  test("error contains 'operation timed out' ⇒ timeout", () => {
    const result = mkResult({ patch: "x", error: "operation timed out after 600000ms" })
    expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
  })

  test("error contains 'SIGTERM' ⇒ timeout", () => {
    const result = mkResult({ patch: "x", error: "child process killed by SIGTERM" })
    expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
  })

  test("error contains 'aborted by signal' ⇒ timeout", () => {
    const result = mkResult({ patch: "x", error: "aborted by signal" })
    expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
  })

  test("error contains generic 'aborted' ⇒ timeout", () => {
    const result = mkResult({ patch: "", turns: 4, error: "agent aborted before verification" })
    expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
  })
})

describe("classifyOutcome — infra-fail string patterns", () => {
  test("error contains 'harness' ⇒ infra-fail", () => {
    const result = mkResult({ patch: "x", error: "harness Docker daemon offline" })
    const out = classifyOutcome(result)
    expect(out.kind).toBe("infra-fail")
  })

  test("error contains 'EACCES' ⇒ infra-fail", () => {
    const result = mkResult({ patch: "x", error: "EACCES /tmp/sandbox" })
    expect(classifyOutcome(result).kind).toBe("infra-fail")
  })

  test("error contains 'spawn E*' ⇒ infra-fail", () => {
    const result = mkResult({ patch: "x", error: "spawn EBADF" })
    expect(classifyOutcome(result).kind).toBe("infra-fail")
  })
})

describe("classifyOutcome — real-fail subkinds", () => {
  test("error 'verify loop stuck' ⇒ real-fail / verify_loop_stuck", () => {
    const result = mkResult({ patch: "x", error: "verify loop stuck after retries" })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "verify_loop_stuck",
    })
  })

  test("error 'max turns reached' ⇒ real-fail / max_turns_exhausted", () => {
    const result = mkResult({ patch: "x", error: "max turns reached" })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "max_turns_exhausted",
    })
  })

  test("error 'agent exhausted token budget before verification' ⇒ real-fail / budget_exhausted", () => {
    const result = mkResult({
      patch: "x",
      error: "agent exhausted token budget before verification",
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "budget_exhausted",
    })
  })

  test("budget no-patch breaker error stays budget_exhausted, not max_turns_exhausted", () => {
    const result = mkResult({
      patch: "",
      turns: 9,
      error: "no patch produced before token budget exhausted (no_patch_exhausted)",
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "budget_exhausted",
    })
  })

  test("max-turn no-patch breaker error stays max_turns_exhausted", () => {
    const result = mkResult({
      patch: "",
      turns: 9,
      error: "no patch produced before max turns exhausted (no_patch_exhausted)",
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "max_turns_exhausted",
    })
  })

  test("verify-select no-submittable-candidate stays completed_unresolved, not generation-fail", () => {
    const result = mkResult({
      patch: "",
      turns: 9,
      error:
        "verify-select produced no submittable candidate (all candidates were empty or did not apply)",
    })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("non-empty patch + non-classifying error ⇒ real-fail / completed_unresolved", () => {
    const result = mkResult({ patch: "real diff", error: "verifier rejected" })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("non-empty patch + no error ⇒ real-fail / completed_unresolved (fallback)", () => {
    const result = mkResult({ patch: "real diff", passed: false })
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// parseRetryTransientEnv
// ──────────────────────────────────────────────────────────────────────────

describe("parseRetryTransientEnv — strict integer gate", () => {
  test("integer in [1,5] ⇒ accepted", () => {
    expect(parseRetryTransientEnv("1")).toBe(1)
    expect(parseRetryTransientEnv("2")).toBe(2)
    expect(parseRetryTransientEnv("5")).toBe(5)
  })

  test("out of range (0, 6, negative) ⇒ undefined", () => {
    expect(parseRetryTransientEnv("0")).toBeUndefined()
    expect(parseRetryTransientEnv("6")).toBeUndefined()
    expect(parseRetryTransientEnv("-1")).toBeUndefined()
    expect(parseRetryTransientEnv("100")).toBeUndefined()
  })

  test("non-integer / garbage / empty / whitespace ⇒ undefined", () => {
    expect(parseRetryTransientEnv(undefined)).toBeUndefined()
    expect(parseRetryTransientEnv("")).toBeUndefined()
    expect(parseRetryTransientEnv("   ")).toBeUndefined()
    expect(parseRetryTransientEnv("2.5")).toBeUndefined()
    expect(parseRetryTransientEnv("2abc")).toBeUndefined()
    expect(parseRetryTransientEnv("abc")).toBeUndefined()
    expect(parseRetryTransientEnv("1 2")).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// runRetryLoop
// ──────────────────────────────────────────────────────────────────────────

describe("runRetryLoop — orchestrator", () => {
  test("max=1 ⇒ exactly one call, no retry attempted", async () => {
    let calls = 0
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: true })
    }, 1)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes).toEqual([{ kind: "pass" }])
    expect(result.passed).toBe(true)
  })

  test("pass on first attempt ⇒ does not call runOne a second time", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: true })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
  })

  test("empty-patch → pass: retries once then stops", async () => {
    const sequence: InstanceResult[] = [
      mkResult({ passed: false, patch: "", error: "" }),
      mkResult({ passed: true, patch: "diff" }),
    ]
    let i = 0
    const { result, loop } = await runRetryLoop(async () => {
      const r = sequence[i++]
      if (r === undefined) throw new Error("sequence exhausted")
      return r
    }, 3)
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("empty-patch")
    expect(loop.outcomes[1]?.kind).toBe("pass")
    expect(result.passed).toBe(true)
  })

  test("generation-fail on first attempt ⇒ default policy stops without retry", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({
        patch: "",
        error: "agent stopped with error before verification: usage_limit_reached",
      })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]?.kind).toBe("generation-fail")
  })

  test("3 consecutive empty-patch, max=3 ⇒ exhausts and stops", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: false, patch: "", error: "" })
    }, 3)
    expect(calls).toBe(3)
    expect(loop.attempts).toBe(3)
    expect(loop.outcomes.every((o) => o.kind === "empty-patch")).toBe(true)
  })

  test("completed empty patch is terminal and does not retry", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: false, patch: "", turns: 16 })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
  })

  test("real-fail on first attempt ⇒ no retry (signal)", async () => {
    let calls = 0
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({
        passed: false,
        patch: "real diff",
        error: "verifier rejected",
      })
    }, 5)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]).toEqual({
      kind: "real-fail",
      subkind: "completed_unresolved",
    })
    expect(result.passed).toBe(false)
  })

  test("grader-invalid on first attempt ⇒ no retry", async () => {
    let calls = 0
    const { result, loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({
        verdict: "grader_invalid",
        error: "gold sanity failed",
      })
    }, 5)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
    expect(loop.outcomes[0]).toEqual({
      kind: "grader-invalid",
      reason: "gold sanity failed",
    })
    expect(result.verdict).toBe("grader_invalid")
  })

  test("timeout on first attempt ⇒ default policy stops", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ patch: "x", error: "operation timed out" })
    }, 3)
    expect(calls).toBe(1)
    expect(loop.outcomes[0]).toEqual({ kind: "timeout" })
  })

  test("custom policy that retries timeout ⇒ loop continues", async () => {
    const sequence: InstanceResult[] = [
      mkResult({ patch: "x", error: "operation timed out" }),
      mkResult({ passed: true, patch: "diff" }),
    ]
    let i = 0
    const permissive: RetryPolicy = {
      shouldRetry(o: AttemptOutcome, attempt, max) {
        if (attempt >= max) return undefined
        if (o.kind === "timeout") return { reason: "extending budget" }
        return undefined
      },
    }
    const { result, loop } = await runRetryLoop(
      async () => {
        const r = sequence[i++]
        if (r === undefined) throw new Error("sequence exhausted")
        return r
      },
      3,
      permissive,
    )
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("timeout")
    expect(loop.outcomes[1]?.kind).toBe("pass")
    expect(result.passed).toBe(true)
  })

  test("infra-fail → pass: retries on harness crash", async () => {
    const sequence: InstanceResult[] = [
      mkResult({ verdict: "degraded", error: "observation failed" }),
      mkResult({ passed: true, patch: "diff" }),
    ]
    let i = 0
    const { result, loop } = await runRetryLoop(async () => {
      const r = sequence[i++]
      if (r === undefined) throw new Error("sequence exhausted")
      return r
    }, 3)
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("infra-fail")
    expect(result.passed).toBe(true)
  })

  test("maxAttempts < 1 ⇒ pinned to 1 (defensive)", async () => {
    let calls = 0
    const { loop } = await runRetryLoop(async () => {
      calls += 1
      return mkResult({ passed: true })
    }, 0)
    expect(calls).toBe(1)
    expect(loop.attempts).toBe(1)
  })

  test("empty-patch ahead of real-fail ⇒ real-fail breaks the loop", async () => {
    const sequence: InstanceResult[] = [
      mkResult({ patch: "", error: "" }),
      mkResult({ patch: "diff", error: "verifier rejected" }),
    ]
    let i = 0
    const { result, loop } = await runRetryLoop(async () => {
      const r = sequence[i++]
      if (r === undefined) throw new Error("sequence exhausted")
      return r
    }, 5)
    expect(loop.attempts).toBe(2)
    expect(loop.outcomes[0]?.kind).toBe("empty-patch")
    expect(loop.outcomes[1]?.kind).toBe("real-fail")
    expect(result.patch).toBe("diff")
  })
})
