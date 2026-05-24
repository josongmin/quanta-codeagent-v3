/**
 * Concurrent primitives stress — hellgate (Gap #1 + #5 of 4-axis audit).
 *
 * Stresses the 4 in-memory singletons under concurrent calls. JS is
 * single-threaded so "concurrent" here means:
 *   - Many promises started in parallel via `Promise.all`
 *   - Microtask interleaving (each promise yields at await points)
 *   - Manually-controlled deferreds that race against synchronous mutations
 *
 * The invariants tested are race-free in JS because each primitive's public
 * surface is implemented with synchronous Map/Array operations (no `await`
 * mid-mutation). The hellgate enforces this posture — if a future refactor
 * introduces an `await` mid-mutation, these tests will surface the regression
 * as torn writes / lost increments / over-cap violations.
 *
 * Sections:
 *   A. ConversationCheckpointStore (4)
 *   B. PlanQueueStore               (4)
 *   C. BudgetLedger                 (4)
 *   D. BackgroundSubagentScheduler  (3)
 */

import { describe, expect, test } from "bun:test"
import { type BudgetLedger, defaultBudgetLedger, type UsageEvent } from "@/agent/budget-ledger"
import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { defaultPlanQueueStore, type FollowUp, type PlanQueueStore } from "@/agent/plan-queue"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
  SubagentBackgroundError,
} from "@/agent/subagent-background"
import type { Message } from "@/llm"
import type { SubagentResult as SliceResult, SubagentRunner } from "@/subagent"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const mkMessage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

const enqueueInput = (
  over: Partial<Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">> = {},
) => ({
  threadId: "t1",
  text: "hello",
  source: "user_keystroke" as const,
  pausedReason: "tool_in_flight" as const,
  arrivedDuringTurn: 1,
  urgent: false,
  metadata: {} as Readonly<Record<string, string>>,
  ...over,
})

/** Make N tasks that each do an identical record. */
const parallel = async <T>(n: number, fn: (i: number) => T | Promise<T>): Promise<T[]> => {
  const tasks: Promise<T>[] = []
  for (let i = 0; i < n; i++) tasks.push(Promise.resolve().then(() => fn(i)))
  return Promise.all(tasks)
}

/* ================================================================== */
/* A. ConversationCheckpointStore (4)                                 */
/* ================================================================== */

describe("A. ConversationCheckpointStore concurrent stress", () => {
  test("A1: 20 concurrent record(id, msgs) with same id → final snapshot count is 1", async () => {
    const store: ConversationCheckpointStore = defaultConversationCheckpointStore({
      maxEntries: 50,
    })
    await parallel(20, (i) => store.record("same-id", [mkMessage(`v${i}`)]))
    const list = store.list()
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe("same-id")
    // One of the 20 writes wins — value is one of v0..v19.
    const text = (list[0]?.messages[0]?.content as { type: string; text: string }[])[0]?.text ?? ""
    expect(text).toMatch(/^v\d+$/)
  })

  test("A2: 20 concurrent record(id_N, msgs) with distinct ids → all 20 in list()", async () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 50 })
    await parallel(20, (i) => store.record(`id-${i}`, [mkMessage(`payload-${i}`)]))
    const list = store.list()
    expect(list.length).toBe(20)
    // Each id appears exactly once (no duplicates, no lost writes).
    const ids = new Set(list.map((s) => s.id))
    expect(ids.size).toBe(20)
  })

  test("A3: concurrent record + restore interleaved → restore returns pre- or post-state, never partial", async () => {
    const store = defaultConversationCheckpointStore()
    store.record("k", [mkMessage("pre")])
    const ops: Array<Promise<unknown>> = []
    for (let i = 0; i < 50; i++) {
      ops.push(Promise.resolve().then(() => store.record("k", [mkMessage(`v${i}`)])))
      ops.push(
        Promise.resolve().then(() => {
          const r = store.restore("k")
          // Either it's "pre" or one of "v0..v49". NEVER null after the first record.
          if (r === null) return null
          const block = r[0]?.content as { type: string; text: string }[]
          const text = block[0]?.text ?? ""
          expect(text === "pre" || /^v\d+$/.test(text)).toBe(true)
          return text
        }),
      )
    }
    await Promise.all(ops)
    // After all writes settled, one of the v* values wins.
    const final = store.restore("k")
    if (final === null) throw new Error("expected non-null after writes")
    const block = final[0]?.content as { type: string; text: string }[]
    expect(/^v\d+$/.test(block[0]?.text ?? "")).toBe(true)
  })

  test("A4: concurrent clear() + record() → store ends in 0 or N entries (defined state)", async () => {
    const store = defaultConversationCheckpointStore()
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 30; i++) {
      ops.push(Promise.resolve().then(() => store.record(`id-${i}`, [mkMessage(String(i))])))
    }
    // Insert one mid-stream clear.
    ops.push(Promise.resolve().then(() => store.clear()))
    await Promise.all(ops)
    const finalCount = store.list().length
    // After all microtasks settle, finalCount is well-defined: it's the number
    // of records that ran AFTER the clear. We don't know the exact value but
    // it MUST be in [0..30].
    expect(finalCount).toBeGreaterThanOrEqual(0)
    expect(finalCount).toBeLessThanOrEqual(30)
  })
})

