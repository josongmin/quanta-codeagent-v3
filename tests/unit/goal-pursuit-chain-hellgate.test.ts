/**
 * ★ HELLGATE — the pursuing-goal chain: `/goal` → authority → wake controller
 * → resume (GOAL-06: event-driven, no interval ticker).
 *
 * Everything except the host boundary (the enqueue sink + the idle/turn probes)
 * is REAL: the slash command, the goal control, the shared authority, the
 * wake controller and the continuation engine. Pinned journeys:
 *   - a bare goal has NO stopping contract ⇒ wake-ineligible (typed), no timer;
 *   - adding a criterion arms the quiet timer; the edge fires ONE continuation;
 *   - a settled turn re-arms; `/goal clear` stops pursuit; completion stops it.
 */

import { describe, expect, test } from "bun:test"
import { buildGoalControl } from "@/apps/cli/goal/goal-control"
import {
  type GoalContinuationProbes,
  startGoalWakeController,
} from "@/apps/cli/goal-continuation-hook"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"
import {
  asObjectiveAuthority,
  createObjectiveStore,
  GOAL_WAKE_MIN_QUIET_MS,
  type ObjectivePort,
} from "@/objective"

const TID = "thread-e2e"

/** A minimal SlashContext carrying only what `/goal` reads: out + the control. */
const ctxWith = (port: ObjectivePort, out: (s: string) => void): SlashContext => ({
  out,
  err: out,
  cwd: "/tmp",
  goal: { control: buildGoalControl({ port, threadId: TID }) },
})

/** Idle probes that all pass, plus a `resume` that captures the enqueued turn's
 *  text by reading the goal back out of the store. */
const drivenBy = (port: ObjectivePort, enqueued: string[]): GoalContinuationProbes => ({
  objective: port,
  resume: async (tid) => {
    const g = port.get(tid)?.goal
    if (g !== undefined) enqueued.push(g)
  },
  threadIdle: () => true,
  planModeActive: () => false,
  turnActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
})

const fakeTimer = (): {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (h: ReturnType<typeof setTimeout>) => void
  fire: () => Promise<void>
  delays: () => readonly number[]
} => {
  let captured: (() => void) | null = null
  const delays: number[] = []
  return {
    set: (fn, ms) => {
      captured = fn
      delays.push(ms)
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clear: () => {
      captured = null
    },
    fire: async () => {
      captured?.()
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    },
    delays: () => delays,
  }
}

const wakeOver = (store: ObjectivePort, enqueued: string[], timer: ReturnType<typeof fakeTimer>) =>
  startGoalWakeController({
    enabled: true,
    threadId: TID,
    quietWindowMs: GOAL_WAKE_MIN_QUIET_MS,
    probes: drivenBy(store, enqueued),
    readDomain: (id) => asObjectiveAuthority(store).readDomain(id),
    setTimeoutFn: timer.set,
    clearTimeoutFn: timer.clear,
  })

describe("Pursuing-goal chain — /goal → authority → wake controller → resume", () => {
  test("full journey: a bare goal is wake-ineligible; a criterion arms it; the edge pursues once; settle re-arms", async () => {
    const store = createObjectiveStore()
    const out: string[] = []
    const enqueued: string[] = []
    const timer = fakeTimer()

    const code = await goalCmd.run(
      ["ship", "the", "whole", "feature"],
      ctxWith(store, (s) => out.push(s)),
    )
    expect(code).toBe(0)
    expect(store.get(TID)?.goal).toBe("ship the whole feature")
    expect(out.join("")).toContain("Pursuing goal set")
    expect(out.join("")).toContain("contract: missing")

    const wake = wakeOver(store, enqueued, timer)
    // rail 16 — no stopping contract ⇒ typed skip, NO timer, no cap consumed
    expect(timer.delays()).toEqual([])
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "validation-contract-missing" })

    await goalCmd.run(
      ["criterion", "add", "tests", "green"],
      ctxWith(store, () => {}),
    )
    wake?.onGoalMutation()
    expect(timer.delays()).toEqual([15_000])
    expect(wake?.status()).toMatchObject({ kind: "armed", delayMs: 15_000, reason: "quiet" })

    await timer.fire()
    expect(enqueued).toEqual(["ship the whole feature"])
    // one edge ⇒ one continuation; a settled turn re-arms the next quiet window
    await timer.fire()
    expect(enqueued).toHaveLength(1)
    wake?.onTurnSettled()
    await timer.fire()
    expect(enqueued).toEqual(["ship the whole feature", "ship the whole feature"])
  })

  test("/goal clear stops the pursuit — the controller finds no goal and arms nothing", async () => {
    const store = createObjectiveStore()
    const enqueued: string[] = []
    const timer = fakeTimer()

    await goalCmd.run(
      ["do", "the", "thing"],
      ctxWith(store, () => {}),
    )
    await goalCmd.run(
      ["criterion", "add", "done"],
      ctxWith(store, () => {}),
    )
    const wake = wakeOver(store, enqueued, timer)
    await timer.fire()
    expect(enqueued).toHaveLength(1)

    const out: string[] = []
    await goalCmd.run(
      ["clear"],
      ctxWith(store, (s) => out.push(s)),
    )
    expect(out.join("")).toContain("cleared")
    expect(store.get(TID)).toBeNull()

    wake?.onGoalMutation()
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "no-goal" })
    await timer.fire()
    await timer.fire()
    expect(enqueued).toHaveLength(1) // no further pursuit after clear
  })

  test("the SHARED goal reaching `completed` stops the pursuit (Codex auto-stop)", async () => {
    const store = createObjectiveStore()
    const enqueued: string[] = []
    const timer = fakeTimer()
    await goalCmd.run(
      ["finish", "the", "migration"],
      ctxWith(store, () => {}),
    )
    await goalCmd.run(
      ["criterion", "add", "migrated"],
      ctxWith(store, () => {}),
    )
    const wake = wakeOver(store, enqueued, timer)
    await timer.fire()
    expect(enqueued).toHaveLength(1)

    const crit = store.get(TID)?.successCriteria[0]?.id ?? ""
    await goalCmd.run(
      ["criterion", "complete", crit],
      ctxWith(store, () => {}),
    )
    expect(store.get(TID)?.status).toBe("completed")
    wake?.onGoalMutation()
    expect(wake?.status()).toEqual({ kind: "idle", skipReason: "goal-not-active" })
    await timer.fire()
    await timer.fire()
    expect(enqueued).toHaveLength(1) // pursuit stopped once the goal completed
  })
})
