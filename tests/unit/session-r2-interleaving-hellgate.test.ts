/**
 * jun-6 ROUND-2 adversarial audit — CONCURRENCY / STATE-MACHINE INTERLEAVING
 * hellgate for the live hot-path features built this session. Round 1 sealed a
 * watchdog-swallow + an event-loop-starvation; this file PINS the interleaving
 * invariants that round-2 PROVED currently hold, so a later refactor cannot
 * silently reintroduce a DOUBLE-ACTION, USE-AFTER-FREE, or LEAKED-RESOURCE
 * regression on these seams.
 *
 * Every test is DETERMINISTIC: a fake clock + fake one-shot scheduler for the
 * interrupt router / supervisor, and a controllable runner (manual resolve) for
 * the background scheduler. NO setTimeout-based flakes for the synchronous state
 * machines; the background scheduler intentionally uses real macrotask yields
 * (its `yieldMacrotask` is `setTimeout(0)` by design — round-1 starvation fix)
 * so those few tests drive a controllable runner and await a bounded settle.
 *
 * Coverage matrix (race → invariant):
 *   1. interrupt-router · N concurrent per-call routers share ONE source signal
 *      → each derived routes independently, withhold is per-router, no leak.
 *   2. interrupt-router · out-of-order begin/end × abort-at-every-point
 *      → abort delivered exactly once (never swallowed), no leaked watchdog.
 *   3. interrupt-router · dispose() mid-section with a CAPTURED abort
 *      → no leaked watchdog (derived may stay un-aborted; the tool already threw).
 *   4. bg-scheduler · forceBackground(burst) + auto-drain at the same boundary
 *      → the queued entry runs EXACTLY ONCE (no double-promote / double-run).
 *   5. bg-scheduler · two burst forces while at cap
 *      → cap+1 max, NEVER cap+2 (burst is a one-slot courtesy).
 *   6. bg-scheduler · cancel a queued entry, THEN free a slot
 *      → drain NEVER revives the cancelled entry (no resurrection / double-run).
 *   7. bg-scheduler · cancel mid-await on a queued entry
 *      → await unblocks with `cancelled`, no hang.
 *   8. supervisor · stop() while a resources proxy is PARKED in queue mode
 *      → waiter rejected → typed transport failure, queue-wait timer cancelled.
 */

import { describe, expect, test } from "bun:test"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import {
  DEFAULT_BACKOFF_POLICY,
  McpReconnectSupervisor,
  type McpResource,
  type McpResult,
  type McpServerConfig,
  type McpToolDef,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"
import { type CriticalSectionScheduler, makeInterruptRouter } from "@/tool"

// ───────────────────────── fake clock + one-shot scheduler ─────────────────────

const makeFakeTime = () => {
  let nowMs = 0
  let seq = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const scheduler: CriticalSectionScheduler = {
    schedule(ms, cb) {
      const id = seq++
      timers.set(id, { at: nowMs + ms, cb })
      return () => {
        timers.delete(id)
      }
    },
  }
  const advance = (ms: number): void => {
    nowMs += ms
    const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs)
    for (const [id, t] of due) {
      timers.delete(id)
      t.cb()
    }
  }
  return { now: () => nowMs, scheduler, advance, pending: () => timers.size }
}

let bgSeq = 0
const bgIdGen = (): string => {
  bgSeq += 1
  return bgSeq.toString(16).padStart(4, "0")
}

const settle = (ms = 10): Promise<void> =>
  new Promise<void>((r) => {
    setTimeout(r, ms)
  })

// ═══════════════════════════ 1–3 · interrupt-router ═══════════════════════════

