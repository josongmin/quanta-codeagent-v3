import { describe, expect, test } from "bun:test"
import {
  type GoalContinuationProbes,
  startGoalWakeController,
} from "@/apps/cli/goal-continuation-hook"
import {
  asObjectiveAuthority,
  createObjectiveStore,
  type ObjectiveDomainSnapshot,
} from "@/objective"

const TID = "goal-wake-hook-thread"

const fakeTimeout = (): {
  readonly set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clear: (handle: ReturnType<typeof setTimeout>) => void
  readonly fire: () => void
  readonly delays: () => readonly number[]
} => {
  let callback: (() => void) | undefined
  const delays: number[] = []
  return {
    set: (fn, ms) => {
      callback = fn
      delays.push(ms)
      return {} as ReturnType<typeof setTimeout>
    },
    clear: () => {},
    fire: () => callback?.(),
    delays: () => delays,
  }
}

const probes = (
  store: ReturnType<typeof createObjectiveStore>,
  resume: (threadId: string) => Promise<void>,
): GoalContinuationProbes => ({
  objective: store,
  threadIdle: () => true,
  planModeActive: () => false,
  turnActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
  resume,
})

describe("goal wake host binding", () => {
  test("an active authority objective wakes exactly once from the quiet-window edge", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship" })
    const timer = fakeTimeout()
    const resumed: string[] = []
    startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 42,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([42])
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })

  test("activity cancels the pending wake; a later settled edge starts a new checkpoint", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship" })
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 10,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onActivity()
    timer.fire()
    await Promise.resolve()
    expect(resumed).toEqual([])

    wake?.onTurnSettled()
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })

  test("a handled local command restores pursuit after a fresh quiet window", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship" })
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 10,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onActivity()
    wake?.onLocalInputSettled()
    expect(timer.delays()).toEqual([10, 10])
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })

  test("active-to-active revision drift between fire and queue hand-off is rejected then retryable", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship" })
    const timer = fakeTimeout()
    const queued: string[] = []
    let mutateOnNextProbe = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 10,
      probes: {
        ...probes(store, async () => undefined),
        threadIdle: () => {
          if (mutateOnNextProbe) {
            mutateOnNextProbe = false
            // Same active status but a NEW authority revision: this is exactly
            // the old-prompt race the queue hand-off fence must reject.
            store.setExplicitStatus(TID, "active")
          }
          return true
        },
      },
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      resumeAttempt: async (_id, attempt) => {
        queued.push(attempt.attemptKey)
      },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(queued).toEqual([])

    wake?.onTurnSettled()
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(queued).toHaveLength(1)
  })

  test("a detached live body blocks wake until its actual settlement edge", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship" })
    const timer = fakeTimeout()
    const resumed: string[] = []
    let bodyLive = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 10,
      probes: {
        ...probes(store, async (id) => {
          resumed.push(id)
        }),
        // Ctrl+B transfers the wrapper, not this body. The shared active-turn
        // holder remains true until the body's settlement callback runs.
        turnActive: () => bodyLive,
      },
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    timer.fire()
    await Promise.resolve()
    expect(resumed).toEqual([])

    bodyLive = false
    wake?.onTurnSettled()
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })
})
