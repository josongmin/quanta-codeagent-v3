/**
 * ADR-0161 Phase E — SchedulerRuntime tickOnce / start / stop tests.
 *
 * All effects (clock / store / availability / agent-loop / env / sink) are
 * fakes — runtime is exercised end-to-end without touching wall clock, file
 * system, or process.env.
 */

import { describe, expect, test } from "bun:test"
import { createAutomation, transitionStatus } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import {
  createSchedulerRuntime,
  DEFAULT_TICK_INTERVAL_MS,
  SCHEDULER_ENV_FLAG,
} from "@/scheduler/runtime"
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

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, 0)

const sampleAutomation = (overrides?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "weekly",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "run me",
    modelPreference: "gpt-5",
    modelFallbacks: ["claude-4"],
    createdAt: utc(2026, 5, 1),
  }),
  ...overrides,
})

interface Fakes {
  readonly clock: ClockPort
  readonly setClock: (ms: number) => void
  readonly env: EnvPort
  readonly setEnv: (key: string, value: string | undefined) => void
  readonly store: AutomationStorePort
  readonly storeContent: Automation[]
  readonly availability: ModelAvailabilityPort
  readonly setAvailable: (models: ReadonlyArray<string>) => void
  readonly agentLoop: AgentLoopPort
  readonly enqueued: string[]
  readonly enqueueOpts: Array<{ signal?: AbortSignal; modelOverride?: string } | undefined>
  readonly sink: SchedulerSinkPort
  readonly events: SchedulerEvent[]
}

const buildFakes = (initial: ReadonlyArray<Automation> = []): Fakes => {
  let nowMs = utc(2026, 5, 1)
  const clock: ClockPort = { now: () => nowMs }
  const envMap = new Map<string, string>()
  const env: EnvPort = { get: (k) => envMap.get(k) }
  const storeContent: Automation[] = [...initial]
  const store: AutomationStorePort = {
    load: async () => [...storeContent],
    save: async (_w, a) => {
      const idx = storeContent.findIndex((x) => x.id === a.id)
      if (idx >= 0) storeContent[idx] = a
      else storeContent.push(a)
    },
    delete: async (_w, id) => {
      const idx = storeContent.findIndex((x) => x.id === id)
      if (idx >= 0) storeContent.splice(idx, 1)
    },
  }
  let availableModels: ReadonlyArray<string> = ["gpt-5", "claude-4"]
  const availability: ModelAvailabilityPort = {
    isAvailable: async (m) => availableModels.includes(m),
  }
  const enqueued: string[] = []
  const enqueueOpts: Array<{ signal?: AbortSignal; modelOverride?: string } | undefined> = []
  const agentLoop: AgentLoopPort = {
    enqueueUserMessage: async (msg, opts) => {
      enqueued.push(msg)
      enqueueOpts.push(opts)
    },
  }
  const events: SchedulerEvent[] = []
  const sink: SchedulerSinkPort = {
    emit: (e) => {
      events.push(e)
    },
  }
  return {
    clock,
    setClock: (ms) => {
      nowMs = ms
    },
    env,
    setEnv: (k, v) => {
      if (v === undefined) envMap.delete(k)
      else envMap.set(k, v)
    },
    store,
    storeContent,
    availability,
    setAvailable: (ms) => {
      availableModels = ms
    },
    agentLoop,
    enqueued,
    enqueueOpts,
    sink,
    events,
  }
}

