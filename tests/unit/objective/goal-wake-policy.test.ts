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
  receipts?: readonly ProgressReceipt[]
  status?: "active" | "paused" | "usage_limited"
}): ObjectiveDomainSnapshot => ({
  threadId: "t",
  revision: 1,
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
      nextActions: [],
      attempts: { autonomousTurnsStarted: 0 },
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

  test("product cap applies only when objective maxTurns is absent", () => {
    expect(computeGoalWakeDelay(domain({ turnsUsed: 3 }), policy)).toEqual({
      skip: "autonomous-turn-cap",
    })
    expect(computeGoalWakeDelay(domain({ turnsUsed: 3, maxTurns: 5 }), policy)).toMatchObject({
      delayMs: 15_000,
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
})
