/**
 * T10 M7 — enqueue-failure must NOT roll the fire anchor back.
 *
 * The persist-before-dispatch order (runtime.ts step 4 → step 5) advances and
 * commits the fire anchor (fireCount + 1, lastFiredAt = now) BEFORE the prompt
 * is enqueued. If the enqueue then THROWS, the error transition must be recorded
 * on the ALREADY-ADVANCED record — not on the original automation. Recording on
 * the original would overwrite the persisted anchor back to the OLD fireCount
 * with NO lastFiredAt, and an operator resume (error → active) would re-arm a
 * DUPLICATE mutating dispatch of the same occurrence — the exact at-least-once
 * hazard M7 closes.
 *
 * Adversarial proof: enqueue throws → assert the LAST persisted (error) row
 * carries the advanced anchor (fireCount + 1, lastFiredAt = now) → then resume
 * the persisted error row to `active` and tick again at the SAME instant →
 * assert NO re-fire (the anchor already moved past `now`).
 *
 * RED against the unfixed code: the unfixed path persists
 * `markError(automation)` (original anchor), so the error row has fireCount = 0
 * and no lastFiredAt, and the resume re-fires — both assertions below fail.
 */

import { describe, expect, test } from "bun:test"
import { createAutomation, transitionStatus } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import type {
  AgentLoopPort,
  Automation,
  AutomationStorePort,
  ClockPort,
  EnvPort,
  ModelAvailabilityPort,
  RRule,
  SchedulerEvent,
  SchedulerSinkPort,
} from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d, 0, 0, 0)

const FIRED_AT = utc(2026, 5, 3)

const sample = (over?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "t",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "MUTATING: delete prod table",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: utc(2026, 5, 1),
  }),
  ...over,
})

describe("T10 M7 — enqueue failure keeps the fire anchor advanced", () => {
  test("[M7-anchor] enqueue throw persists the ADVANCED anchor, so resume does not re-fire", async () => {
    const saved: Automation[] = []
    const enqueued: string[] = []
    const events: SchedulerEvent[] = []

    // Store starts holding the original active automation; remembers every save
    // and serves the latest persisted state on reload.
    let current = sample()
    const store: AutomationStorePort = {
      load: async () => [current],
      save: async (_w, a) => {
        saved.push(a)
        current = a
      },
      delete: async () => {},
    }

    let enqueueCalls = 0
    const loop: AgentLoopPort = {
      enqueueUserMessage: async (m) => {
        enqueueCalls += 1
        enqueued.push(m)
        // First dispatch attempt FAILS after the anchor was already persisted.
        if (enqueueCalls === 1) throw new Error("loop saturated")
      },
    }

    const clock: ClockPort = { now: () => FIRED_AT }
    const env: EnvPort = { get: () => undefined }
    const availability: ModelAvailabilityPort = { isAvailable: async () => true }
    const sink: SchedulerSinkPort = { emit: (e) => events.push(e) }

    const rt = createSchedulerRuntime({
      store,
      availability,
      clock,
      env,
      agentLoop: loop,
      workspace: "/w",
      sink,
    })

    await rt.tickOnce()

    // The enqueue threw → an error must be surfaced, and exactly one dispatch
    // was attempted.
    expect(events.some((e) => e.type === "scheduler.error")).toBe(true)
    expect(enqueueCalls).toBe(1)

    // Two saves happened: step-4 anchor advance, then the error transition. The
    // LAST persisted row is the error row — it MUST carry the advanced anchor.
    expect(saved.length).toBe(2)
    const errorRow = saved[saved.length - 1]
    if (errorRow === undefined) throw new Error("expected a persisted error row")
    expect(errorRow.status).toBe("error")
    // The crux: the anchor SURVIVES the failed dispatch. fireCount advanced
    // (0 → 1) and lastFiredAt is the fire instant — NOT rolled back.
    expect(errorRow.fireCount).toBe(1)
    expect(errorRow.lastFiredAt).toBe(FIRED_AT)

    // Adversarial: operator resumes the error row to `active` and a tick runs
    // at the SAME instant. Because the anchor already moved past `now`, the
    // occurrence is NOT re-dispatched. (Unfixed: anchor=fireCount 0 / no
    // lastFiredAt ⇒ still due ⇒ DUPLICATE mutating dispatch.)
    current = transitionStatus(current, "active")
    await rt.tickOnce()

    // No second dispatch of the mutating prompt.
    expect(enqueueCalls).toBe(1)
    expect(enqueued).toEqual(["MUTATING: delete prod table"])
  })
})