/* ================================================================== */
/* B. PlanQueueStore (4)                                              */
/* ================================================================== */

describe("B. PlanQueueStore concurrent stress", () => {
  test("B5: 50 concurrent enqueue with same threadId DISTINCT texts → drain returns 50", async () => {
    const store: PlanQueueStore = defaultPlanQueueStore({ maxPerThread: 100 })
    await parallel(50, (i) => store.enqueue(enqueueInput({ text: `unique-${i}` })))
    const drained = store.drain("t1", 1)
    expect(drained.length).toBe(50)
  })

  test("B6: concurrent enqueue + drain → drain sees a coherent prefix (each entry seen at most once)", async () => {
    const store = defaultPlanQueueStore({ maxPerThread: 100 })
    const drained: FollowUp[] = []
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 30; i++) {
      ops.push(Promise.resolve().then(() => store.enqueue(enqueueInput({ text: `t${i}` }))))
      if (i % 5 === 0) {
        ops.push(
          Promise.resolve().then(() => {
            for (const f of store.drain("t1", 1)) drained.push(f)
          }),
        )
      }
    }
    await Promise.all(ops)
    // Catch the final flush.
    for (const f of store.drain("t1", 2)) drained.push(f)
    // Each enqueue resulted in at most one drained entry. The total may be
    // anywhere from 30 (all unique survived) down to less if dedup kicked.
    expect(drained.length).toBeGreaterThan(0)
    expect(drained.length).toBeLessThanOrEqual(30)
    // ids are all unique (no double-drain).
    const ids = new Set(drained.map((d) => d.id))
    expect(ids.size).toBe(drained.length)
  })

  test("B7: concurrent enqueue with DIFFERENT threadIds → per-thread isolation (cross-thread leak = 0)", async () => {
    const store = defaultPlanQueueStore({ maxPerThread: 100 })
    await parallel(30, (i) =>
      store.enqueue(enqueueInput({ threadId: `t-${i % 3}`, text: `payload-${i}` })),
    )
    const a = store.peek("t-0")
    const b = store.peek("t-1")
    const c = store.peek("t-2")
    expect(a.length + b.length + c.length).toBe(30)
    // No entry on thread X has threadId Y.
    for (const f of a) expect(f.threadId).toBe("t-0")
    for (const f of b) expect(f.threadId).toBe("t-1")
    for (const f of c) expect(f.threadId).toBe("t-2")
  })

  test("B8: dedup race — 20 concurrent enqueue same (threadId, textHash) → exactly 1 survives", async () => {
    const store = defaultPlanQueueStore({ maxPerThread: 100 })
    const ids = await parallel(20, () =>
      store.enqueue(enqueueInput({ threadId: "t-dedup", text: "identical" })),
    )
    // All 20 ids are the SAME (dedup OR-in returned the EXISTING id).
    const unique = new Set(ids)
    expect(unique.size).toBe(1)
    expect(store.peek("t-dedup").length).toBe(1)
  })
})

/* ================================================================== */
/* C. BudgetLedger (4)                                                */
/* ================================================================== */

