import { describe, expect, test } from "bun:test"
import type { ObjectiveDomainSnapshot } from "@/objective"
import {
  createGoalWakeController,
  createInMemoryGoalWakeAttemptRegistry,
  evaluateGoalWakeArm,
  evaluateGoalWakeFire,
  type GoalWakeTimer,
} from "@/objective"

const domain = (
  revision: number,
  status: "active" | "paused" = "active",
): ObjectiveDomainSnapshot => ({
  threadId: "thread-1",
  revision,
  state: {
    explicitStatus: status,
    objective: {
      objectiveId: "obj-1",
      threadId: "thread-1",
      goal: "ship",
      createdBy: "system",
      attempts: { autonomousTurnsStarted: 0 },
      successCriteria: [],
      status,
      budget: { tokensUsed: 0, turnsUsed: 0 },
      blockers: [],
      blockerObservations: [],
      nextActions: [],
      createdAt: 1,
      updatedAt: 1,
    },
  },
})

const fakeTimer = (): GoalWakeTimer & {
  fire(): void
  scheduled(): number
  cleared(): number
} => {
  let callback: (() => void) | undefined
  let scheduledCount = 0
  let clearedCount = 0
  return {
    set: (fn) => {
      callback = fn
      scheduledCount += 1
      return scheduledCount
    },
    clear: () => {
      clearedCount += 1
    },
    fire: () => callback?.(),
    scheduled: () => scheduledCount,
    cleared: () => clearedCount,
  }
}

describe("goal wake controller pure fences", () => {
  test("requires an active authority snapshot and a valid checkpoint", () => {
    expect(
      evaluateGoalWakeArm({
        enabled: true,
        stopped: false,
        threadId: "thread-1",
        checkpointOrdinal: 0,
        current: domain(3),
      }),
    ).toEqual({ arm: true })
    expect(
      evaluateGoalWakeArm({
        enabled: true,
        stopped: false,
        threadId: "thread-1",
        checkpointOrdinal: 0,
        current: domain(3, "paused"),
      }),
    ).toEqual({ arm: false, skipReason: "goal-not-active" })
    expect(
      evaluateGoalWakeArm({
        enabled: true,
        stopped: false,
        threadId: "",
        checkpointOrdinal: 0,
        current: domain(3),
      }),
    ).toEqual({ arm: false, skipReason: "invalid-thread" })
  })

  test("fire requires the exact armed revision and a fresh quiescence check", () => {
    const expected = {
      threadId: "thread-1",
      objectiveId: "objective:thread-1",
      objectiveRevision: 3,
      attachGeneration: 0,
      checkpointOrdinal: 1,
      activityEpoch: 0,
      attemptKey: '["thread-1","objective:thread-1",3,0,1]',
    }
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(4),
        activityEpoch: 0,
        stillQuiescent: true,
      }),
    ).toEqual({ arm: false, skipReason: "revision-changed" })
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(3),
        activityEpoch: 0,
        stillQuiescent: false,
      }),
    ).toEqual({ arm: false, skipReason: "no-longer-quiescent" })
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: { ...domain(3), attachGeneration: 1 },
        activityEpoch: 0,
        stillQuiescent: true,
      }),
    ).toEqual({ arm: false, skipReason: "revision-changed" })
  })
})

