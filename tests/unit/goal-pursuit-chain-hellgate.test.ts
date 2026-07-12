/**
 * End-to-end CHAIN hellgate for the "Pursuing goal" (Codex `/goal` parity)
 * feature — proves the built pieces compose into the real user journey:
 *
 *   user types `/goal <objective>`  (goalCmd, real command)
 *     → the objective is recorded `active` in the shared store  (real store)
 *     → the idle ticker picks it up on the next idle tick        (real ticker
 *       + real `runIdleContinuation`)
 *     → `resume` enqueues a turn carrying the goal text          (observed sink)
 *     → `/goal clear` pauses it → the ticker stops pursuing.
 *
 * Everything except the host boundary (the enqueue sink + the idle/turn probes)
 * is the REAL production object. This is the strongest verification available
 * without booting the live CLI + a real LLM; the surface plumbing that mints and
 * shares the store (surface-compose/session-loop) is the only remaining wire.
 *
 * Red-on-injection: cutting the command→store write, the ticker's enabled gate,
 * or the store→resume read all turn one of these assertions red.
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveStore, type ObjectivePort } from "@/agent/objective"
import {
  type GoalContinuationProbes,
  startGoalContinuationTicker,
} from "@/apps/cli/goal-continuation-hook"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"

const TID = "thread-e2e"

/** A minimal SlashContext carrying only what `/goal` reads: out + the shared
 *  objective slot. Mirrors what the surface will inject via dispatch. */
const ctxWith = (
  port: ObjectivePort,
  out: (s: string) => void,
): SlashContext => ({
  out,
  err: () => {},
  cwd: "/tmp",
  goal: { port, threadId: TID },
})

/** Idle probes that all pass, plus a `resume` that captures the enqueued turn's
 *  text by reading the goal back out of the store (exactly what the real
 *  session-loop `resume` does: `enqueueWithHeartbeat(objective.get(tid).goal)`). */
const drivenBy = (
  port: ObjectivePort,
  enqueued: string[],
): GoalContinuationProbes => ({
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
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn: (h: ReturnType<typeof setInterval>) => void
  tick: () => Promise<void>
} => {
  let captured: (() => void) | null = null
  return {
    setIntervalFn: (fn) => {
      captured = fn
      return 0 as unknown as ReturnType<typeof setInterval>
    },
    clearIntervalFn: () => {},
    tick: async () => {
      captured?.()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("Pursuing-goal chain — /goal → store → ticker → resume", () => {
  test("full journey: set a goal, the agent keeps pursuing it while idle", async () => {
    const store = createObjectiveStore()
    const out: string[] = []
    const enqueued: string[] = []
    const timer = fakeTimer()

    // 1. user: /goal ship the whole feature
    const code = await goalCmd.run(["ship", "the", "whole", "feature"], ctxWith(store, (s) => out.push(s)))
    expect(code).toBe(0)

    // 2. the objective is recorded active in the shared store
    const obj = store.get(TID)
    expect(obj?.goal).toBe("ship the whole feature")
    expect(obj?.status).toBe("active")
    expect(out.join("")).toContain("Pursuing goal set")

    // 3. arm the ticker on the SAME store and go idle
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: drivenBy(store, enqueued),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })

    // 4. two idle ticks → the agent resumes work on the goal each time,
    //    the enqueued turn carrying the goal text (the pursuit).
    await timer.tick()
    await timer.tick()
    expect(enqueued).toEqual(["ship the whole feature", "ship the whole feature"])
  })

  test("/goal clear stops the pursuit — ticker no longer resumes", async () => {
    const store = createObjectiveStore()
    const enqueued: string[] = []
    const timer = fakeTimer()

    await goalCmd.run(["do", "the", "thing"], ctxWith(store, () => {}))
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: drivenBy(store, enqueued),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.tick()
    expect(enqueued.length).toBe(1) // pursued once

    // user pauses the pursuit
    const out: string[] = []
    await goalCmd.run(["clear"], ctxWith(store, (s) => out.push(s)))
    expect(out.join("")).toContain("paused")
    expect(store.get(TID)?.status).toBe("paused")

    await timer.tick()
    await timer.tick()
    expect(enqueued.length).toBe(1) // no further pursuit after clear
  })

  test("/goal with no arg reports the active objective", async () => {
    const store = createObjectiveStore()
    await goalCmd.run(["measure", "twice"], ctxWith(store, () => {}))
    const out: string[] = []
    await goalCmd.run([], ctxWith(store, (s) => out.push(s)))
    const text = out.join("")
    expect(text).toContain("Pursuing goal: measure twice")
    expect(text).toContain("active")
  })

  test("unwired surface (no goal slot) degrades gracefully — byte-identical", async () => {
    const out: string[] = []
    const bareCtx: SlashContext = { out: (s) => out.push(s), err: () => {}, cwd: "/tmp" }
    const code = await goalCmd.run(["anything"], bareCtx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })
})