describe("SchedulerRuntime — tickOnce", () => {
  test("active + due → fires + saves + emits", async () => {
    const f = buildFakes([sampleAutomation()])
    f.setClock(utc(2026, 5, 3)) // 2 days after createdAt
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual(["run me"])
    expect(f.enqueueOpts).toEqual([{ modelOverride: "gpt-5" }])
    expect(f.storeContent[0]?.fireCount).toBe(1)
    expect(f.storeContent[0]?.lastFiredAt).toBe(utc(2026, 5, 3))
    expect(f.events.length).toBe(1)
    expect(f.events[0]?.type).toBe("scheduler.fired")
  })

  test("not due → no fire", async () => {
    const f = buildFakes([sampleAutomation()])
    // clock == createdAt; strict `>` so DAILY's first fire is the next day.
    f.setClock(utc(2026, 5, 1))
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([])
    expect(f.events).toEqual([])
  })

  test("paused → emits skipped event, no fire", async () => {
    const f = buildFakes([transitionStatus(sampleAutomation(), "paused")])
    f.setClock(utc(2026, 5, 3))
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([])
    expect(f.events[0]).toMatchObject({ type: "scheduler.skipped", reason: "paused" })
  })

  test("deleted → emits skipped/deleted, no fire", async () => {
    const f = buildFakes([transitionStatus(sampleAutomation(), "deleted")])
    f.setClock(utc(2026, 5, 3))
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([])
    expect(f.events[0]).toMatchObject({ type: "scheduler.skipped", reason: "deleted" })
  })

  test("model fallback chain — first fallback used", async () => {
    const f = buildFakes([sampleAutomation()])
    f.setClock(utc(2026, 5, 3))
    f.setAvailable(["claude-4"]) // preference (gpt-5) unavailable
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual(["run me"])
    expect(f.enqueueOpts).toEqual([{ modelOverride: "claude-4" }])
    const ev = f.events[0]
    expect(ev?.type).toBe("scheduler.fired")
    if (ev?.type === "scheduler.fired") {
      expect(ev.chosenModel).toBe("claude-4")
      expect(ev.rerouteReason).toBe("fallback")
      expect(ev.fallbackIndex).toBe(0)
    }
  })

  test("all unavailable → automation transitions to error + emits error", async () => {
    const f = buildFakes([sampleAutomation()])
    f.setClock(utc(2026, 5, 3))
    f.setAvailable([])
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([])
    expect(f.storeContent[0]?.status).toBe("error")
    expect(f.events[0]?.type).toBe("scheduler.error")
  })

  test("enqueue throws → error event + store records error", async () => {
    const f = buildFakes([sampleAutomation()])
    f.setClock(utc(2026, 5, 3))
    const failingLoop: AgentLoopPort = {
      enqueueUserMessage: async () => {
        throw new Error("queue full")
      },
    }
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: failingLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.events[0]?.type).toBe("scheduler.error")
    expect(f.storeContent[0]?.status).toBe("error")
    expect(f.storeContent[0]?.lastErrorMessage).toContain("queue full")
  })

  test("multiple automations — one error doesn't break others", async () => {
    const a1 = sampleAutomation()
    const a2 = { ...sampleAutomation(), id: "a2", prompt: "p2" }
    const f = buildFakes([a1, a2])
    f.setClock(utc(2026, 5, 3))
    // First call throws, second succeeds.
    let calls = 0
    const partialLoop: AgentLoopPort = {
      enqueueUserMessage: async (msg) => {
        calls += 1
        if (calls === 1) throw new Error("only-first")
        f.enqueued.push(msg)
      },
    }
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: partialLoop,
      workspace: "/w",
      sink: f.sink,
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual(["p2"])
    // a1 in error, a2 fired.
    const after = await f.store.load("/w")
    const a1after = after.find((x) => x.id === "a1")
    const a2after = after.find((x) => x.id === "a2")
    expect(a1after?.status).toBe("error")
    expect(a2after?.fireCount).toBe(1)
  })
})

describe("SchedulerRuntime — start/stop", () => {
  test("start without env flag is a NO-OP (default-OFF)", () => {
    const f = buildFakes()
    let intervalCalls = 0
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      setInterval: () => {
        intervalCalls += 1
        return 42
      },
      clearInterval: () => {},
    })
    rt.start()
    expect(intervalCalls).toBe(0) // env flag absent
  })

  test("start with env flag set spins timer", () => {
    const f = buildFakes()
    f.setEnv(SCHEDULER_ENV_FLAG, "1")
    let intervalCalls = 0
    let lastMs: number | undefined
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      setInterval: (_h, ms) => {
        intervalCalls += 1
        lastMs = ms
        return 42
      },
      clearInterval: () => {},
    })
    rt.start()
    expect(intervalCalls).toBe(1)
    expect(lastMs).toBe(DEFAULT_TICK_INTERVAL_MS)
  })

  test("start is idempotent", () => {
    const f = buildFakes()
    f.setEnv(SCHEDULER_ENV_FLAG, "1")
    let intervalCalls = 0
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      setInterval: () => {
        intervalCalls += 1
        return 42
      },
      clearInterval: () => {},
    })
    rt.start()
    rt.start()
    rt.start()
    expect(intervalCalls).toBe(1)
  })

  test("stop after start clears + is idempotent", () => {
    const f = buildFakes()
    f.setEnv(SCHEDULER_ENV_FLAG, "1")
    let cleared = 0
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      setInterval: () => 42,
      clearInterval: () => {
        cleared += 1
      },
    })
    rt.start()
    rt.stop()
    rt.stop()
    expect(cleared).toBe(1)
  })
})