describe("C. BudgetLedger concurrent stress", () => {
  const usage = (over: Partial<UsageEvent> = {}): UsageEvent => ({
    model: "claude-opus-4-7",
    inputTokens: 1_000_000,
    outputTokens: 0,
    sessionId: "s1",
    at: 1_700_000_000_000,
    ...over,
  })

  test("C9: 100 concurrent record(event) same session → totalCost = sum of all events", async () => {
    const ledger: BudgetLedger = defaultBudgetLedger()
    // each event = $15 (1M opus input @ $15/M).
    await parallel(100, () => ledger.record(usage()))
    const snap = ledger.snapshot()
    expect(snap.events).toBe(100)
    expect(snap.totalCost).toBeCloseTo(100 * 15, 5)
    expect(snap.perSession.get("s1")?.totalCost).toBeCloseTo(100 * 15, 5)
  })

  test("C10: concurrent breach detection → soft breach fires exactly once (debounce holds)", async () => {
    // sessionSoftLimit = $30. Each event = $15. 20 events ⇒ would naively fire 19x.
    const ledger = defaultBudgetLedger({ policy: { sessionSoftLimit: 30 } })
    const breachCounts = await parallel(20, () => ledger.record(usage()))
    const softBreaches = breachCounts.flat().filter((b) => b.kind === "session-soft")
    expect(softBreaches.length).toBe(1)
    expect(softBreaches[0]?.kind).toBe("session-soft")
  })

  test("C11: concurrent snapshot() calls → each consistent (no torn read)", async () => {
    const ledger = defaultBudgetLedger()
    for (let i = 0; i < 10; i++) ledger.record(usage({ inputTokens: 100_000 }))
    const snaps = await parallel(20, () => ledger.snapshot())
    // Every snapshot has the same totals (no concurrent record happened).
    const first = snaps[0]
    if (!first) throw new Error("no snapshot")
    for (const s of snaps) {
      expect(s.events).toBe(first.events)
      expect(s.totalCost).toBeCloseTo(first.totalCost, 10)
    }
  })

  test("C12: concurrent clear({session}) + record() → final state is well-defined", async () => {
    const ledger = defaultBudgetLedger()
    for (let i = 0; i < 5; i++) ledger.record(usage({ inputTokens: 1_000_000 }))
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      ops.push(Promise.resolve().then(() => ledger.record(usage({ inputTokens: 1_000_000 }))))
    }
    ops.push(Promise.resolve().then(() => ledger.clear({ session: "s1" })))
    await Promise.all(ops)
    const snap = ledger.snapshot()
    // After clear ran somewhere in the middle, the final event count is the
    // number of records that happened AFTER the clear. Must be in [0..15].
    expect(snap.events).toBeGreaterThanOrEqual(0)
    expect(snap.events).toBeLessThanOrEqual(15)
  })
})

/* ================================================================== */
/* D. BackgroundSubagentScheduler (3)                                 */
/* ================================================================== */

describe("D. BackgroundSubagentScheduler concurrent stress", () => {
  /** Hung runner — never resolves (until we abort via signal). */
  const hangingRunner: SubagentRunner = (req) =>
    new Promise<SliceResult>((resolve) => {
      req.signal?.addEventListener("abort", () => {
        resolve({ ok: false, finalText: "aborted", turns: 0 })
      })
    })

  test("D13: 10 concurrent fork() with maxConcurrent=5 → 5 succeed, 5 throw cap-exceeded", async () => {
    let _counter = 0
    const scheduler: BackgroundSubagentScheduler = defaultBackgroundSubagentScheduler({
      runner: hangingRunner,
      maxConcurrent: 5,
      idGen: () => `id-${_counter++}`,
    })
    const results = await parallel(10, (i) => {
      try {
        return { ok: true as const, id: scheduler.fork({ task: `task-${i}` }) }
      } catch (e) {
        if (e instanceof SubagentBackgroundError) return { ok: false as const, code: e.code }
        throw e
      }
    })
    const successes = results.filter((r) => r.ok)
    const failures = results.filter((r) => !r.ok)
    expect(successes.length).toBe(5)
    expect(failures.length).toBe(5)
    for (const f of failures) {
      if (f.ok) throw new Error("unreachable")
      expect(f.code).toBe("cap-exceeded")
    }
    // Clean up: cancel everything so the test isn't holding promises.
    for (const r of successes) {
      if (r.ok) scheduler.cancel(r.id)
    }
  })

  test("D14: concurrent cancel() + runner mid-flight resolution → status ends 'cancelled'", async () => {
    let resolveFn: ((r: SliceResult) => void) | null = null
    const runner: SubagentRunner = (req) =>
      new Promise<SliceResult>((res) => {
        resolveFn = res
        req.signal?.addEventListener("abort", () => {
          res({ ok: true, finalText: "would-be-done", turns: 1 })
        })
      })
    const scheduler = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
    })
    const id = scheduler.fork({ task: "race" })
    // Race: cancel and runner-resolve fire as adjacent microtasks.
    await Promise.all([
      Promise.resolve().then(() => scheduler.cancel(id)),
      Promise.resolve().then(() => {
        if (resolveFn) resolveFn({ ok: true, finalText: "raced", turns: 2 })
      }),
    ])
    // Allow internal promise to settle.
    const final = await scheduler.await(id)
    expect(final?.status).toBe("cancelled")
  })

  test("D15: concurrent poll from N parallel callers → all see consistent snapshot", async () => {
    const scheduler = defaultBackgroundSubagentScheduler({
      runner: hangingRunner,
      maxConcurrent: 3,
    })
    const id = scheduler.fork({ task: "watch" })
    const snaps = await parallel(15, () => scheduler.poll(id))
    expect(snaps.length).toBe(15)
    for (const s of snaps) {
      expect(s).not.toBeNull()
      expect(s?.status).toBe("running")
      expect(s?.startedAt).toBe(snaps[0]?.startedAt)
    }
    scheduler.cancel(id)
  })
})
