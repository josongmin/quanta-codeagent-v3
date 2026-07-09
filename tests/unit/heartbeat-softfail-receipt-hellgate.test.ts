/**
 * WS-D batch-1 (UUX-4-01, plan D-4) — heartbeat soft-fail effect receipt.
 *
 * Template: **`scheduler.fired` while the prompt never reached a queue ⇒
 * RED.** The runtime must HONOR the binder verdict: a `{ok:false}` resume
 * (e.g. `thread-not-found`) is a definite non-delivery, so
 *   - NO `scheduler.fired` is emitted,
 *   - a `scheduler.error` IS emitted (operator-visible),
 *   - the fire anchor is NOT consumed — reserve→confirm rolls it back so the
 *     occurrence retries next tick (bounded by MAX_ENQUEUE_SOFT_RETRIES),
 *   - at the retry cap the automation lands `status:"error"` on the ADVANCED
 *     anchor (never an unbounded retry loop / never a silent drop).
 *
 * Crash-safety stays pinned: persist-before-dispatch order is unchanged (the
 * reserve IS the persisted advanced anchor), and the hard-throw path keeps the
 * M7 at-most-once semantics (`runtime-enqueue-anchor-hellgate.test.ts`).
 *
 * Drives the REAL `createSchedulerRuntime` through the REAL CLI
 * `heartbeatEnqueueHandler` + `createHeartbeatBinder` — no fake seams between
 * the verdict and the event emission.
 */

import { describe, expect, test } from "bun:test"
import { createHeartbeatBinder, heartbeatEnqueueHandler } from "@/apps/cli/repl/heartbeat-binder"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import type {
  Automation,
  AutomationStorePort,
  HeartbeatPolicySnapshot,
  RRule,
  SchedulerEvent,
} from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}
const utc = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d)

const SESSION = "thread-S"

const posture: HeartbeatPolicySnapshot = {
  approvalPolicy: "default",
  sandboxPolicy: "workspace-write",
  collaborationMode: "default",
}

const heartbeat = (): Automation => ({
  ...createAutomation({
    id: "hb1",
    title: "heartbeat",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "keep working",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: utc(2026, 5, 1),
  }),
  kind: "heartbeat",
  targetThreadId: SESSION,
  inheritedPolicy: posture,
})

interface Harness {
  readonly storeContent: Automation[]
  readonly store: AutomationStorePort
  readonly events: SchedulerEvent[]
  readonly pushed: string[]
  readonly saveCalls: Automation[]
}

const buildHarness = (initial: Automation[], opts?: { failSaveAtCall?: number }): Harness => {
  const storeContent = [...initial]
  const saveCalls: Automation[] = []
  const store: AutomationStorePort = {
    load: async () => [...storeContent],
    save: async (_w, a) => {
      if (opts?.failSaveAtCall !== undefined && saveCalls.length + 1 === opts.failSaveAtCall) {
        saveCalls.push(a)
        throw new Error("disk full")
      }
      saveCalls.push(a)
      const idx = storeContent.findIndex((x) => x.id === a.id)
      if (idx >= 0) storeContent[idx] = a
      else storeContent.push(a)
    },
    delete: async () => {},
  }
  return { storeContent, store, events: [], pushed: [], saveCalls }
}

/** Runtime whose live REPL thread id is resolved per-call (swap mid-test). */
const makeRuntime = (h: Harness, liveThreadId: () => string | undefined) => {
  const binder = createHeartbeatBinder({
    liveThreadId,
    permissionCell: () => undefined,
    pushPrompt: (p) => h.pushed.push(p),
  })
  return createSchedulerRuntime({
    store: h.store,
    availability: { isAvailable: async () => true },
    clock: { now: () => utc(2026, 5, 3) },
    env: { get: () => undefined },
    agentLoop: {
      enqueueUserMessage: heartbeatEnqueueHandler({
        binder,
        pushPrompt: (p) => h.pushed.push(p),
      }),
    },
    workspace: "/w",
    sink: { emit: (e) => void h.events.push(e) },
  })
}

const types = (h: Harness): string[] => h.events.map((e) => e.type)

