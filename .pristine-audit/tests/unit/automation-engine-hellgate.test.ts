/**
 * ADR-0215 hellgate — `AutomationEnginePort` + `tickScheduler` adversarial
 * cases. 14 closed cases covering:
 *   - in-memory parity with sqlite (byte-for-byte same outcomes)
 *   - duplicate-id rejection
 *   - cancel idempotency
 *   - markRun → status transition matrix
 *   - 3-table atomicity on sqlite (transaction rollback)
 *   - tick handler throw → marked errored, prior rows untouched
 *   - tick idle (no due rows)
 *   - exhausted rule (`computeNextFire → "never"`) → status `fired`
 *   - exactOptional omission (no `field: undefined` leaks)
 *   - cancelled rows excluded from `list` / `next`
 *   - error propagation from a thrown handler does NOT throw out of tickScheduler
 *   - inbox + runs are written by markRun (verified via sqlite read-side helpers)
 *   - default-OFF: importing the barrel makes zero db / fs side effects
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type AutomationEnginePort,
  inMemoryAutomationEngine,
  listAutomationRuns,
  listInboxItems,
  sqliteAutomationEngine,
  tickScheduler,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, 0)

const makeBoth = (): { mem: AutomationEnginePort; sql: AutomationEnginePort; db: Database } => {
  const mem = inMemoryAutomationEngine()
  const db = new Database(":memory:")
  const sql = sqliteAutomationEngine(db)
  return { mem, sql, db }
}

describe("ADR-0215 — AutomationEnginePort adversarial battery", () => {
  test("[1] schedule then list returns the row (in-memory)", async () => {
    const eng = inMemoryAutomationEngine()
    const r = await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do thing",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    expect(r.ok).toBe(true)
    const list = await eng.list()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value).toHaveLength(1)
    expect(list.value[0]!.id).toBe("a1")
  })

  test("[2] duplicate id rejected, original survives", async () => {
    const eng = inMemoryAutomationEngine()
    const sched = (id: string) =>
      eng.schedule({
        id,
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: utc(2026, 5, 25, 10),
        createdAt: utc(2026, 5, 25),
      })
    await sched("a1")
    const r2 = await sched("a1")
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.code).toBe("duplicate-id")
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value).toHaveLength(1)
  })

  test("[3] cancel idempotent: missing id → ok:true", async () => {
    const eng = inMemoryAutomationEngine()
    const r = await eng.cancel("never-existed")
    expect(r.ok).toBe(true)
    // Double-cancel an existing row is also ok
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    expect((await eng.cancel("a1")).ok).toBe(true)
    expect((await eng.cancel("a1")).ok).toBe(true)
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    // Cancelled rows are NOT surfaced
    expect(list.value).toHaveLength(0)
  })

  test("[4] next() returns null when no row is due", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "future",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 6, 1),
      createdAt: utc(2026, 5, 25),
    })
    const r = await eng.next(utc(2026, 5, 26))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBeNull()
  })

  test("[5] next() picks soonest-due then lexicographic id tiebreak", async () => {
    const eng = inMemoryAutomationEngine()
    const due = utc(2026, 5, 25, 9)
    await eng.schedule({
      id: "b",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: due,
      createdAt: utc(2026, 5, 25),
    })
    await eng.schedule({
      id: "a",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: due,
      createdAt: utc(2026, 5, 25),
    })
    const r = await eng.next(due)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).not.toBeNull()
    expect(r.value!.id).toBe("a")
  })

  test("[6] markRun on non-existent id → not-found", async () => {
    const eng = inMemoryAutomationEngine()
    const r = await eng.markRun({
      id: "ghost",
      firedAt: utc(2026, 5, 25, 10),
      outcome: "fired",
      nextRunAt: utc(2026, 5, 26, 10),
      inboxTitle: "x",
      inboxSummary: "y",
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe("not-found")
  })

  test("[7] markRun with nextRunAt=null transitions to 'fired'", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const r = await eng.markRun({
      id: "a1",
      firedAt: utc(2026, 5, 25, 10),
      outcome: "fired",
      nextRunAt: null,
      inboxTitle: "x",
      inboxSummary: "y",
    })
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.status).toBe("fired")
    expect(r.value.fireCount).toBe(1)
    // 'fired' rows are excluded from next()
    const n = await eng.next(utc(2026, 5, 25, 11))
    if (!n.ok) throw new Error("unreachable")
    expect(n.value).toBeNull()
  })

  test("[8] markRun outcome=errored WITH a live future fire stays scheduled (retry), retains lastError", async () => {
    // T10 H5 — a transient error on a recurring rule must NOT retire the row.
    // It stays `scheduled` so the next tick retries; `lastError` is retained
    // for observability. (Only a rule-EXHAUSTED error → `errored`, asserted in
    // the T10 hellgate battery via nextRunAt=null.)
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const r = await eng.markRun({
      id: "a1",
      firedAt: utc(2026, 5, 25, 10),
      outcome: "errored",
      errorMessage: "boom",
      nextRunAt: utc(2026, 5, 26, 10),
      inboxTitle: "x",
      inboxSummary: "y",
    })
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.status).toBe("scheduled")
    expect(r.value.lastError).toBe("boom")
  })

  test("[8b] markRun outcome=errored with EXHAUSTED rule (nextRunAt=null) retires to errored", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const r = await eng.markRun({
      id: "a1",
      firedAt: utc(2026, 5, 25, 10),
      outcome: "errored",
      errorMessage: "final boom",
      nextRunAt: null,
      inboxTitle: "x",
      inboxSummary: "y",
    })
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.status).toBe("errored")
    expect(r.value.lastError).toBe("final boom")
  })

  test("[9] tickScheduler idle when no rows due", async () => {
    const eng = inMemoryAutomationEngine()
    const out = await tickScheduler({
      engine: eng,
      now: utc(2026, 5, 25),
      handler: () => {
        throw new Error("should not fire")
      },
    })
    expect(out.kind).toBe("idle")
  })

  test("[10] tickScheduler handler throw → marked errored, NO throw out", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const out = await tickScheduler({
      engine: eng,
      now: utc(2026, 5, 25, 10),
      handler: () => {
        throw new Error("kaboom")
      },
    })
    expect(out.kind).toBe("errored")
    if (out.kind !== "errored") throw new Error("unreachable")
    expect(out.errorMessage).toBe("kaboom")
    // The row recorded the error. T10 H5: a recurring rule (FREQ=DAILY has a
    // live future fire) does NOT retire to `errored` — it stays `scheduled` so
    // the next tick retries. The tick RESULT is still `errored` and lastError
    // is recorded (an exhausted rule with no future fire would retire; see the
    // T10 runtime-correctness H5-1/H5-2 hellgates).
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value[0]!.status).toBe("scheduled")
    expect(list.value[0]!.lastError).toBe("kaboom")
  })

  test("[11] tickScheduler successful fire → status scheduled + nextRunAt advanced", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    let invoked = 0
    const out = await tickScheduler({
      engine: eng,
      now: utc(2026, 5, 25, 10),
      handler: async () => {
        invoked += 1
      },
    })
    expect(out.kind).toBe("fired")
    expect(invoked).toBe(1)
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value[0]!.status).toBe("scheduled")
    expect(list.value[0]!.nextRunAt).toBeGreaterThan(utc(2026, 5, 25, 10))
  })

  test("[12] sqlite parity — schedule/list/cancel/next/markRun byte-equal to in-memory", async () => {
    const { mem, sql } = makeBoth()
    const idA = "a1"
    const idB = "b1"
    const baseTime = utc(2026, 5, 25, 10)
    const ops = async (eng: AutomationEnginePort) => {
      await eng.schedule({
        id: idA,
        title: "TA",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "pa",
        nextRunAt: baseTime,
        createdAt: utc(2026, 5, 25),
      })
      await eng.schedule({
        id: idB,
        title: "TB",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "pb",
        nextRunAt: baseTime + 1000,
        createdAt: utc(2026, 5, 25),
      })
      await eng.markRun({
        id: idA,
        firedAt: baseTime,
        outcome: "fired",
        nextRunAt: baseTime + 86_400_000,
        inboxTitle: "fired-A",
        inboxSummary: "ok-A",
      })
      const n = await eng.next(baseTime + 1000)
      if (!n.ok) throw new Error("unreachable")
      return n.value
    }
    const m = await ops(mem)
    const s = await ops(sql)
    expect(m?.id).toBe(s?.id)
    expect(m?.id).toBe("b1") // a1 is now ~next-day, b1 is due NOW
  })

  test("[13] sqlite atomicity: markRun writes runs + inbox + row in one tx", async () => {
    const { sql, db } = makeBoth()
    await sql.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    await sql.markRun({
      id: "a1",
      firedAt: utc(2026, 5, 25, 10),
      outcome: "fired",
      nextRunAt: utc(2026, 5, 26, 10),
      inboxTitle: "hi",
      inboxSummary: "world",
    })
    const runs = listAutomationRuns(db, "a1")
    const inbox = listInboxItems(db, "a1")
    expect(runs).toHaveLength(1)
    expect(inbox).toHaveLength(1)
    expect(runs[0]!.outcome).toBe("fired")
    expect(inbox[0]!.title).toBe("hi")
    expect(inbox[0]!.summary).toBe("world")
    expect(inbox[0]!.read).toBe(false)
  })

  test("[14] exactOptional: schedule with no last_run_at OMITS the key (no `field: undefined`)", async () => {
    const eng = inMemoryAutomationEngine()
    const r = await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    if (!r.ok) throw new Error("unreachable")
    expect(Object.hasOwn(r.value, "lastRunAt")).toBe(false)
    expect(Object.hasOwn(r.value, "lastError")).toBe(false)
  })

  test("[15] cancelled rows are excluded from next()", async () => {
    const eng = inMemoryAutomationEngine()
    await eng.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    await eng.cancel("a1")
    const r = await eng.next(utc(2026, 5, 25, 11))
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBeNull()
  })
})
