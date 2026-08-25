/**
 * GOAL-06 — the bounded, EVENT-DRIVEN goal wake controller.
 *
 * One owned timer per thread/objective; arm and fire both require live
 * quiescence (typed busy reasons); the delay is the policy ladder derived from
 * the attributed receipts; a controller-local activity epoch rejects a fire
 * that raced raw user input; the claim registry is bounded (one entry per
 * thread+objective, ≤1 reservation); reconcile runs BEFORE the fire-time
 * reread; every decision is typed and observable through `status()`.
 */

import { describe, expect, test } from "bun:test"
import {
  createGoalWakeController,
  createInMemoryGoalWakeAttemptRegistry,
  createObjectiveAuthority,
  evaluateGoalWakeArm,
  evaluateGoalWakeFire,
  GOAL_WAKE_MIN_QUIET_MS,
  type GoalQuiescence,
  type GoalWakeAttempt,
  type GoalWakeDecisionEvent,
  type GoalWakeTimer,
  type ObjectiveAuthority,
  type ObjectiveDomainSnapshot,
} from "@/objective"
import { settleUsage } from "./v2-helpers"

const TID = "thread-1"

const fakeTimer = (): GoalWakeTimer & {
  fire(): Promise<void>
  scheduled(): number
  cleared(): number
  delays(): readonly number[]
} => {
  let callback: (() => void) | undefined
  let scheduledCount = 0
  let clearedCount = 0
  const delays: number[] = []
  return {
    set: (fn, ms) => {
      callback = fn
      scheduledCount += 1
      delays.push(ms)
      return scheduledCount
    },
    clear: () => {
      clearedCount += 1
    },
    fire: async () => {
      callback?.()
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    },
    scheduled: () => scheduledCount,
    cleared: () => clearedCount,
    delays: () => delays,
  }
}

/** A real authority with a checked contract so the wake is eligible. */
const authorityWithGoal = (
  opts: { maxTurns?: number; productCap?: number; enforce?: boolean } = {},
) => {
  const authority = createObjectiveAuthority({
    now: () => 1_000,
    enforceBudget: opts.enforce ?? false,
    ...(opts.productCap !== undefined ? { productAutonomousTurnCap: opts.productCap } : {}),
  })
  authority.create(TID, {
    goal: "ship",
    successCriteria: ["c"],
    ...(opts.maxTurns !== undefined ? { budget: { maxTurns: opts.maxTurns } } : {}),
  })
  return authority
}

const QUIET: GoalQuiescence = { quiescent: true }

const makeController = (
  authority: ObjectiveAuthority,
  over: Partial<Parameters<typeof createGoalWakeController>[0]> = {},
) => {
  const timer = fakeTimer()
  const events: GoalWakeDecisionEvent[] = []
  const launched: GoalWakeAttempt[] = []
  let now = 1_000
  const controller = createGoalWakeController({
    enabled: true,
    baseQuietMs: GOAL_WAKE_MIN_QUIET_MS,
    timer,
    now: () => now,
    readDomain: (id) => authority.readDomain(id),
    quiescence: () => QUIET,
    enqueue: (attempt) => {
      launched.push(attempt)
    },
    onDecision: (e) => events.push(e),
    ...over,
  })
  return { controller, timer, events, launched, setNow: (t: number) => (now = t) }
}

