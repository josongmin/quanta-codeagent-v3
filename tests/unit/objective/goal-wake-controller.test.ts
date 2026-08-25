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
      threadId: "thread-1",
      goal: "ship",
      successCriteria: [],
      status,
      budget: { tokensUsed: 0, turnsUsed: 0 },
      blockers: [],
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
      objectiveRevision: 3,
      checkpointOrdinal: 1,
      attemptKey: '["thread-1",3,1]',
    }
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(4),
        stillQuiescent: true,
      }),
    ).toEqual({ arm: false, skipReason: "revision-changed" })
    expect(
      evaluateGoalWakeFire({
        enabled: true,
        stopped: false,
        expected,
        current: domain(3),
        stillQuiescent: false,
      }),
    ).toEqual({ arm: false, skipReason: "no-longer-quiescent" })
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
    expect(launched).toEqual(['["thread-1",1,1]'])
    controller.onActivity()
    timer.fire()
    controller.stop()
    timer.fire()
    expect(launched).toEqual(['["thread-1",1,1]'])
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
})
