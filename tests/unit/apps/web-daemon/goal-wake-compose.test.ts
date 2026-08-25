import { describe, expect, test } from "bun:test"
import { composeWebGoalWake } from "@/apps/web-daemon/goal-wake-compose"
import { asObjectiveAuthority, createObjectiveStore } from "@/objective"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { capabilitiesFor } from "../../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", transport: "websocket" })

const snapshot = (): SessionSnapshotLite => ({
  sessionId: "web-goal",
  revision: 0,
  seq: 0,
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
  capabilities: manifest,
  pendingApproval: null,
  openArtifacts: [],
})

const fakeTimer = () => {
  let callback: (() => void) | undefined
  let clears = 0
  return {
    set: (fn: () => void): ReturnType<typeof setTimeout> => {
      callback = fn
      return {} as ReturnType<typeof setTimeout>
    },
    clear: (): void => {
      clears += 1
      callback = undefined
    },
    fire: (): void => callback?.(),
    clearCount: (): number => clears,
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

const fakeSession = (submit: NonNullable<RuntimeSession["turn"]["submitGoalContinuation"]>) => {
  const listeners = new Set<(event: SessionEvent) => void>()
  let unsubscribed = 0
  const session = {
    sessionId: "web-goal",
    snapshot: async () => snapshot(),
    subscribe: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribed += 1
      }
    },
    turn: { submitGoalContinuation: submit },
  } as unknown as RuntimeSession
  return { session, unsubscribed: () => unsubscribed }
}

describe("web goal wake composition", () => {
  test("default OFF installs no controller or subscription", async () => {
    const store = createObjectiveStore()
    store.create("web-goal", { goal: "ship" })
    const fake = fakeSession(async () => ({ revision: 0, seq: 0, events: [] }))
    expect(
      await composeWebGoalWake({
        session: fake.session,
        runtime: { objectiveAuthority: store },
        env: {},
      }),
    ).toBeUndefined()
    expect(fake.unsubscribed()).toBe(0)
  })

  test("an active goal submits exactly one host-authorized atomic turn", async () => {
    const store = createObjectiveStore()
    store.create("web-goal", { goal: "ship", successCriteria: ["tests pass"] })
    const timer = fakeTimer()
    const submissions: Parameters<
      NonNullable<RuntimeSession["turn"]["submitGoalContinuation"]>
    >[0][] = []
    const fake = fakeSession(async (input) => {
      expect(input.validateCurrent()).toBe(true)
      submissions.push(input)
      return { revision: 1, seq: 2, events: [] }
    })
    const handle = await composeWebGoalWake({
      session: fake.session,
      runtime: { objectiveAuthority: store },
      env: { QUANTA_GOAL_ENFORCE: "1" },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    timer.fire()
    await flush()
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.expectedSessionRevision).toBe(0)
    expect(submissions[0]?.objectiveId).toBe(store.get("web-goal")?.objectiveId)
    expect(submissions[0]?.text).toContain("ship")
    expect(submissions[0]?.text).toContain("Remaining criterion IDs:")
    handle?.stop()
    expect(fake.unsubscribed()).toBe(1)
  })

  test("authority revision drift invalidates the issued capability", async () => {
    const store = createObjectiveStore()
    store.create("web-goal", { goal: "old" })
    const timer = fakeTimer()
    let admitted = true
    const fake = fakeSession(async (input) => {
      store.replace("web-goal", { goal: "replacement" })
      admitted = input.validateCurrent()
      if (!admitted) throw new Error("stale")
      return { revision: 1, seq: 2, events: [] }
    })
    const handle = await composeWebGoalWake({
      session: fake.session,
      runtime: { objectiveAuthority: store },
      env: { QUANTA_GOAL_ENFORCE: "1" },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    timer.fire()
    await flush()
    expect(admitted).toBe(false)
    handle?.stop()
  })

  test("attach and stop cancel pending timers", async () => {
    const store = createObjectiveStore()
    const authority = asObjectiveAuthority(store)
    store.create("web-goal", { goal: "ship" })
    const timer = fakeTimer()
    const fake = fakeSession(async () => ({ revision: 1, seq: 2, events: [] }))
    const handle = await composeWebGoalWake({
      session: fake.session,
      runtime: { objectiveAuthority: authority },
      env: { QUANTA_GOAL_ENFORCE: "1" },
      setTimeoutFn: timer.set,
      clearTimeoutFn: timer.clear,
    })
    handle?.onAttachStart()
    handle?.onAttachSettled()
    handle?.stop()
    expect(timer.clearCount()).toBeGreaterThanOrEqual(2)
    expect(fake.unsubscribed()).toBe(1)
  })
})