describe("goal wake controller — pure fences", () => {
  test("arm requires an eligible authority snapshot and a valid checkpoint (typed reasons)", () => {
    const authority = authorityWithGoal()
    const base = { enabled: true, stopped: false, threadId: TID, checkpointOrdinal: 0 }
    expect(evaluateGoalWakeArm({ ...base, current: authority.readDomain(TID) })).toEqual({
      arm: true,
    })
    expect(
      evaluateGoalWakeArm({ ...base, enabled: false, current: authority.readDomain(TID) }),
    ).toEqual({
      arm: false,
      skipReason: "disabled",
    })
    expect(
      evaluateGoalWakeArm({ ...base, threadId: "", current: authority.readDomain(TID) }),
    ).toEqual({
      arm: false,
      skipReason: "invalid-thread",
    })
    expect(evaluateGoalWakeArm({ ...base, current: null })).toEqual({
      arm: false,
      skipReason: "no-goal",
    })
    authority.setExplicitStatus(TID, "paused")
    expect(evaluateGoalWakeArm({ ...base, current: authority.readDomain(TID) })).toEqual({
      arm: false,
      skipReason: "goal-not-active",
    })
    const bare = createObjectiveAuthority({ now: () => 1 })
    bare.create(TID, { goal: "no contract" })
    expect(evaluateGoalWakeArm({ ...base, current: bare.readDomain(TID) })).toEqual({
      arm: false,
      skipReason: "validation-contract-missing",
    })
  })

  test("fire requires the exact armed revision + objective, unchanged activity epoch and live quiescence", () => {
    const authority = authorityWithGoal()
    const domain = authority.readDomain(TID)
    const expected: GoalWakeAttempt = {
      threadId: TID,
      objectiveId: domain.state?.objective.objectiveId ?? "",
      objectiveRevision: domain.revision,
      checkpointOrdinal: 1,
      activityEpoch: 3,
      attemptKey: "k",
    }
    const base = {
      enabled: true,
      stopped: false,
      expected,
      current: domain,
      activityEpoch: 3,
      quiescence: QUIET,
    }
    expect(evaluateGoalWakeFire(base)).toEqual({ arm: true })
    expect(evaluateGoalWakeFire({ ...base, activityEpoch: 4 })).toEqual({
      arm: false,
      skipReason: "activity-epoch-changed",
    })
    expect(
      evaluateGoalWakeFire({ ...base, quiescence: { quiescent: false, reason: "turn-active" } }),
    ).toEqual({
      arm: false,
      skipReason: "no-longer-quiescent",
      busyReason: "turn-active",
    })
    authority.setNextActions(TID, ["x"])
    expect(evaluateGoalWakeFire({ ...base, current: authority.readDomain(TID) })).toEqual({
      arm: false,
      skipReason: "revision-changed",
    })
    authority.replace(TID, { goal: "new generation", successCriteria: ["c"] })
    expect(
      evaluateGoalWakeFire({
        ...base,
        expected: { ...expected, objectiveRevision: authority.readDomain(TID).revision },
        current: authority.readDomain(TID),
      }),
    ).toEqual({ arm: false, skipReason: "objective-changed" })
  })
})