describe("R2 · interrupt-router — per-call isolation + no swallow + no leak", () => {
  test("DOUBLE-ACTION/LEAK · N concurrent routers share one source: each derived routes independently, no leaked watchdog", () => {
    const time = makeFakeTime()
    const source = new AbortController()
    const mkRouter = () => {
      const derived = new AbortController()
      const r = makeInterruptRouter({
        source: source.signal,
        derived,
        now: time.now,
        maxMs: 50,
        scheduler: time.scheduler,
      })
      return { r, derived }
    }
    // 5 independent per-call routers, all wrapping the SAME upstream source.
    const r0 = mkRouter()
    const r1 = mkRouter()
    const r2 = mkRouter()
    const r3 = mkRouter()
    const r4 = mkRouter()
    const all = [r0, r1, r2, r3, r4]
    // Open a withhold window on the EVEN routers; ODD ones stay closed.
    const open0 = r0.r.seam.begin()
    const open2 = r2.r.seam.begin()
    const open4 = r4.r.seam.begin()

    source.abort(new Error("turn esc"))

    // Closed routers abort IMMEDIATELY (byte-identical cancel path).
    expect(r1.derived.signal.aborted).toBe(true)
    expect(r3.derived.signal.aborted).toBe(true)
    // Open routers WITHHOLD — per-router, no cross-contamination.
    expect(r0.derived.signal.aborted).toBe(false)
    expect(r2.derived.signal.aborted).toBe(false)
    expect(r4.derived.signal.aborted).toBe(false)

    open0.end()
    open2.end()
    open4.end()
    // Every router now delivered the withheld abort exactly once.
    for (const { derived } of all) expect(derived.signal.aborted).toBe(true)

    time.advance(100)
    expect(time.pending()).toBe(0) // no leaked watchdog across N routers
    for (const { r } of all) r.dispose()
  })

  // Out-of-order begin/end × abort-at-every-point — the abort can NEVER be
  // swallowed, and no watchdog leaks regardless of interleave. The body is
  // extracted to a helper so each parametrized `test` closure stays under the
  // biome cognitive-complexity cap.
  type AbortAt = "before-outer" | "after-outer" | "after-inner" | "after-end1"
  type EndOrder = "inner-first" | "outer-first"
  const runOutOfOrderCase = (abortAt: AbortAt, endOrder: EndOrder): void => {
    const time = makeFakeTime()
    const source = new AbortController()
    const derived = new AbortController()
    let honored = 0
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: time.now,
      maxMs: 50,
      scheduler: time.scheduler,
      observer: {
        onHonored: () => {
          honored += 1
        },
      },
    })
    const doAbort = (): void => {
      if (!source.signal.aborted) source.abort(new Error("esc"))
    }
    if (abortAt === "before-outer") doAbort()
    const outer = router.seam.begin()
    if (abortAt === "after-outer") doAbort()
    const inner = router.seam.begin()
    if (abortAt === "after-inner") doAbort()
    const e1 = endOrder === "inner-first" ? inner : outer
    const e2 = endOrder === "inner-first" ? outer : inner
    e1.end()
    if (abortAt === "after-end1") doAbort()
    e2.end()
    time.advance(100)
    // Whatever the interleave, the abort reached derived (never swallowed).
    expect(derived.signal.aborted).toBe(true)
    // Honored AT MOST once via the section path (closed-path delivery emits no
    // onHonored, so this is 0 when the abort landed while closed).
    expect(honored).toBeLessThanOrEqual(1)
    expect(time.pending()).toBe(0)
    router.dispose()
  }

  const ABORT_POINTS: AbortAt[] = ["before-outer", "after-outer", "after-inner", "after-end1"]
  const END_ORDERS: EndOrder[] = ["inner-first", "outer-first"]
  for (const abortAt of ABORT_POINTS) {
    for (const endOrder of END_ORDERS) {
      test(`SWALLOW/LEAK · abortAt=${abortAt} endOrder=${endOrder}: delivered exactly once, no leaked watchdog`, () => {
        runOutOfOrderCase(abortAt, endOrder)
      })
    }
  }

  test("LEAK · dispose() mid-section with a CAPTURED abort releases the watchdog (no leaked timer)", () => {
    const time = makeFakeTime()
    const source = new AbortController()
    const derived = new AbortController()
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: time.now,
      maxMs: 50,
      scheduler: time.scheduler,
    })
    router.seam.begin() // open
    source.abort(new Error("esc")) // captured + watchdog armed
    expect(time.pending()).toBe(1)
    router.dispose() // tool threw mid-section
    expect(time.pending()).toBe(0) // watchdog released — no leak
  })
})

// ═════════════════════════ 4–7 · background scheduler ═════════════════════════

