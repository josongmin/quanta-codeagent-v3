/**
 * ADR-0161 Phase F — Scheduler ↔ reactor end-to-end integration.
 *
 * The runtime uses a real JSONL file-backed store (temp dir), advances a fake
 * clock manually, exercises model fallback + error transitions, and verifies
 * the agent-loop seam ingests the prompt the same way reactor's
 * `manual_resume` does.
 *
 * 5 scenarios:
 *   1. Create → tick → fires + persists.
 *   2. Pause mid-cycle → next tick skips.
 *   3. Delete mid-cycle → next tick skips (tombstone).
 *   4. Model unavailable → fallback used.
 *   5. All models unavailable → transition to `error`.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutomation, transitionStatus } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import { defaultJsonlAutomationStore } from "@/scheduler/store-jsonl"
import type {
  AgentLoopPort,
  Automation,
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

const sampleAutomation = (id = "a1"): Automation =>
  createAutomation({
    id,
    title: "daily",
    rule: ruleOf("FREQ=DAILY"),
    prompt: `prompt-${id}`,
    modelPreference: "gpt-5",
    modelFallbacks: ["claude-4", "gpt-4-mini"],
    createdAt: utc(2026, 5, 1),
  })

interface Harness {
  readonly baseDir: string
  readonly cleanup: () => Promise<void>
  readonly clock: ClockPort
  readonly setClock: (ms: number) => void
  readonly env: EnvPort
  readonly availability: ModelAvailabilityPort
  readonly setAvailable: (models: ReadonlyArray<string>) => void
  readonly agentLoop: AgentLoopPort
  readonly enqueued: string[]
  readonly enqueueOpts: Array<{ signal?: AbortSignal; modelOverride?: string } | undefined>
  readonly sink: SchedulerSinkPort
  readonly events: SchedulerEvent[]
  readonly workspace: string
}

const buildHarness = async (): Promise<Harness> => {
  const baseDir = await mkdtemp(join(tmpdir(), "qsched-int-"))
  let nowMs = utc(2026, 5, 1)
  const enqueued: string[] = []
  const enqueueOpts: Array<{ signal?: AbortSignal; modelOverride?: string } | undefined> = []
  const events: SchedulerEvent[] = []
  let available: ReadonlyArray<string> = ["gpt-5", "claude-4", "gpt-4-mini"]
  return {
    baseDir,
    cleanup: () => rm(baseDir, { recursive: true, force: true }),
    clock: { now: () => nowMs },
    setClock: (ms) => {
      nowMs = ms
    },
    env: { get: () => undefined },
    availability: { isAvailable: async (m) => available.includes(m) },
    setAvailable: (ms) => {
      available = ms
    },
    agentLoop: {
      enqueueUserMessage: async (msg, opts) => {
        enqueued.push(msg)
        enqueueOpts.push(opts)
      },
    },
    enqueued,
    enqueueOpts,
    sink: {
      emit: (e) => {
        events.push(e)
      },
    },
    events,
    workspace: "/workspace",
  }
}

describe("Scheduler ↔ reactor end-to-end", () => {
  test("[1] create → fire → persist (JSONL store)", async () => {
    const h = await buildHarness()
    try {
      const store = defaultJsonlAutomationStore({ baseDir: h.baseDir })
      await store.save(h.workspace, sampleAutomation())
      const rt = createSchedulerRuntime({
        store,
        availability: h.availability,
        clock: h.clock,
        env: h.env,
        agentLoop: h.agentLoop,
        workspace: h.workspace,
        sink: h.sink,
      })
      // Tick at create+2d — DAILY's first fire is create+1d.
      h.setClock(utc(2026, 5, 3))
      await rt.tickOnce()
      expect(h.enqueued).toEqual(["prompt-a1"])
      expect(h.enqueueOpts).toEqual([{ modelOverride: "gpt-5" }])
      // Re-load from disk and verify persistence.
      const reloaded = await store.load(h.workspace)
      expect(reloaded[0]?.fireCount).toBe(1)
      expect(reloaded[0]?.lastFiredAt).toBe(utc(2026, 5, 3))
    } finally {
      await h.cleanup()
    }
  })

  test("[2] pause mid-cycle → next tick skips", async () => {
    const h = await buildHarness()
    try {
      const store = defaultJsonlAutomationStore({ baseDir: h.baseDir })
      await store.save(h.workspace, sampleAutomation())
      const rt = createSchedulerRuntime({
        store,
        availability: h.availability,
        clock: h.clock,
        env: h.env,
        agentLoop: h.agentLoop,
        workspace: h.workspace,
        sink: h.sink,
      })
      // Operator pauses.
      const current = (await store.load(h.workspace))[0]
      if (current === undefined) throw new Error("expected automation")
      await store.save(h.workspace, transitionStatus(current, "paused"))
      h.setClock(utc(2026, 5, 3))
      await rt.tickOnce()
      expect(h.enqueued).toEqual([])
      expect(h.events.some((e) => e.type === "scheduler.skipped" && e.reason === "paused")).toBe(
        true,
      )
    } finally {
      await h.cleanup()
    }
  })

  test("[3] delete mid-cycle → tombstone → load hides", async () => {
    const h = await buildHarness()
    try {
      const store = defaultJsonlAutomationStore({ baseDir: h.baseDir })
      await store.save(h.workspace, sampleAutomation())
      const rt = createSchedulerRuntime({
        store,
        availability: h.availability,
        clock: h.clock,
        env: h.env,
        agentLoop: h.agentLoop,
        workspace: h.workspace,
        sink: h.sink,
      })
      await store.delete(h.workspace, "a1")
      h.setClock(utc(2026, 5, 3))
      await rt.tickOnce()
      expect(h.enqueued).toEqual([])
      // Tombstone hides from load, so no skipped event either (load is empty).
      expect(h.events).toEqual([])
    } finally {
      await h.cleanup()
    }
  })

  test("[4] preference unavailable → fallback used + event records reroute", async () => {
    const h = await buildHarness()
    try {
      const store = defaultJsonlAutomationStore({ baseDir: h.baseDir })
      await store.save(h.workspace, sampleAutomation())
      h.setAvailable(["claude-4", "gpt-4-mini"]) // gpt-5 unavailable
      const rt = createSchedulerRuntime({
        store,
        availability: h.availability,
        clock: h.clock,
        env: h.env,
        agentLoop: h.agentLoop,
        workspace: h.workspace,
        sink: h.sink,
      })
      h.setClock(utc(2026, 5, 3))
      await rt.tickOnce()
      expect(h.enqueued).toEqual(["prompt-a1"])
      expect(h.enqueueOpts).toEqual([{ modelOverride: "claude-4" }])
      const fired = h.events.find((e) => e.type === "scheduler.fired")
      expect(fired).toBeDefined()
      if (fired?.type === "scheduler.fired") {
        expect(fired.chosenModel).toBe("claude-4")
        expect(fired.rerouteReason).toBe("fallback")
        expect(fired.fallbackIndex).toBe(0)
      }
    } finally {
      await h.cleanup()
    }
  })

  test("[5] all models unavailable → transition to error + persists", async () => {
    const h = await buildHarness()
    try {
      const store = defaultJsonlAutomationStore({ baseDir: h.baseDir })
      await store.save(h.workspace, sampleAutomation())
      h.setAvailable([])
      const rt = createSchedulerRuntime({
        store,
        availability: h.availability,
        clock: h.clock,
        env: h.env,
        agentLoop: h.agentLoop,
        workspace: h.workspace,
        sink: h.sink,
      })
      h.setClock(utc(2026, 5, 3))
      await rt.tickOnce()
      expect(h.enqueued).toEqual([])
      const reloaded = await store.load(h.workspace)
      expect(reloaded[0]?.status).toBe("error")
      expect(reloaded[0]?.lastErrorMessage).toContain("unavailable")
      expect(h.events.some((e) => e.type === "scheduler.error")).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})
