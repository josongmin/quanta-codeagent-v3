/**
 * GOAL-06 — the CLI host binding of the event-driven wake controller.
 * (Rewritten from the interval-ticker hellgates: the invariants — one owned
 * timer, disposal on stop, a rejecting resume never leaks — are preserved
 * against the controller's timer instead of a setInterval.)
 */

import { describe, expect, test } from "bun:test"
import {
  type GoalContinuationProbes,
  startGoalWakeController,
} from "@/apps/cli/goal-continuation-hook"
import {
  asObjectiveAuthority,
  createObjectiveStore,
  GOAL_WAKE_MIN_QUIET_MS,
  type GoalWakeDecisionEvent,
  type ObjectiveDomainSnapshot,
} from "@/objective"

const TID = "goal-wake-hook-thread"

const fakeTimeout = (): {
  readonly set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clear: (handle: ReturnType<typeof setTimeout>) => void
  readonly fire: () => Promise<void>
  readonly delays: () => readonly number[]
  readonly cleared: () => number
  readonly unrefs: () => number
} => {
  let callback: (() => void) | undefined
  const delays: number[] = []
  let cleared = 0
  let unrefs = 0
  return {
    set: (fn, ms) => {
      callback = fn
      delays.push(ms)
      return {
        unref: () => {
          unrefs += 1
        },
      } as unknown as ReturnType<typeof setTimeout>
    },
    clear: () => {
      cleared += 1
    },
    fire: async () => {
      callback?.()
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    },
    delays: () => delays,
    cleared: () => cleared,
    unrefs: () => unrefs,
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

/** A store whose goal carries a stopping contract (wake-eligible). */
const activeStore = () => {
  const store = createObjectiveStore()
  store.create(TID, { goal: "ship", successCriteria: ["c"] })
  return store
}

const readDomainOf =
  (store: ReturnType<typeof createObjectiveStore>) =>
  (id: string): ObjectiveDomainSnapshot =>
    asObjectiveAuthority(store).readDomain(id)

describe("goal wake host binding", () => {
  test("DEFAULT-OFF / ephemeral: enabled:false or no threadId arms NO timer and returns undefined", () => {
    const store = activeStore()
    const timer = fakeTimeout()
    expect(
      startGoalWakeController({
        enabled: false,
        threadId: TID,
        quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
        probes: probes(store, async () => {}),
        readDomain: readDomainOf(store),
        setTimeoutFn: timer.set,
        clearTimeoutFn: timer.clear,
      }),
    ).toBeUndefined()
    expect(
      startGoalWakeController({
        enabled: true,
        threadId: undefined,
        quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
        probes: probes(store, async () => {}),
        readDomain: readDomainOf(store),
        setTimeoutFn: timer.set,
        clearTimeoutFn: timer.clear,
      }),
    ).toBeUndefined()
    expect(timer.delays()).toEqual([])
  })

  test("an active authority objective wakes exactly once from the quiet-window edge (unref'd timer)", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([15_000])
    expect(timer.unrefs()).toBe(1)
    expect(wake?.status()).toMatchObject({ kind: "armed", delayMs: 15_000, reason: "quiet" })
    await timer.fire()
    expect(resumed).toEqual([TID])
    expect(wake?.status()).toEqual({ kind: "idle" })
  })

  test("rail 7 — a sub-clamp quiet window is clamped to 15 s (one typed clamp event)", () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const events: GoalWakeDecisionEvent[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 50,
      probes: probes(store, async () => {}),
      readDomain: readDomainOf(store),
      onDecision: (e) => events.push(e),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000, 15_000])
    expect(events.filter((e) => e.kind === "quiet-clamped")).toHaveLength(1)
  })

  test("activity cancels the pending wake (epoch moves); a later settled edge starts a new checkpoint", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    const epoch = wake?.activityEpoch() ?? -1
    wake?.onActivity()
    expect(wake?.activityEpoch()).toBe(epoch + 1)
    expect(timer.cleared()).toBe(1)
    await timer.fire()
    expect(resumed).toEqual([])
    wake?.onTurnSettled()
    await timer.fire()
    expect(resumed).toEqual([TID])
  })

  test("a handled local command restores pursuit after a fresh quiet window", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onActivity()
    wake?.onLocalInputSettled()
    expect(timer.delays()).toEqual([15_000, 15_000])
    await timer.fire()
    expect(resumed).toEqual([TID])
  })

  test("active-to-active revision drift between fire and queue hand-off is rejected then retryable (no leaked claim)", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const queued: string[] = []
    let mutateOnNextProbe = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: {
        ...probes(store, async () => undefined),
        threadIdle: () => {
          if (mutateOnNextProbe) {
            mutateOnNextProbe = false
            store.setNextActions(TID, ["moved"])
          }
          return true
        },
      },
      readDomain: readDomainOf(store),
      resumeAttempt: async (_id, attempt) => {
        queued.push(attempt.attemptKey)
      },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    await timer.fire()
    expect(queued).toEqual([])
    wake?.onTurnSettled()
    await timer.fire()
    expect(queued).toHaveLength(1)
  })

  test("rail 6 — a detached live body / approval / plan mode / draft block the wake with the typed reason", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    let bodyLive = true
    let approval = false
    let draft = false
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      quiescence: {
        backgroundTurnActive: () => bodyLive,
        approvalPending: () => approval,
        draftPending: () => draft,
      },
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    // busy at ARM time ⇒ nothing scheduled, typed reason visible
    expect(timer.delays()).toEqual([])
    expect(wake?.status()).toEqual({
      kind: "idle",
      skipReason: "no-longer-quiescent",
      busyReason: "background-turn",
    })
    bodyLive = false
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000])
    approval = true
    await timer.fire()
    expect(resumed).toEqual([])
    expect(wake?.status()).toMatchObject({ kind: "idle", busyReason: "approval-pending" })
    approval = false
    draft = true
    wake?.onTurnSettled()
    expect(wake?.status()).toMatchObject({ kind: "idle", busyReason: "draft-pending" })
    draft = false
    wake?.onTurnSettled()
    await timer.fire()
    expect(resumed).toEqual([TID])
  })

  test("a fail-stopped attempt slot blocks the wake until recovered", () => {
    const store = activeStore()
    const timer = fakeTimeout()
    let blocked = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async () => {}),
      attemptSlotBlocked: () => blocked,
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([])
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "attempt-slot-blocked" })
    blocked = false
    wake?.onGoalMutation()
    expect(timer.delays()).toEqual([15_000])
  })

  test("reconcile is awaited before the fire-time reread; unavailable ⇒ cooldown, never a hot loop", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    let reconciles = 0
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      verifier: {
        reconcile: async () => {
          reconciles += 1
          return { kind: "source-unavailable", reason: "git down" }
        },
      },
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    await timer.fire()
    expect(reconciles).toBe(1)
    expect(resumed).toEqual([])
    expect(wake?.status()).toMatchObject({ kind: "armed", reason: "cooldown" })
    expect(timer.delays().at(-1)).toBeGreaterThanOrEqual(30_000)
  })

  test("rail 10 — a THROWING resume never leaks: the next settled edge wakes again", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    let calls = 0
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async () => {
        calls += 1
        if (calls === 1) throw new Error("queue unavailable")
      }),
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    await timer.fire()
    expect(calls).toBe(1)
    wake?.onTurnSettled()
    await timer.fire()
    expect(calls).toBe(2)
  })

  test("rail 9 — stop() clears the owned timer, is idempotent, and a captured callback does nothing after it", async () => {
    const store = activeStore()
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: readDomainOf(store),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.cleared()).toBe(0)
    wake?.stop()
    expect(timer.cleared()).toBe(1)
    wake?.stop()
    expect(timer.cleared()).toBe(1)
    await timer.fire()
    expect(resumed).toEqual([])
    expect(wake?.status()).toEqual({ kind: "stopped" })
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000]) // nothing re-armed after stop
  })
})