describe("goal wake controller lifecycle", () => {
  test("default OFF neither reads authority nor arms a timer", () => {
    const timer = fakeTimer()
    let reads = 0
    const controller = createGoalWakeController({
      enabled: false,
      quietWindowMs: 10,
      timer,
      readDomain: () => {
        reads += 1
        return domain(1)
      },
      stillQuiescent: () => true,
      enqueue: () => {},
    })
    expect(controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })).toBeUndefined()
    expect(reads).toBe(0)
    expect(timer.scheduled()).toBe(0)
  })

  test("reset replaces the only pending quiet timer; cancel and stop fence queued callbacks", () => {
    const timer = fakeTimer()
    const launched: string[] = []
    const controller = createGoalWakeController({
      enabled: true,
      quietWindowMs: 10,
      timer,
      readDomain: () => domain(1),
      stillQuiescent: () => true,
      enqueue: (attempt) => {
        launched.push(attempt.attemptKey)
      },
    })
    controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })
    controller.reset({ threadId: "thread-1", checkpointOrdinal: 1 })
    expect(timer.scheduled()).toBe(2)
    expect(timer.cleared()).toBe(1)
    timer.fire()
    expect(launched).toEqual(['["thread-1","obj-1",1,0,1]'])
    controller.onActivity()
    timer.fire()
    controller.stop()
    timer.fire()
    expect(launched).toEqual(['["thread-1","obj-1",1,0,1]'])
  })

  test("a revision change or new input state drops the wake before enqueue", () => {
    const timer = fakeTimer()
    const skips: string[] = []
    let current = domain(1)
    let quiescent = true
    let launches = 0
    const controller = createGoalWakeController({
      enabled: true,
      quietWindowMs: 10,
      timer,
      readDomain: () => current,
      stillQuiescent: () => quiescent,
      enqueue: () => {
        launches += 1
      },
      onSkip: (_, reason) => skips.push(reason),
    })
    controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })
    current = domain(2)
    timer.fire()
    expect(launches).toBe(0)
    expect(skips).toEqual(["revision-changed"])

    controller.reset({ threadId: "thread-1", checkpointOrdinal: 0 })
    quiescent = false
    timer.fire()
    expect(launches).toBe(0)
    expect(skips).toEqual(["revision-changed", "no-longer-quiescent"])
  })

  test("a shared claim registry allows exactly one enqueue for an attempt key", () => {
    const registry = createInMemoryGoalWakeAttemptRegistry()
    const firstTimer = fakeTimer()
    const secondTimer = fakeTimer()
    let launches = 0
    const deps = (timer: GoalWakeTimer) => ({
      enabled: true,
      quietWindowMs: 10,
      timer,
      readDomain: () => domain(7),
      stillQuiescent: () => true,
      attempts: registry,
      enqueue: () => {
        launches += 1
      },
    })
    const first = createGoalWakeController(deps(firstTimer))
    const second = createGoalWakeController(deps(secondTimer))
    first.arm({ threadId: "thread-1", checkpointOrdinal: 4 })
    second.arm({ threadId: "thread-1", checkpointOrdinal: 4 })
    firstTimer.fire()
    secondTimer.fire()
    expect(launches).toBe(1)
  })

  test("a rejected enqueue releases its reservation so an explicit later retry can proceed", async () => {
    const timer = fakeTimer()
    let attempt = 0
    let launches = 0
    const controller = createGoalWakeController({
      enabled: true,
      quietWindowMs: 10,
      timer,
      readDomain: () => domain(1),
      stillQuiescent: () => true,
      enqueue: () => {
        launches += 1
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error("queue unavailable"))
        return undefined
      },
    })
    controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })
    timer.fire()
    expect(launches).toBe(2)
  })

  test("claim storage stays O(active objective), including after 100k ordinals and replace", () => {
    const registry = createInMemoryGoalWakeAttemptRegistry()
    for (let ordinal = 0; ordinal < 100_000; ordinal += 1) {
      registry
        .tryClaim({
          threadId: "thread-1",
          objectiveId: "objective-1",
          objectiveRevision: 1,
          attachGeneration: 0,
          checkpointOrdinal: ordinal,
          activityEpoch: 0,
          attemptKey: `attempt-${ordinal}`,
        })
        ?.commit()
    }
    expect(registry.size()).toBe(1)
    registry
      .tryClaim({
        threadId: "thread-1",
        objectiveId: "objective-2",
        objectiveRevision: 2,
        attachGeneration: 1,
        checkpointOrdinal: 0,
        activityEpoch: 0,
        attemptKey: "replacement",
      })
      ?.commit()
    expect(registry.size()).toBe(1)
    registry.clearThread("thread-1")
    expect(registry.size()).toBe(0)
  })

  test("rail 11 — raw activity between arm and fire moves the epoch; a stale fire is dropped TYPED and the attempt carries the epoch", () => {
    const timer = fakeTimer()
    const skips: string[] = []
    const launched: number[] = []
    const controller = createGoalWakeController({
      enabled: true,
      quietWindowMs: 15_000,
      timer,
      readDomain: () => domain(1),
      stillQuiescent: () => true,
      enqueue: (attempt) => {
        launched.push(attempt.activityEpoch)
      },
      onSkip: (_, reason) => skips.push(reason),
    })
    expect(controller.activityEpoch()).toBe(0)
    const armed = controller.arm({ threadId: "thread-1", checkpointOrdinal: 0 })
    expect(armed?.activityEpoch).toBe(0)
    controller.onActivity()
    expect(controller.activityEpoch()).toBe(1)
    // a timer implementation that cannot cancel in flight still fires the stale callback
    timer.fire()
    expect(launched).toEqual([])
    expect(skips).toEqual(["activity-epoch-changed"])
    controller.reset({ threadId: "thread-1", checkpointOrdinal: 1 })
    timer.fire()
    expect(launched).toEqual([1])
  })

  test("rail 11 — the fire fence rejects an attempt whose epoch no longer matches", () => {
    const expected = {
      threadId: "thread-1",
      objectiveId: "obj-1",
      objectiveRevision: 1,
      attachGeneration: 0,
      checkpointOrdinal: 0,
      activityEpoch: 2,
      attemptKey: "k",
    }
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(1),
        activityEpoch: 3,
        stillQuiescent: true,
      }),
    ).toEqual({ arm: false, skipReason: "activity-epoch-changed" })
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(1),
        activityEpoch: 2,
        stillQuiescent: true,
      }),
    ).toEqual({ arm: true })
  })
})