describe("R2 · bg-scheduler — no double-promote / no resurrection / cap-respect", () => {
  test("DOUBLE-ACTION · forceBackground(burst) + auto-drain at the same boundary: each entry runs ONCE, cap never breached", async () => {
    bgSeq = 0
    const runCount = new Map<string, number>()
    const running = new Set<string>()
    let maxObserved = 0
    const ctl: { freeR0: (() => void) | null } = { freeR0: null }
    const runner: SubagentRunner = (req: SubagentRequest) => {
      const t = req.prompt
      runCount.set(t, (runCount.get(t) ?? 0) + 1)
      running.add(t)
      maxObserved = Math.max(maxObserved, running.size)
      return new Promise<SliceResult>((res) => {
        if (t === "r0") {
          ctl.freeR0 = () => {
            running.delete(t)
            res({ ok: true, finalText: "r0", turns: 1 })
          }
        }
        // others hold open
      })
    }
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen: bgIdGen,
      maxQueued: 10,
    })
    sched.fork({ task: "r0" }) // running, holds the slot
    const q1 = sched.fork({ task: "q1" }) // queued (FIFO head)
    const q2 = sched.fork({ task: "q2" }) // queued

    // Free r0 (schedules drainQueue on a microtask → it MUST observe q2 already
    // burst-promoted) AND synchronously force-burst q2 in the SAME boundary.
    ctl.freeR0?.()
    const outcome = sched.forceBackground(q2, { allowBurst: true })
    await settle()

    expect(outcome).toBe("promoted_now")
    // No entry ever ran more than once — the synchronous status flip in promote()
    // closes the lost-update window between burst and auto-drain.
    for (const [, c] of runCount) expect(c).toBe(1)
    // And the auto-drain that races the burst NEVER over-fills the cap: with
    // maxConcurrent=1 + a single +1 burst, at most 2 ever run at once (an
    // unbounded drain that ignores the cap would push q1 in for cap+2 → 3).
    expect(maxObserved).toBeLessThanOrEqual(2)
    // q1 stays parked (the slot is taken by the burst-promoted q2).
    expect(sched.poll(q1)?.status).toBe("queued")
  })

  test("CAP · two burst forces while at cap: cap+1 max, NEVER cap+2", async () => {
    bgSeq = 0
    const running = new Set<string>()
    let maxObserved = 0
    const runner: SubagentRunner = (req: SubagentRequest) => {
      running.add(req.prompt)
      maxObserved = Math.max(maxObserved, running.size)
      return new Promise<SliceResult>(() => {}) // all hold
    }
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen: bgIdGen,
      maxQueued: 10,
    })
    sched.fork({ task: "r0" }) // running, holds the slot
    const q1 = sched.fork({ task: "q1" }) // queued
    const q2 = sched.fork({ task: "q2" }) // queued
    const o1 = sched.forceBackground(q1, { allowBurst: true })
    const o2 = sched.forceBackground(q2, { allowBurst: true })
    await settle()

    expect(o1).toBe("promoted_now") // +1 burst granted
    expect(o2).toBe("moved_to_front") // second burst REFUSED (would be +2)
    expect(maxObserved).toBeLessThanOrEqual(2) // cap(1) + 1, never +2
  })

  test("RESURRECTION · cancel a queued entry, THEN free a slot: drain NEVER revives it", async () => {
    bgSeq = 0
    const runCount = new Map<string, number>()
    const ctl: { freeFirst: (() => void) | null } = { freeFirst: null }
    const runner: SubagentRunner = (req: SubagentRequest) => {
      const t = req.prompt
      runCount.set(t, (runCount.get(t) ?? 0) + 1)
      return new Promise<SliceResult>((res) => {
        if (t === "first") ctl.freeFirst = () => res({ ok: true, finalText: "first", turns: 1 })
      })
    }
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen: bgIdGen,
    })
    sched.fork({ task: "first" })
    const qId = sched.fork({ task: "queued" })
    expect(sched.poll(qId)?.status).toBe("queued")

    // Cancel the QUEUED entry → terminal "cancelled".
    expect(sched.cancel(qId)).toBe(true)
    expect(sched.poll(qId)?.status).toBe("cancelled")

    // Free the slot → drainQueue runs and MUST skip the cancelled entry.
    ctl.freeFirst?.()
    await settle()

    expect(runCount.get("queued") ?? 0).toBe(0) // never started
    expect(sched.poll(qId)?.status).toBe("cancelled") // still cancelled
  })

  test("LIVENESS · cancel mid-await on a queued entry unblocks with cancelled (no hang)", async () => {
    bgSeq = 0
    const runner: SubagentRunner = (_req: SubagentRequest) => new Promise<SliceResult>(() => {})
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen: bgIdGen,
    })
    sched.fork({ task: "holds" })
    const qId = sched.fork({ task: "queued" })

    const p = sched.await(qId) // no-signal await; loops over a macrotask yield
    setTimeout(() => sched.cancel(qId), 5)
    const res = await p
    expect(res?.status).toBe("cancelled")
  })
})

// ════════════════════════════ 8 · MCP supervisor ══════════════════════════════

const supCfg: McpServerConfig = { name: "srv", command: ["x"] }

const makeSupClock = () => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms: number) => {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        timers.splice(timers.indexOf(next), 1)
        next.fn()
      }
    },
    pending: () => timers.length,
  }
}

describe("R2 · MCP supervisor — stop() racing a parked proxy waiter (no hang / no leak)", () => {
  test("LEAK/LIVENESS · stop() while a resources proxy is PARKED in queue mode: typed transport failure, queue-wait timer cancelled", async () => {
    const clock = makeSupClock()
    const ctl: { exitHandler: ((r?: string) => void) | null } = { exitHandler: null }
    const client: SupervisableMcpClient = {
      async start() {},
      async listTools() {
        return [] as McpToolDef[]
      },
      async callTool() {
        return { ok: true, content: "" }
      },
      async stop() {},
      onExit(h) {
        ctl.exitHandler = h
        return () => {}
      },
      serverSupportsResources() {
        return true
      },
      serverSupportsPrompts() {
        return true
      },
      async listResources(): Promise<McpResult<McpResource[]>> {
        return { ok: true, value: [] }
      },
    } as SupervisableMcpClient
    const deps: SupervisorDeps = {
      factory: () => client,
      policy: DEFAULT_BACKOFF_POLICY,
      now: clock.now,
      setTimer: clock.setTimer,
      random: () => 0,
      pendingPolicy: "queue",
      queueWaitMaxMs: 10_000,
    }
    const sup = await McpReconnectSupervisor.create(supCfg, deps)
    // Crash → not-healthy → a resources proxy will PARK in the queue.
    ctl.exitHandler?.("boom")
    expect(sup.snapshot().state).not.toBe("healthy")

    const parked = sup.listResources() // parks (queue mode, not healthy)
    await sup.stop() // releaseWaiters wakes the waiter → reject

    const res = await parked
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("transport")
    expect(clock.pending()).toBe(0) // queue-wait timer cancelled — no leak
  })
})
