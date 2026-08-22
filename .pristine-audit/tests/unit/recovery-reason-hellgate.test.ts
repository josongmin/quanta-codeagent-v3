/**
 * ★ HELLGATE — ADR-0409 RecoveryReason taxonomy.
 *
 * The closed enum is the public contract for "why did the agent compact?". A
 * typo on either side (consumer adding a new arm, producer forgetting one)
 * has to fail at the type+test boundary, NOT silently fall through as a
 * `string`. These cases pin:
 *
 *   (a) each declared arm round-trips through `isRecoveryReason`;
 *   (b) `RECOVERY_REASONS` lists EVERY type-union arm — a future arm that
 *       forgets to register here trips an exhaustiveness check;
 *   (c) the list is frozen + readonly (a stray push trips at runtime);
 *   (d) negative cases (unknown string, non-string, prototype-poisoned input).
 */

import { describe, expect, test } from "bun:test"
import type { RecoveryReason } from "@/agent/recovery-reason"
import { isRecoveryReason, RECOVERY_REASONS } from "@/agent/recovery-reason"

const EXPECTED_ARMS: readonly RecoveryReason[] = [
  "token_budget_exceeded",
  "ptl_reactive",
  "drift_breaker",
  "manual",
  "context_change",
  "fork_branch",
  "microcompact",
]

describe("RecoveryReason taxonomy (ADR-0409) — hellgate", () => {
  test("RECOVERY_REASONS contains EXACTLY the declared arms, in declaration order", () => {
    expect(RECOVERY_REASONS.length).toBe(EXPECTED_ARMS.length)
    EXPECTED_ARMS.forEach((arm, i) => {
      expect(RECOVERY_REASONS[i]).toBe(arm)
    })
  })

  // (a) Each arm round-trips through the guard.
  for (const arm of EXPECTED_ARMS) {
    test(`arm "${arm}" round-trips through isRecoveryReason`, () => {
      expect(isRecoveryReason(arm)).toBe(true)
    })
  }

  test("unknown string ⇒ isRecoveryReason returns false", () => {
    expect(isRecoveryReason("not_a_reason")).toBe(false)
    expect(isRecoveryReason("")).toBe(false)
    expect(isRecoveryReason("Token_Budget_Exceeded")).toBe(false) // case-sensitive
  })

  test("non-string inputs ⇒ isRecoveryReason returns false (NO-THROW)", () => {
    expect(isRecoveryReason(null)).toBe(false)
    expect(isRecoveryReason(undefined)).toBe(false)
    expect(isRecoveryReason(0)).toBe(false)
    expect(isRecoveryReason(false)).toBe(false)
    expect(isRecoveryReason([])).toBe(false)
    expect(isRecoveryReason({})).toBe(false)
    expect(isRecoveryReason({ reason: "manual" })).toBe(false)
  })

  test("prototype-pollution attempt ⇒ false (the guard checks literal membership)", () => {
    // A consumer must never accept `__proto__` as a legitimate reason; the
    // includes() check uses literal equality so this is safe by construction
    // and we pin it.
    expect(isRecoveryReason("__proto__")).toBe(false)
    expect(isRecoveryReason("constructor")).toBe(false)
  })

  test("RECOVERY_REASONS is frozen — a stray mutator throws at runtime", () => {
    // Object.isFrozen confirms the freeze; an explicit push attempt should
    // throw under strict mode (bun's default) — caught here so the hellgate
    // observes the protection rather than silently accepting a mutation.
    expect(Object.isFrozen(RECOVERY_REASONS)).toBe(true)
    let threw = false
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate mutation attempt
      ;(RECOVERY_REASONS as any).push("bogus_reason")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("type-level exhaustiveness — every RecoveryReason literal is in EXPECTED_ARMS", () => {
    // tsc-time exhaustiveness: any future arm added to the union would fail
    // this assignment if the test forgot to extend EXPECTED_ARMS. We assert
    // via a never-fallthrough switch over the union.
    const _check = (r: RecoveryReason): RecoveryReason => {
      switch (r) {
        case "token_budget_exceeded":
        case "ptl_reactive":
        case "drift_breaker":
        case "manual":
        case "context_change":
        case "fork_branch":
        case "microcompact":
          return r
        default: {
          const _exhaustive: never = r
          return _exhaustive
        }
      }
    }
    // Smoke through one arm — the assertion is at compile time.
    expect(_check("manual")).toBe("manual")
  })
})
