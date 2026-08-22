/**
 * Hellgate for the goal-continuation ticker (`src/apps/cli/goal-continuation-hook.ts`)
 * — the LIVE host binding that activates the H17 continuation machine.
 *
 * These tests drive the REAL `runIdleContinuation` through the ticker with a
 * REAL `createObjectiveStore`, observing the real `resume` side effect. They are
 * red-on-injection: the DEFAULT-OFF case fails if the `enabled` gate is removed,
 * and the pursue case fails if the tick→runIdleContinuation→resume wire is cut.
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveStore, type ObjectivePort } from "@/objective"
import {
  type GoalContinuationProbes,
  startGoalContinuationTicker,
} from "@/apps/cli/goal-continuation-hook"

const TID = "thread-1"

/** All probes pass (idle, nothing pending, non-ephemeral) so the only thing
 *  gating a launch is the goal status + the `enabled` flag. */
const passingProbes = (
  objective: Pick<ObjectivePort, "get">,
  resume: (t: string) => Promise<void>,
): GoalContinuationProbes => ({
  objective,
  resume,
  threadIdle: () => true,
  planModeActive: () => false,
  turnActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
})

/** A hand-driven fake timer: capture the tick fn so the test fires it. */
const fakeTimer = (): {
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn: (h: ReturnType<typeof setInterval>) => void
  fire: () => Promise<void>
  cleared: () => boolean
} => {
  let captured: (() => void) | null = null
  let wasCleared = false
  return {
    setIntervalFn: (fn) => {
      captured = fn
      return 0 as unknown as ReturnType<typeof setInterval>
    },
    clearIntervalFn: () => {
      wasCleared = true
    },
    fire: async () => {
      captured?.()
      // let the fire-and-forget `void runIdleContinuation(...)` settle
      await Promise.resolve()
      await Promise.resolve()
    },
    cleared: () => wasCleared,
  }
}

describe("goal-continuation ticker — DEFAULT-OFF byte-identical", () => {
  test("enabled:false arms no timer and never resumes", async () => {
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship the feature" })
    store.updateStatus(TID, "active")
    let resumes = 0
    const timer = fakeTimer()

    const ticker = startGoalContinuationTicker({
      enabled: false,
      threadId: TID,
      probes: passingProbes(store, async () => {
        resumes += 1
      }),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })

    expect(ticker).toBeUndefined()
    await timer.fire() // no captured fn — nothing happens
    expect(resumes).toBe(0)
  })

  test("undefined threadId (ephemeral) arms no timer", () => {
    const store = createObjectiveStore()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: undefined,
      probes: passingProbes(store, async () => {}),
    })
    expect(ticker).toBeUndefined()
  })
})

describe("goal-continuation ticker — pursues an active goal", () => {
  test("a tick with an active goal + idle thread resumes it", async () => {
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship the feature" })
    store.updateStatus(TID, "active")

    const resumed: string[] = []
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async (t) => {
        resumed.push(t)
      }),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })

    expect(ticker).toBeDefined()
    await timer.fire()
    expect(resumed).toEqual([TID]) // the pursue wire fired
  })

  test("no goal set ⇒ tick does not resume", async () => {
    const store = createObjectiveStore() // empty
    let resumes = 0
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {
        resumes += 1
      }),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.fire()
    expect(resumes).toBe(0)
  })

  test("goal not active (paused) ⇒ tick does not resume", async () => {
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship" })
    store.updateStatus(TID, "paused")
    let resumes = 0
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {
        resumes += 1
      }),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.fire()
    expect(resumes).toBe(0)
  })

  test("non-idle thread ⇒ tick does not resume (user is working)", async () => {
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship" })
    store.updateStatus(TID, "active")
    let resumes = 0
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: {
        ...passingProbes(store, async () => {
          resumes += 1
        }),
        threadIdle: () => false, // busy
      },
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.fire()
    expect(resumes).toBe(0)
  })

  test("stop() is idempotent and clears the timer", () => {
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship" })
    store.updateStatus(TID, "active")
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    ticker?.stop()
    ticker?.stop() // idempotent
    expect(timer.cleared()).toBe(true)
  })
})
