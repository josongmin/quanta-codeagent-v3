/**
 * ★ HELLGATE (W3, domain half) — the CLI half lives in
 * tests/unit/cli/goal-render-wake.test.ts, because the slice fence keeps
 * `@/apps/cli` internals out of a library-slice test.
 *
 * (W3, domain half) — an idle wake says WHEN it can retry and WHICH
 * bound stopped it.
 *
 * MEASURED DEFECT (2026-08-30, two audit rounds): `computeGoalWakeDelay` already
 * computes both. A usage-limited skip carries `retryAt`, an infra cooldown
 * carries `retryAt`, and a cap skip carries `limitedBy`. `status()` then
 * collapses the whole decision to `{ kind: "idle", skipReason }` and throws the
 * rest away, so `/goal show` can say "wake: idle (usage-limited)" and nothing
 * about whether that is thirty seconds or four hours — the operator's actual
 * question.
 *
 * This is the same defect as the `budget.limitedBy` one fixed this morning,
 * in a second place: a bound the domain derives, reaching no surface.
 *
 * The armed arm is deliberately NOT touched. Adding `armedAt` there means
 * widening the controller type and tracking new state inside a function already
 * at 144 of its 150-line ceiling, and four tests pin the armed object exactly.
 * That is a separate slice, not a free rider on this one.
 */

import { describe, expect, test } from "bun:test"
import type { ObjectiveDomainSnapshot } from "@/objective"
import { computeGoalWakeDelay, DEFAULT_GOAL_WAKE_POLICY, idleStatusFor } from "@/objective"

const domain = (over: {
  status?: "active" | "paused" | "usage_limited"
  usageLimitedUntil?: number
}): ObjectiveDomainSnapshot =>
  ({
    threadId: "t",
    revision: 1,
    attachGeneration: 0,
    validationContract: "manual-only",
    progressReceipts: [],
    state: {
      explicitStatus: "active",
      // `usageLimitedUntil` lives on the STATE, not the objective — the first
      // draft of this helper accepted the option and never wrote it, which made
      // the retryAt assertion compare undefined to undefined. The mutant that
      // deleted the projection stayed green and said so.
      ...(over.usageLimitedUntil !== undefined
        ? { usageLimitedUntil: over.usageLimitedUntil }
        : {}),
      objective: {
        objectiveId: "o-1",
        threadId: "t",
        goal: "g",
        createdBy: "user",
        successCriteria: [{ kind: "manual", id: "c", text: "c", met: false }],
        status: over.status ?? "active",
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: [],
        blockerObservations: [],
        nextActions: [],
        attempts: { autonomousTurnsStarted: 0 },
        createdAt: 0,
        updatedAt: 0,
      },
    },
  }) as unknown as ObjectiveDomainSnapshot

describe("W3 — the idle status keeps what the decision computed", () => {
  test("a usage-limited skip carries the retryAt the policy already produced", () => {
    const decision = computeGoalWakeDelay(
      domain({ status: "usage_limited", usageLimitedUntil: 90_000 }),
      DEFAULT_GOAL_WAKE_POLICY,
      undefined,
      10_000,
    )
    if (!("skip" in decision)) throw new Error("expected a skip decision")

    const status = idleStatusFor(decision)

    expect(decision.skip).toBe("usage-limited")
    // A NUMBER, not merely "the same as the decision" — two undefineds compare
    // equal, which is exactly how the first version of this test passed against
    // a projection that discarded the field.
    expect(typeof decision.retryAt).toBe("number")
    expect(status.kind).toBe("idle")
    expect(status.skipReason).toBe("usage-limited")
    expect(status.retryAt).toBe(90_000)
  })

  test("a skip with no retry information carries none — nothing is invented", () => {
    // A paused goal skips as `not-active`, which has no retry instant and no
    // bound — the control that stops the projection inventing either.
    const decision = computeGoalWakeDelay(
      domain({ status: "paused" }),
      DEFAULT_GOAL_WAKE_POLICY,
      undefined,
      10_000,
    )
    if (!("skip" in decision)) throw new Error("expected a skip decision")

    const status = idleStatusFor(decision)

    expect(status.retryAt).toBeUndefined()
    expect(status.limitedBy).toBeUndefined()
  })
})
