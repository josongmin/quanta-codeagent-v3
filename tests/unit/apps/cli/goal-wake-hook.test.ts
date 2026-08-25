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
    store.set(TID, { goal: "ship" })
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
    store.set(TID, { goal: "ship" })
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
})
