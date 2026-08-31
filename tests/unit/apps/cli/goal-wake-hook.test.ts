import { describe, expect, test } from "bun:test"
import {
  asObjectiveAuthority,
  createObjectiveAttemptSlot,
  createObjectiveCapabilities,
  createObjectiveStore,
  type GoalContinuationProbes,
  type ObjectiveDomainSnapshot,
  startGoalWakeController,
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
  test("does not arm until the full host projection is quiescent", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    let quiet = false
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      isQuiescent: () => quiet,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([])
    quiet = true
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000])
  })

  test("GOAL-06 — the product cap is NEVER written into the user budget; user 5 / cap 3 arms exactly 3", async () => {
    const store = createObjectiveStore()
    const authority = asObjectiveAuthority(store)
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      policy: { minQuietMs: 15_000, maxBackoffMs: 100_000, maxAutonomousTurns: 3, cooldownMs: 50 },
      probes: probes(store, async () => undefined),
      readDomain: (id) => authority.readDomain(id),
      system: createObjectiveCapabilities(authority).system,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(store.get(TID)?.budget.maxTurns).toBeUndefined()

    store.create("explicit", { goal: "ship", successCriteria: ["c"], budget: { maxTurns: 5 } })
    const caps = createObjectiveCapabilities(authority)
    const timer2 = fakeTimeout()
    const wake = startGoalWakeController({
      enabled: true,
      threadId: "explicit",
      quietWindowMs: 15_000,
      policy: { minQuietMs: 15_000, maxBackoffMs: 100_000, maxAutonomousTurns: 3, cooldownMs: 50 },
      probes: probes(store, async () => undefined),
      readDomain: (id) => authority.readDomain(id),
      system: caps.system,
      setTimeoutFn: timer2.set,
      clearTimeoutFn: timer2.clear,
    })
    expect(store.get("explicit")?.budget.maxTurns).toBe(5)
    // consume three autonomous slots durably ⇒ the fourth arm is refused by the product cap
    for (let i = 1; i <= 3; i += 1) {
      const domain = authority.readDomain("explicit")
      expect(
        caps.system.commit("explicit", {
          kind: "beginAttempt",
          attempt: {
            objectiveId: domain.state?.objective.objectiveId ?? "",
            attemptId: `a${i}`,
            provenance: "autonomous-continuation",
            executionMode: "foreground",
            startedRevision: domain.revision,
          },
        }).ok,
      ).toBe(true)
      caps.user.commit("explicit", { kind: "abandonAttempt" })
      wake?.onTurnSettled()
    }
    const armedBefore = timer2.delays().length
    wake?.onTurnSettled()
    expect(timer2.delays().length).toBe(armedBefore)
    expect(store.get("explicit")?.attempts.autonomousTurnsStarted).toBe(3)
  })

  test("rail 7 — a sub-clamp quiet window is clamped to 15 s and warns ONCE", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const warnings: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 50,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      onClampWarning: (message) => warnings.push(message),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000, 15_000])
    expect(warnings).toHaveLength(1)
  })

  test("same-revision infrastructure failure schedules only after cooldown", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    let now = 1_000
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      policy: { minQuietMs: 15_000, maxBackoffMs: 100_000, maxAutonomousTurns: 3, cooldownMs: 300 },
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      now: () => now,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onInfrastructureUnavailable(asObjectiveAuthority(store).readDomain(TID).revision, now)
    expect(timer.delays()).toEqual([15_000, 300])
    store.replace(TID, { goal: "ship after revision change", successCriteria: ["c"] })
    now += 1
    wake?.onGoalMutation()
    expect(timer.delays()).toEqual([15_000, 300, 15_000])
  })

  test("attach clears the old generation and arms the new thread once", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "old", successCriteria: ["c"] })
    store.create("attached", { goal: "new", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onAttach("attached")
    expect(timer.delays()).toEqual([15_000, 15_000])
  })

  test("an active authority objective wakes exactly once from the quiet-window edge", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const resumed: string[] = []
    startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([15_000])
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })

  test("activity cancels the pending wake; a later settled edge starts a new checkpoint", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
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

  test("a timer clear failure cannot fire through the stopped generation fence", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    let callback: (() => void) | undefined
    let resumed = 0
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => {
        resumed += 1
      }),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: (fn) => {
        callback = fn
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {
        throw new Error("timer backend unavailable")
      },
    })
    expect(callback).toBeDefined()
    wake?.stop()
    callback?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toBe(0)
    expect(wake?.status()).toEqual({ kind: "stopped" })
  })

  test("a handled local command restores pursuit after a fresh quiet window", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const resumed: string[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async (id) => {
        resumed.push(id)
      }),
      readDomain: (id): ObjectiveDomainSnapshot => asObjectiveAuthority(store).readDomain(id),
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onActivity()
    wake?.onLocalInputSettled()
    expect(timer.delays()).toEqual([15_000, 15_000])
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(resumed).toEqual([TID])
  })

  test("active-to-active revision drift between fire and queue hand-off is rejected then retryable", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const queued: string[] = []
    let mutateOnNextProbe = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
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
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const resumed: string[] = []
    let bodyLive = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
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

  test("rail 11 — the lifecycle exposes the activity epoch and the enqueued attempt carries it", async () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const epochs: number[] = []
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      resumeAttempt: async (_id, attempt) => {
        epochs.push(attempt.activityEpoch)
      },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(wake?.activityEpoch()).toBe(0)
    wake?.onActivity()
    wake?.onActivity()
    expect(wake?.activityEpoch()).toBe(2)
    wake?.onTurnSettled()
    timer.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(epochs).toEqual([2])
  })

  test("status(): the typed scheduling decision the /goal report renders (armed delay / idle skip reason / stopped)", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "bare" })
    const timer = fakeTimeout()
    let quiet = true
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      now: () => 1_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      isQuiescent: () => quiet,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "validation-contract-missing" })
    store.replace(TID, { goal: "ship", successCriteria: ["c"] })
    wake?.onGoalMutation()
    expect(wake?.status()).toEqual({ kind: "armed", delayMs: 15_000, wakeAt: 16_000 })
    // raw input cancels the timer: the report says the next settled edge arms
    wake?.onActivity()
    expect(wake?.status()).toEqual({ kind: "pending", delayMs: 15_000, retryAt: 16_000 })
    quiet = false
    wake?.onGoalMutation()
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "not-quiescent" })
    quiet = true
    store.setExplicitStatus(TID, "paused")
    wake?.onGoalMutation()
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "not-active" })
    wake?.stop()
    expect(wake?.status()).toEqual({ kind: "stopped" })
  })

  test("GOAL-08 round 3 — a FAIL-STOPPED attempt slot is a binding skip with the reason on the status line; recover re-arms", () => {
    const store = createObjectiveStore()
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const slot = createObjectiveAttemptSlot()
    slot.failStop("objective attempt start not durable: disk full")
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
      isQuiescent: () => true,
      attemptSlot: slot,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    wake?.onTurnSettled()
    wake?.onGoalMutation()
    expect(timer.delays()).toEqual([])
    expect(wake?.status()).toEqual({
      kind: "idle",
      skipReason: "attempt-slot-fail-stopped",
      detail: "objective attempt start not durable: disk full",
    })
    slot.recover()
    wake?.onTurnSettled()
    expect(timer.delays()).toEqual([15_000])
    expect(wake?.status()).toMatchObject({ kind: "armed", delayMs: 15_000 })
  })

  test("GOAL-08 round 4 — a NEW objective generation lifts the fail-stop (same generation keeps it); a timer armed before the fail-stop never fires through", async () => {
    const store = createObjectiveStore()
    const authority = asObjectiveAuthority(store)
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const oldId = authority.get(TID)?.objectiveId ?? ""
    const timer = fakeTimeout()
    const slot = createObjectiveAttemptSlot()
    let resumed = 0
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => authority.readDomain(id),
      isQuiescent: () => true,
      attemptSlot: slot,
      resumeAttempt: async () => {
        resumed += 1
      },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([15_000]) // healthy: the initial checkpoint armed
    // fail-stop lands while the timer is pending (attributed to the OLD generation)
    slot.failStop("objective settlement not durable: disk full", oldId)
    expect(wake?.status()).toEqual({
      kind: "idle",
      skipReason: "attempt-slot-fail-stopped",
      detail: "objective settlement not durable: disk full",
    })
    timer.fire()
    await new Promise((r) => setTimeout(r, 0))
    expect(resumed).toBe(0) // fire-time gate: no launch into a claim refusal
    // same generation edge ⇒ still fail-stopped
    wake?.onGoalMutation()
    expect(slot.status().kind).toBe("fail-stopped")
    // a NEW generation (clear + create) lifts it on the next edge and arms
    authority.clear(TID)
    wake?.onGoalMutation()
    store.create(TID, { goal: "ship v2", successCriteria: ["c"] })
    wake?.onGoalMutation()
    expect(slot.status().kind).toBe("empty")
    expect(timer.delays().at(-1)).toBe(15_000)
    expect(wake?.status()).toMatchObject({ kind: "armed", delayMs: 15_000 })
  })

  test("GOAL-04 rail 9 — a pause DURING an attributed turn still records the cost, and the settled turn does NOT re-arm", () => {
    const store = createObjectiveStore()
    const authority = asObjectiveAuthority(store)
    store.create(TID, { goal: "ship", successCriteria: ["c"] })
    const timer = fakeTimeout()
    const wake = startGoalWakeController({
      enabled: true,
      threadId: TID,
      quietWindowMs: 15_000,
      probes: probes(store, async () => undefined),
      readDomain: (id) => authority.readDomain(id),
      isQuiescent: () => true,
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    expect(timer.delays()).toEqual([15_000]) // active goal ⇒ armed
    const system = createObjectiveCapabilities(authority).system
    const domain = authority.readDomain(TID)
    const objectiveId = domain.state?.objective.objectiveId ?? ""
    expect(
      system.commit(TID, {
        kind: "beginAttempt",
        attempt: {
          objectiveId,
          attemptId: "a1",
          provenance: "autonomous-continuation",
          executionMode: "background",
          startedRevision: domain.revision,
        },
      }).ok,
    ).toBe(true)

    // The operator pauses WHILE the turn is in flight.
    store.setExplicitStatus(TID, "paused")

    // The in-flight attempt still settles and its measured cost lands.
    expect(
      system.commit(TID, {
        kind: "settleAttempt",
        settlement: {
          objectiveId,
          attemptId: "a1",
          startedRevision: domain.revision,
          tokensUsed: 123,
          turnsUsed: 0,
          outcome: "completed",
          executionMode: "background",
          criterionIdsBefore: [],
          verifierReceiptIdsBefore: [],
          recordedAt: 2,
        },
      }).ok,
    ).toBe(true)
    expect(authority.get(TID)?.budget.tokensUsed).toBe(123)
    expect(authority.get(TID)?.budget.turnsUsed).toBe(1)
    expect(authority.readDomain(TID).progressReceipts).toHaveLength(1)

    // ...and the settled turn must NOT re-arm while the goal is paused.
    const armsBefore = timer.delays().length
    wake?.onTurnSettled()
    wake?.onGoalMutation()
    expect(timer.delays().length).toBe(armsBefore)
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "not-active" })

    // Resuming re-arms — the suppression is the pause, not a dead controller.
    // The delay is 30 s, not 15 s: the settled attempt produced a receipt with
    // NO criterion transition, so the no-progress ladder (GOAL-06) doubled the
    // window. Both facts are pinned here on purpose.
    store.setExplicitStatus(TID, "active")
    wake?.onGoalMutation()
    expect(timer.delays().length).toBe(armsBefore + 1)
    expect(wake?.status()).toMatchObject({ kind: "armed", delayMs: 30_000 })
  })
})
