/**
 * GOAL-06 — wake policy is the single owner of defaults, clamps, the hard-cap
 * rule, eligibility fences and the delay ladder (rails 1, 2, 3, 4, 5, 7, 12, 16).
 */

import { describe, expect, test } from "bun:test"
import {
  autonomousAllowance,
  clampGoalQuietMs,
  computeGoalWakeDelay,
  createObjectiveAuthority,
  deriveWakeSignal,
  evaluateWakeEligibility,
  GOAL_PRODUCT_AUTONOMOUS_TURN_CAP,
  GOAL_WAKE_MAX_BACKOFF_MS,
  GOAL_WAKE_MIN_QUIET_MS,
  type ProgressReceipt,
  resolveProductAutonomousTurnCap,
} from "@/objective"
import { settleUsage } from "./v2-helpers"

const receipt = (over: Partial<ProgressReceipt>): ProgressReceipt => ({
  objectiveId: "o",
  attemptKey: "a",
  objectiveRevisionBefore: 1,
  objectiveRevisionAfter: 2,
  turnOutcome: "completed",
  criterionTransitions: [],
  verifierReceiptRefs: [],
  remainingCriterionIds: [],
  recordedAt: 0,
  ...over,
})

describe("GOAL-06 — wake policy", () => {
  test("public constants: 15 s minimum quiet, 15 min max backoff, product cap 20", () => {
    expect(GOAL_WAKE_MIN_QUIET_MS).toBe(15_000)
    expect(GOAL_WAKE_MAX_BACKOFF_MS).toBe(15 * 60 * 1000)
    expect(GOAL_PRODUCT_AUTONOMOUS_TURN_CAP).toBe(20)
  })

  test("rail 7 — a quiet value below 15 s clamps (and says so); at/above passes through", () => {
    expect(clampGoalQuietMs(50)).toEqual({ quietMs: 15_000, clamped: true })
    expect(clampGoalQuietMs(0)).toEqual({ quietMs: 15_000, clamped: true })
    expect(clampGoalQuietMs(Number.NaN)).toEqual({ quietMs: 15_000, clamped: true })
    expect(clampGoalQuietMs(undefined)).toEqual({ quietMs: 15_000, clamped: false })
    expect(clampGoalQuietMs(15_000)).toEqual({ quietMs: 15_000, clamped: false })
    expect(clampGoalQuietMs(20_000.7)).toEqual({ quietMs: 20_000, clamped: false })
  })

  test("the product cap can only be LOWERED by a caller, never raised", () => {
    expect(resolveProductAutonomousTurnCap(undefined)).toBe(20)
    expect(resolveProductAutonomousTurnCap(3)).toBe(3)
    expect(resolveProductAutonomousTurnCap(500)).toBe(20)
    expect(resolveProductAutonomousTurnCap(-1)).toBe(20)
  })

  test("rails 3/4/5 — hard-cap rule: min(userRemaining, productRemaining) with the limiting source", () => {
    // no user budget: exactly the product cap
    expect(autonomousAllowance({ turnsUsed: 0, autonomousTurnsStarted: 20 })).toEqual({
      userRemaining: Number.POSITIVE_INFINITY,
      productRemaining: 0,
      allowed: false,
      limitingSource: "product-hard-cap",
    })
    // user max 5 / product cap 3 ⇒ 3, not 5
    expect(
      autonomousAllowance({
        userMaxTurns: 5,
        turnsUsed: 3,
        autonomousTurnsStarted: 3,
        productCap: 3,
      }),
    ).toMatchObject({ allowed: false, limitingSource: "product-hard-cap", userRemaining: 2 })
    // user max 2 / product cap 20: one attributed FOREGROUND goal turn consumed a
    // user turn but zero product-cap turns ⇒ exactly one autonomous turn left
    const afterUserWork = autonomousAllowance({
      userMaxTurns: 2,
      turnsUsed: 1,
      autonomousTurnsStarted: 0,
    })
    expect(afterUserWork).toEqual({ userRemaining: 1, productRemaining: 20, allowed: true })
    expect(
      autonomousAllowance({ userMaxTurns: 2, turnsUsed: 2, autonomousTurnsStarted: 1 }),
    ).toMatchObject({ allowed: false, limitingSource: "user-budget" })
  })

  test("rail 1 — no-progress ladder 15s, 30s, 60s … capped at 15 min; progress resets; failure is cooldown", () => {
    const base = 15_000
    const at = (signal: "progress" | "no-progress" | "failure", streak: number) =>
      computeGoalWakeDelay({ baseQuietMs: base, signal, streak, now: 0 })
    expect(at("progress", 0)).toEqual({ delayMs: 15_000, reason: "quiet" })
    expect(at("no-progress", 1)).toEqual({ delayMs: 30_000, reason: "backoff" })
    expect(at("no-progress", 2)).toEqual({ delayMs: 60_000, reason: "backoff" })
    expect(at("no-progress", 3)).toEqual({ delayMs: 120_000, reason: "backoff" })
    expect(at("no-progress", 40)).toEqual({ delayMs: GOAL_WAKE_MAX_BACKOFF_MS, reason: "backoff" })
    expect(at("failure", 1)).toEqual({ delayMs: 30_000, reason: "cooldown" })
    expect(at("failure", 99)).toEqual({ delayMs: GOAL_WAKE_MAX_BACKOFF_MS, reason: "cooldown" })
    // a sub-clamp base is clamped inside the ladder too
    expect(
      computeGoalWakeDelay({ baseQuietMs: 50, signal: "progress", streak: 0, now: 0 }),
    ).toEqual({
      delayMs: 15_000,
      reason: "quiet",
    })
  })

  test("usage-limited ⇒ the exact remaining expiry (never below the base quiet)", () => {
    expect(
      computeGoalWakeDelay({
        baseQuietMs: 15_000,
        signal: "no-progress",
        streak: 5,
        usageLimitedUntil: 100_000,
        now: 40_000,
      }),
    ).toEqual({ delayMs: 60_000, reason: "usage-limit" })
    expect(
      computeGoalWakeDelay({
        baseQuietMs: 15_000,
        signal: "progress",
        streak: 0,
        usageLimitedUntil: 41_000,
        now: 40_000,
      }),
    ).toEqual({ delayMs: 15_000, reason: "usage-limit" })
    expect(
      computeGoalWakeDelay({
        baseQuietMs: 15_000,
        signal: "progress",
        streak: 0,
        usageLimitedUntil: 10,
        now: 40_000,
      }),
    ).toEqual({ delayMs: 15_000, reason: "quiet" })
  })

  test("the wake signal is DERIVED from the receipts: trailing no-progress streak, failure on the latest", () => {
    expect(deriveWakeSignal(undefined)).toEqual({ signal: "progress", streak: 0 })
    expect(deriveWakeSignal([receipt({ criterionTransitions: ["c1"] })])).toEqual({
      signal: "progress",
      streak: 0,
    })
    expect(deriveWakeSignal([receipt({}), receipt({})])).toEqual({
      signal: "no-progress",
      streak: 2,
    })
    expect(
      deriveWakeSignal([
        receipt({}),
        receipt({ verifierReceiptRefs: ["r"] }),
        receipt({}),
        receipt({ turnOutcome: "error" }),
      ]),
    ).toEqual({ signal: "failure", streak: 2 })
    expect(
      deriveWakeSignal([
        receipt({ turnOutcome: "error" }),
        receipt({ criterionTransitions: ["x"] }),
      ]),
    ).toEqual({
      signal: "progress",
      streak: 0,
    })
  })

  test("rail 16/12 — eligibility over the read port: contract missing, not active, hard cap, user budget", () => {
    const authority = createObjectiveAuthority({ now: () => 1, enforceBudget: true })
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({
      eligible: false,
      reason: "no-goal",
    })
    authority.create("t", { goal: "g" })
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({
      eligible: false,
      reason: "validation-contract-missing",
    })
    authority.replace("t", { goal: "g", successCriteria: ["c"], budget: { maxTurns: 2 } })
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({ eligible: true })
    authority.setExplicitStatus("t", "paused")
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({
      eligible: false,
      reason: "goal-not-active",
    })
    authority.setExplicitStatus("t", "active")
    settleUsage(authority, "t", { turns: 1 })
    settleUsage(authority, "t", { turns: 1 })
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({
      eligible: false,
      reason: "user-budget-exhausted",
    })
    // a budget amendment recovers a USER-limit exhaustion …
    authority.amendBudget("t", { maxTurns: 10 })
    expect(evaluateWakeEligibility(authority.readDomain("t"))).toEqual({ eligible: true })
    // … but never an exhausted product cap (injected lower cap = 2 already consumed)
    expect(evaluateWakeEligibility(authority.readDomain("t"), 0)).toEqual({
      eligible: false,
      reason: "hard-cap-exhausted",
    })
  })
})