describe("goal wake controller — lifecycle", () => {
  test("default OFF neither reads the authority nor arms a timer", () => {
    let reads = 0
    const { controller, timer } = makeController(authorityWithGoal(), {
      enabled: false,
      readDomain: () => {
        reads += 1
        return null as unknown as ObjectiveDomainSnapshot
      },
    })
    expect(controller.arm({ threadId: TID, checkpointOrdinal: 0 })).toBeUndefined()
    expect(reads).toBe(0)
    expect(timer.scheduled()).toBe(0)
    expect(controller.status()).toEqual({ kind: "idle", skipReason: "disabled" })
  })

  test("reset replaces the only pending timer; cancel and stop fence queued callbacks; status tracks it", async () => {
    const { controller, timer, launched } = makeController(authorityWithGoal())
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    expect(controller.status()).toMatchObject({ kind: "armed", delayMs: 15_000, reason: "quiet" })
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.scheduled()).toBe(2)
    expect(timer.cleared()).toBe(1)
    await timer.fire()
    expect(launched.map((a) => a.checkpointOrdinal)).toEqual([1])
    controller.onActivity()
    await timer.fire()
    controller.stop()
    await timer.fire()
    expect(launched).toHaveLength(1)
    expect(controller.status()).toEqual({ kind: "stopped" })
  })

  test("rail 11 — raw activity between arm and fire changes the epoch: the fire is dropped, the draft untouched", async () => {
    const { controller, timer, launched, events } = makeController(authorityWithGoal())
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    const before = controller.activityEpoch()
    controller.onActivity()
    expect(controller.activityEpoch()).toBe(before + 1)
    await timer.fire() // the pending timer was cleared by onActivity; a stale callback must not launch
    expect(launched).toHaveLength(0)
    // an attempt armed at epoch N whose timer fires after raw input at epoch N+1 is dropped typed
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    const armed = events.filter((e) => e.kind === "armed").at(-1)
    expect(armed).toBeDefined()
    timer.clear = () => {} // simulate a timer implementation that cannot cancel in flight
    controller.onActivity()
    await timer.fire()
    expect(launched).toHaveLength(0)
    expect(events.some((e) => e.kind === "skipped" && e.reason === "activity-epoch-changed")).toBe(
      true,
    )
  })

  test("rail 6/14 — fire-time quiescence is re-checked with the typed busy reason", async () => {
    let quiescence: GoalQuiescence = QUIET
    const { controller, timer, launched, events } = makeController(authorityWithGoal(), {
      quiescence: () => quiescence,
    })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    quiescence = { quiescent: false, reason: "approval-pending" }
    await timer.fire()
    expect(launched).toHaveLength(0)
    expect(events.at(-1)).toEqual({
      kind: "skipped",
      reason: "no-longer-quiescent",
      busyReason: "approval-pending",
      attemptKey: expect.any(String),
    })
    // a busy surface at ARM time never schedules a timer either
    const scheduledBefore = timer.scheduled()
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.scheduled()).toBe(scheduledBefore)
    expect(controller.status()).toEqual({
      kind: "idle",
      skipReason: "no-longer-quiescent",
      busyReason: "approval-pending",
    })
  })

  test("rail 1 — the ladder is derived from receipts: 15s, 30s, 60s under no progress; progress resets", async () => {
    const authority = authorityWithGoal()
    const { controller, timer } = makeController(authority)
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    settleUsage(authority, TID, { turns: 1 }) // no criterion transition ⇒ no progress
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    settleUsage(authority, TID, { turns: 1 })
    controller.reset({ threadId: TID, checkpointOrdinal: 2 })
    expect(timer.delays()).toEqual([15_000, 30_000, 60_000])
    expect(controller.status()).toMatchObject({ kind: "armed", delayMs: 60_000, reason: "backoff" })
    // progress (a criterion transition) resets to the base quiet
    const cid = authority.get(TID)?.successCriteria[0]?.id ?? ""
    authority.markCriterion(TID, cid, true)
    authority.replace(TID, { goal: "ship", successCriteria: ["c2"] }) // fresh generation: no receipts
    controller.reset({ threadId: TID, checkpointOrdinal: 3 })
    expect(timer.delays().at(-1)).toBe(15_000)
  })

  test("rail 2 — a failure outcome stays in cooldown at the same revision; a user revision change resets", async () => {
    const authority = authorityWithGoal()
    const { controller, timer } = makeController(authority)
    settleUsage(authority, TID, { turns: 1 }, { outcome: "error" })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    expect(controller.status()).toMatchObject({
      kind: "armed",
      delayMs: 30_000,
      reason: "cooldown",
    })
    settleUsage(authority, TID, { turns: 1 }, { outcome: "error" })
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.delays().at(-1)).toBe(60_000)
    authority.replace(TID, { goal: "changed by the user", successCriteria: ["c"] })
    controller.reset({ threadId: TID, checkpointOrdinal: 2 })
    expect(timer.delays().at(-1)).toBe(15_000)
  })

  test("rail 7 — a base quiet below 15 s clamps and emits ONE typed clamp event", () => {
    const { controller, timer, events } = makeController(authorityWithGoal(), { baseQuietMs: 50 })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.delays()).toEqual([15_000, 15_000])
    expect(events.filter((e) => e.kind === "quiet-clamped")).toEqual([
      { kind: "quiet-clamped", requestedMs: 50, quietMs: 15_000 },
    ])
  })

  test("usage-limited ⇒ one timer at the persisted expiry (survives a restart through the snapshot)", () => {
    const authority = createObjectiveAuthority({ now: () => 1_000, enforceBudget: true })
    authority.create(TID, { goal: "ship", successCriteria: ["c"] })
    authority.markUsageLimited(TID, 61_000)
    const { controller, timer } = makeController(authority)
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    expect(timer.delays()).toEqual([60_000])
    expect(controller.status()).toMatchObject({
      kind: "armed",
      delayMs: 60_000,
      reason: "usage-limit",
    })
  })

  test("rail 16 — a missing validation contract arms nothing and reports the typed reason", () => {
    const bare = createObjectiveAuthority({ now: () => 1 })
    bare.create(TID, { goal: "no contract" })
    const { controller, timer } = makeController(bare)
    expect(controller.arm({ threadId: TID, checkpointOrdinal: 0 })).toBeUndefined()
    expect(timer.scheduled()).toBe(0)
    expect(controller.status()).toEqual({ kind: "idle", skipReason: "validation-contract-missing" })
  })

  test("rail 13 — the hard-cap PRECHECK refuses to arm once the product cap is consumed", () => {
    const authority = authorityWithGoal({ productCap: 1 })
    const { controller, timer } = makeController(authority, { productCap: 1 })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    expect(timer.scheduled()).toBe(1)
    // consume the single autonomous slot durably
    const caps = createObjectiveCapabilitiesFor(authority)
    caps.beginAutonomous("a1")
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.scheduled()).toBe(1)
    expect(controller.status()).toEqual({ kind: "idle", skipReason: "hard-cap-exhausted" })
  })

  test("a fail-stopped attempt slot blocks arming (typed) until recovered", () => {
    let blocked = true
    const { controller, timer } = makeController(authorityWithGoal(), {
      attemptSlotBlocked: () => blocked,
    })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    expect(timer.scheduled()).toBe(0)
    expect(controller.status()).toEqual({ kind: "idle", skipReason: "attempt-slot-blocked" })
    blocked = false
    controller.reset({ threadId: TID, checkpointOrdinal: 1 })
    expect(timer.scheduled()).toBe(1)
  })

  test("rail 17 — reconcile runs before the fire-time reread: a revision change re-arms from fresh state with no stale reservation", async () => {
    const authority = authorityWithGoal()
    const registry = createInMemoryGoalWakeAttemptRegistry()
    let reconciles = 0
    const { controller, timer, launched, events } = makeController(authority, {
      attempts: registry,
      reconcile: async () => {
        reconciles += 1
        authority.setNextActions(TID, [`reconciled-${reconciles}`]) // the objective moved
        return { kind: "invalidated", checkIds: ["k"] }
      },
    })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    await timer.fire()
    expect(reconciles).toBe(1)
    expect(launched).toHaveLength(0)
    expect(events.some((e) => e.kind === "skipped" && e.reason === "revision-changed")).toBe(true)
    expect(registry.size()).toBe(0) // no stale reservation
    expect(timer.scheduled()).toBe(2) // re-armed from the fresh state
  })

  test("rail 17 — reconcile unavailable ⇒ typed skip + cooldown re-arm (no hot loop)", async () => {
    const { controller, timer, launched, events } = makeController(authorityWithGoal(), {
      reconcile: async () => ({ kind: "source-unavailable", reason: "git down" }),
    })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    await timer.fire()
    expect(launched).toHaveLength(0)
    expect(events.at(-2)).toMatchObject({ kind: "skipped", reason: "reconcile-unavailable" })
    expect(events.at(-1)).toMatchObject({ kind: "armed", reason: "cooldown" })
    expect(timer.delays().at(-1)).toBeGreaterThanOrEqual(30_000)
  })

  test("rail 8/9 — the registry is bounded per thread+objective and forgets on clear/replace", async () => {
    const authority = authorityWithGoal()
    const registry = createInMemoryGoalWakeAttemptRegistry()
    const objectiveId = authority.get(TID)?.objectiveId ?? ""
    const revision = authority.readDomain(TID).revision
    for (let ordinal = 0; ordinal < 100_000; ordinal += 1) {
      const reservation = registry.tryClaim({
        threadId: TID,
        objectiveId,
        objectiveRevision: revision,
        checkpointOrdinal: ordinal,
        activityEpoch: 0,
        attemptKey: `k${ordinal}`,
      })
      reservation?.commit()
    }
    expect(registry.size()).toBe(1)
    // a committed ordinal can never be claimed again (replay)
    expect(
      registry.tryClaim({
        threadId: TID,
        objectiveId,
        objectiveRevision: revision,
        checkpointOrdinal: 5,
        activityEpoch: 0,
        attemptKey: "k5",
      }),
    ).toBeNull()
    registry.forget(TID)
    expect(registry.size()).toBe(0)
    // a shared registry allows exactly one enqueue per attempt across two controllers
    const a = makeController(authority, { attempts: registry })
    const b = makeController(authority, { attempts: registry })
    a.controller.arm({ threadId: TID, checkpointOrdinal: 4 })
    b.controller.arm({ threadId: TID, checkpointOrdinal: 4 })
    await a.timer.fire()
    await b.timer.fire()
    expect(a.launched.length + b.launched.length).toBe(1)
    // stop leaves no timer and no reservation
    a.controller.stop()
    b.controller.stop()
    expect(registry.size()).toBeLessThanOrEqual(1)
  })

  test("a rejected enqueue releases its reservation so an explicit later retry can proceed", async () => {
    let attempt = 0
    const { controller, timer, launched } = makeController(authorityWithGoal(), {
      enqueue: () => {
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error("queue unavailable"))
        return undefined
      },
    })
    controller.arm({ threadId: TID, checkpointOrdinal: 0 })
    await timer.fire()
    controller.reset({ threadId: TID, checkpointOrdinal: 0 })
    await timer.fire()
    expect(attempt).toBe(2)
    expect(launched).toHaveLength(0) // the fake enqueue above never pushes
  })
})

// Tiny helper: consume one autonomous slot through the system capability.
const createObjectiveCapabilitiesFor = (
  authority: ReturnType<typeof createObjectiveAuthority>,
) => ({
  beginAutonomous: (attemptId: string) => {
    const domain = authority.readDomain(TID)
    return authority.commit(
      authority.prepare({
        threadId: TID,
        actor: "system",
        mutation: {
          kind: "beginAttempt",
          attempt: {
            objectiveId: domain.state?.objective.objectiveId ?? "",
            attemptId,
            provenance: "autonomous-continuation",
            executionMode: "foreground",
            startedRevision: domain.revision,
          },
        },
      }),
      { admitted: true },
    )
  },
})