describe("heartbeat soft-fail (binder ok:false) — effect receipt", () => {
  test("HELLGATE: thread-not-found ⇒ NO scheduler.fired, scheduler.error emitted, anchor retained for retry", async () => {
    const h = buildHarness([heartbeat()])
    const rt = makeRuntime(h, () => "thread-OTHER") // foreign thread ⇒ ok:false

    await rt.tickOnce()

    // Nothing was delivered anywhere.
    expect(h.pushed).toEqual([])
    // The forbidden state: a fired event for a prompt that never landed.
    expect(types(h)).not.toContain("scheduler.fired")
    // Operator-visible failure signal.
    const err = h.events.find((e) => e.type === "scheduler.error")
    expect(err).toBeDefined()
    expect(err?.type === "scheduler.error" && err.errorMessage).toContain("thread-not-found")
    // Reserve→confirm: the occurrence is NOT consumed — fresh store readback
    // shows the anchor rolled back so the next tick retries.
    const row = h.storeContent.find((a) => a.id === "hb1")
    expect(row?.fireCount).toBe(0)
    expect(row?.lastFiredAt).toBeUndefined()
    expect(row?.status).toBe("active")
  })

  test("retry: soft-fail tick then binder recovers ⇒ prompt delivered exactly once, fired emitted", async () => {
    const h = buildHarness([heartbeat()])
    let live = "thread-OTHER"
    const rt = makeRuntime(h, () => live)

    await rt.tickOnce() // soft-fail
    expect(h.pushed).toEqual([])

    live = SESSION // REPL now drives the target thread
    await rt.tickOnce() // retried occurrence

    expect(h.pushed).toEqual(["keep working"]) // delivered exactly once
    expect(types(h)).toContain("scheduler.fired")
    const row = h.storeContent.find((a) => a.id === "hb1")
    expect(row?.fireCount).toBe(1)
    expect(row?.lastFiredAt).toBe(utc(2026, 5, 3))
  })

  test("bounded: persistent soft-fail stops at the retry cap with status=error on the ADVANCED anchor (no infinite loop, no silent drop)", async () => {
    const h = buildHarness([heartbeat()])
    const rt = makeRuntime(h, () => "thread-OTHER")

    // Tick well past any sane cap; a bounded impl stops mutating after it.
    for (let i = 0; i < 10; i++) await rt.tickOnce()

    const row = h.storeContent.find((a) => a.id === "hb1")
    // Terminal state: errored (operator can resume), anchor advanced so an
    // operator resume does NOT re-dispatch this occurrence blindly.
    expect(row?.status).toBe("error")
    expect(row?.fireCount).toBe(1)
    expect(row?.lastFiredAt).toBe(utc(2026, 5, 3))
    // Never fired, never delivered.
    expect(h.pushed).toEqual([])
    expect(types(h)).not.toContain("scheduler.fired")
    // Attempts were bounded: soft-fail errors ≤ 10 but ≥ 2 (it DID retry),
    // and after the error transition no further error events accumulate.
    const errCount = h.events.filter((e) => e.type === "scheduler.error").length
    expect(errCount).toBeGreaterThanOrEqual(2)
    expect(errCount).toBeLessThan(10)
    const skippedAfterError = h.events.filter(
      (e) => e.type === "scheduler.skipped" && e.reason === "status-error",
    )
    expect(skippedAfterError.length).toBeGreaterThan(0)
  })

  test("regression pin (ok:true unchanged): same-thread heartbeat fires, anchor advances, prompt lands", async () => {
    const h = buildHarness([heartbeat()])
    const rt = makeRuntime(h, () => SESSION)

    await rt.tickOnce()

    expect(h.pushed).toEqual(["keep working"])
    expect(types(h)).toContain("scheduler.fired")
    expect(types(h)).not.toContain("scheduler.error")
    const row = h.storeContent.find((a) => a.id === "hb1")
    expect(row?.fireCount).toBe(1)
    // No spurious retry bookkeeping on the success path: a later tick at the
    // same instant does NOT re-fire (strict > next-fire semantics).
    await rt.tickOnce()
    expect(h.pushed).toEqual(["keep working"])
  })

  test("crash-safety pin: rollback save failure is observable (store-save-failed skip) and leaves the RESERVED anchor — at-most-once preserved", async () => {
    // save #1 = reserve (advanced anchor) succeeds; save #2 = rollback fails.
    const h = buildHarness([heartbeat()], { failSaveAtCall: 2 })
    const rt = makeRuntime(h, () => "thread-OTHER")

    await rt.tickOnce()

    expect(types(h)).not.toContain("scheduler.fired")
    // The reserve stays on disk (occurrence dropped rather than double-fired)…
    const row = h.storeContent.find((a) => a.id === "hb1")
    expect(row?.fireCount).toBe(1)
    // …and the failure to roll back is surfaced, not swallowed.
    expect(
      h.events.some((e) => e.type === "scheduler.skipped" && e.reason === "store-save-failed"),
    ).toBe(true)
  })
})
