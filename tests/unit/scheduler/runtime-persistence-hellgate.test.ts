/**
 * T10 — Scheduler persistence honesty hellgate (L9 M9/M10/M7).
 *
 * JSONL/sqlite persistence failures are FIRST-CLASS runtime errors: they are
 * observable (sink) and can NEVER silently mark work complete or leave a
 * failing automation `active` to refire forever.
 *
 *   M9  — load() distinguishes ENOENT (empty) from a real read fault
 *         (EACCES/partial-IO): a fault is surfaced, not collapsed to `[]`.
 *         delete() tombstone append failure is surfaced, not swallowed.
 *   M10 — runtime error-state persistence failure emits an observable
 *         event; it does not swallow and leave the row `active`.
 *   M7  — the runtime persists the fire anchor BEFORE dispatch so a crash
 *         between dispatch and save cannot re-dispatch a mutating prompt.
 */

import { describe, expect, test } from "bun:test"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import { defaultJsonlAutomationStore } from "@/scheduler/store-jsonl"
import {
  type AgentLoopPort,
  type Automation,
  AutomationStoreError,
  type AutomationStorePort,
  type ClockPort,
  type EnvPort,
  type ModelAvailabilityPort,
  type RRule,
  type SchedulerEvent,
  type SchedulerSinkPort,
} from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d, 0, 0, 0)

const sample = (over?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "t",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "run me",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: utc(2026, 5, 1),
  }),
  ...over,
})

describe("T10 M9 — JSONL load/delete faults are first-class", () => {
  test("[M9-1] a non-ENOENT load fault is surfaced as AutomationStoreError, not []", async () => {
    // Inject a read that fails with EACCES.
    const store = defaultJsonlAutomationStore({
      baseDir: "/this/does/not/matter",
      reader: async () => {
        const e: NodeJS.ErrnoException = new Error("permission denied")
        e.code = "EACCES"
        throw e
      },
    })
    await expect(store.load("/w")).rejects.toBeInstanceOf(AutomationStoreError)
  })

  test("[M9-2] ENOENT still maps to empty list (no false fault)", async () => {
    const store = defaultJsonlAutomationStore({
      baseDir: "/x",
      reader: async () => {
        const e: NodeJS.ErrnoException = new Error("nope")
        e.code = "ENOENT"
        throw e
      },
    })
    expect(await store.load("/w")).toEqual([])
  })

  test("[M9-3] delete tombstone append failure is surfaced, not swallowed", async () => {
    let appendCalls = 0
    const store = defaultJsonlAutomationStore({
      baseDir: "/x",
      mkdirer: async () => {},
      reader: async () => `${JSON.stringify(sample())}\n`,
      appender: async () => {
        appendCalls += 1
        throw new Error("disk full")
      },
    })
    await expect(store.delete("/w", "a1")).rejects.toBeInstanceOf(AutomationStoreError)
    expect(appendCalls).toBe(1)
  })
})

interface RuntimeFakes {
  readonly clock: ClockPort
  readonly env: EnvPort
  readonly availability: ModelAvailabilityPort
  readonly agentLoop: AgentLoopPort
  readonly sink: SchedulerSinkPort
  readonly events: SchedulerEvent[]
  readonly enqueued: string[]
}

const baseFakes = (): RuntimeFakes => {
  const events: SchedulerEvent[] = []
  const enqueued: string[] = []
  return {
    clock: { now: () => utc(2026, 5, 3) },
    env: { get: () => undefined },
    availability: { isAvailable: async () => true },
    agentLoop: {
      enqueueUserMessage: async (m) => {
        enqueued.push(m)
      },
    },
    sink: { emit: (e) => events.push(e) },
    events,
    enqueued,
  }
}

describe("T10 M10 — error-state persistence failure is observable", () => {
  test("[M10-1] persistError save failure emits an observable event (not silent)", async () => {
    const f = baseFakes()
    const store: AutomationStorePort = {
      load: async () => [sample()],
      // every save fails — including the error-state write.
      save: async () => {
        throw new AutomationStoreError("io-failed", "disk gone")
      },
      delete: async () => {},
    }
    const rt = createSchedulerRuntime({
      store,
      availability: { isAvailable: async () => false }, // forces error path
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    // The error transition AND its failed persistence must both be observable.
    const kinds = f.events.map((e) => e.type)
    expect(kinds).toContain("scheduler.error")
    // A persistence failure must surface — not vanish.
    expect(
      f.events.some((e) => e.type === "scheduler.skipped" && e.reason === "store-save-failed"),
    ).toBe(true)
  })
})

describe("T10 M7 — persist-before-dispatch (no double mutating dispatch)", () => {
  test("[M7-1] the fire anchor is saved BEFORE the prompt is enqueued", async () => {
    const f = baseFakes()
    const order: string[] = []
    const store: AutomationStorePort = {
      load: async () => [sample()],
      save: async () => {
        order.push("save")
      },
      delete: async () => {},
    }
    const loop: AgentLoopPort = {
      enqueueUserMessage: async () => {
        order.push("dispatch")
      },
    }
    const rt = createSchedulerRuntime({
      store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: loop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    // The persisted anchor advances BEFORE dispatch, so a crash after dispatch
    // does not re-dispatch (the reloaded anchor already moved past `now`).
    expect(order).toEqual(["save", "dispatch"])
  })
})
