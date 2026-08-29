import { describe, expect, test } from "bun:test"
import {
  computeGoalWakeDelay,
  type GoalWakePolicy,
  type ObjectiveDomainSnapshot,
  type ProgressReceipt,
} from "@/objective"

const policy: GoalWakePolicy = {
  minQuietMs: 15_000,
  maxBackoffMs: 900_000,
  maxAutonomousTurns: 3,
  cooldownMs: 300_000,
}

const receipt = (ordinal: number, progress = false): ProgressReceipt => ({
  objectiveId: "o1",
  attemptKey: `a${ordinal}`,
  objectiveRevisionBefore: 1,
  objectiveRevisionAfter: 1,
  turnOutcome: "error",
  criterionTransitions: progress ? ["c1"] : [],
  verifierReceiptRefs: [],
  remainingCriterionIds: ["c1"],
  recordedAt: ordinal,
})

const domain = (input?: {
  turnsUsed?: number
  maxTurns?: number
  autonomousTurnsStarted?: number
  contract?: "missing" | "manual-only" | "checked"
  receipts?: readonly ProgressReceipt[]
  status?: "active" | "paused" | "usage_limited"
}): ObjectiveDomainSnapshot => ({
  threadId: "t",
  revision: 1,
  validationContract: input?.contract ?? "manual-only",
  state: {
    explicitStatus: input?.status === "paused" ? "paused" : "active",
    ...(input?.status === "usage_limited" ? { usageLimitedUntil: 20_000 } : {}),
    objective: {
      objectiveId: "o1",
      createdBy: "user",
      threadId: "t",
      goal: "ship",
      successCriteria: [],
      status: input?.status ?? "active",
      budget: {
        turnsUsed: input?.turnsUsed ?? 0,
        tokensUsed: 0,
        ...(input?.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      },
      blockers: [],
      blockerObservations: [],
      nextActions: [],
      attempts: { autonomousTurnsStarted: input?.autonomousTurnsStarted ?? 0 },
      createdAt: 1,
      updatedAt: 1,
    },
  },
  progressReceipts: input?.receipts ?? [],
})

describe("goal wake delay policy", () => {
  test("backs off exponentially from durable no-progress receipts and caps", () => {
    for (let misses = 0; misses <= 7; misses += 1) {
      const receipts = Array.from({ length: misses }, (_, index) => receipt(index))
      const decision = computeGoalWakeDelay(domain({ receipts }), policy, {}, 1_000)
      const expected = Math.min(15_000 * 2 ** misses, 900_000)
      expect(decision).toMatchObject({ delayMs: expected })
    }
  })

  test("a progress receipt resets backoff to the base quiet window", () => {
    expect(
      computeGoalWakeDelay(
        domain({ receipts: [receipt(1), receipt(2), receipt(3, true)] }),
        policy,
      ),
    ).toEqual({ delayMs: 15_000, reason: "base" })
  })

  test("rail 3 — no user budget: the product cap counts AUTONOMOUS starts, not turnsUsed", () => {
    expect(computeGoalWakeDelay(domain({ autonomousTurnsStarted: 3 }), policy)).toEqual({
      skip: "autonomous-turn-cap",
      limitedBy: "product-hard-cap",
    })
    // user-requested goal work moved turnsUsed but consumed no product-cap slot
    expect(
      computeGoalWakeDelay(domain({ turnsUsed: 3, autonomousTurnsStarted: 2 }), policy),
    ).toMatchObject({ delayMs: 15_000 })
  })

  test("rail 4 — user max 5 / product cap 3 gives exactly 3 (budget never overrides the product cap)", () => {
    expect(
      computeGoalWakeDelay(
        domain({ maxTurns: 5, turnsUsed: 3, autonomousTurnsStarted: 3 }),
        policy,
      ),
    ).toEqual({ skip: "autonomous-turn-cap", limitedBy: "product-hard-cap" })
    expect(
      computeGoalWakeDelay(
        domain({ maxTurns: 5, turnsUsed: 2, autonomousTurnsStarted: 2 }),
        policy,
      ),
    ).toMatchObject({ delayMs: 15_000 })
  })

  test("rail 5 — user max 2 / product cap 20: one foreground goal turn leaves one autonomous turn", () => {
    const wide: GoalWakePolicy = { ...policy, maxAutonomousTurns: 20 }
    expect(
      computeGoalWakeDelay(domain({ maxTurns: 2, turnsUsed: 1, autonomousTurnsStarted: 0 }), wide),
    ).toMatchObject({ delayMs: 15_000 })
    expect(
      computeGoalWakeDelay(domain({ maxTurns: 2, turnsUsed: 2, autonomousTurnsStarted: 1 }), wide),
    ).toEqual({ skip: "autonomous-turn-cap", limitedBy: "user-budget" })
  })

  test("rail 16 — a missing validation contract never arms (and consumes no cap)", () => {
    expect(computeGoalWakeDelay(domain({ contract: "missing" }), policy)).toEqual({
      skip: "validation-contract-missing",
    })
  })

  test("policy clamps: the product cap cannot be raised above 20, quiet ≥ 15 s, backoff ≤ 15 min", () => {
    const raised: GoalWakePolicy = {
      minQuietMs: 50,
      maxBackoffMs: 99_999_999,
      maxAutonomousTurns: 999,
      cooldownMs: 1,
    }
    expect(computeGoalWakeDelay(domain({ autonomousTurnsStarted: 20 }), raised)).toEqual({
      skip: "autonomous-turn-cap",
      limitedBy: "product-hard-cap",
    })
    expect(computeGoalWakeDelay(domain(), raised)).toEqual({ delayMs: 15_000, reason: "base" })
    const receipts = Array.from({ length: 12 }, (_, index) => receipt(index))
    expect(computeGoalWakeDelay(domain({ receipts }), raised)).toEqual({
      delayMs: 900_000,
      reason: "no-progress-backoff",
    })
  })

  test("same-revision infrastructure failure cools down and edit revision resets it", () => {
    expect(
      computeGoalWakeDelay(
        domain(),
        policy,
        { infraUnavailableAtRevision: 1, observedAt: 1_000 },
        2_000,
      ),
    ).toEqual({ skip: "infra-cooldown", retryAt: 301_000 })
    expect(
      computeGoalWakeDelay(
        { ...domain(), revision: 2 },
        policy,
        { infraUnavailableAtRevision: 1, observedAt: 1_000 },
        2_000,
      ),
    ).toMatchObject({ delayMs: 15_000 })
  })

  test("usage-limited reports one absolute retry time", () => {
    expect(computeGoalWakeDelay(domain({ status: "usage_limited" }), policy, {}, 5_000)).toEqual({
      skip: "usage-limited",
      retryAt: 20_000,
    })
  })

  test("GOAL P0-1 — an approval PAUSE is not a stall: it never widens the quiet window", () => {
    const paused: ProgressReceipt = { ...receipt(1), turnOutcome: "awaiting_approval" }
    // One awaiting_approval receipt ⇒ still the base window.
    expect(computeGoalWakeDelay(domain({ receipts: [paused] }), policy, {}, 1_000)).toEqual({
      delayMs: 15_000,
      reason: "base",
    })
    // Even a run of them: the operator being slow to approve must not walk the
    // goal up the backoff ladder toward its hard cap.
    const many = [paused, { ...paused, attemptKey: "a2" }, { ...paused, attemptKey: "a3" }]
    expect(computeGoalWakeDelay(domain({ receipts: many }), policy, {}, 1_000)).toEqual({
      delayMs: 15_000,
      reason: "base",
    })
    // Paired control: a genuine no-progress error receipt STILL backs off, and
    // an approval pause in front of it does not reset that ladder either.
    expect(
      computeGoalWakeDelay(domain({ receipts: [receipt(1), receipt(2)] }), policy, {}, 1_000),
    ).toEqual({ delayMs: 60_000, reason: "no-progress-backoff" })
    expect(
      computeGoalWakeDelay(
        domain({ receipts: [receipt(1), receipt(2), paused] }),
        policy,
        {},
        1_000,
      ),
    ).toEqual({ delayMs: 15_000, reason: "base" })
  })
})
