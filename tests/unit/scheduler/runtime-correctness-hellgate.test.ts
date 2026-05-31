/**
 * T10 — Scheduler Runtime Correctness hellgate (bugbash may-31 L9
 * H5/M7/M8/M9/M10/M11).
 *
 * Proof rail = restart/replay tests for retry + dedup + same-timestamp
 * collision. Owning seam = ONE idempotent `claim -> execute -> finalize`
 * run model keyed by stable run identity with durable run markers.
 *
 * Battery (all RED before T10 lands):
 *
 *   H5  — errored automation with a live future fire stays `scheduled`
 *         (retries next tick); only a rule-exhausted error retires to
 *         `errored`. Restart replay proves the retry survives.
 *   M8  — same-ms double-fire (overlapping tick / manual+timer) does NOT
 *         UNIQUE-collide → no tx rollback → no refire. in-memory + sqlite
 *         engines stay byte-equal under same-ms refire.
 *   M11 — ticker overlap: two `claim()` calls in the same instant return
 *         DISJOINT rows (the in-flight row is durably marked `running`),
 *         so a due row is never double-executed.
 *   claim/finalize — a claimed-but-not-finalized row (crash mid-handler)
 *         is recoverable: after restart it is reclaimable and retries.
 *   M9  — JSONL load error (EACCES, not ENOENT) is a FIRST-CLASS error
 *         (observable via sink), not collapsed to `[]`. delete tombstone
 *         append failure is surfaced, not swallowed.
 *   M10 — error-state persistence failure is observable (sink), never a
 *         silent swallow that leaves the row `active` to refire forever.
 *   M7  — runtime persists BEFORE dispatch (or carries an explicit
 *         idempotency anchor) so a crash between dispatch and save does
 *         not re-dispatch a mutating prompt.
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type AutomationEnginePort,
  inMemoryAutomationEngine,
  listAutomationRuns,
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

const seed = async (eng: AutomationEnginePort, id: string, nextRunAt: number, ruleStr = "FREQ=DAILY") => {
  const r = await eng.schedule({
    id,
    title: "T",
    rule: ruleOf(ruleStr),
    prompt: "p",
    nextRunAt,
    createdAt: utc(2026, 5, 1),
  })
  if (!r.ok) throw new Error(`seed failed: ${r.message}`)
}

describe("T10 H5 — errored automation retries (does not die permanently)", () => {
  test("[H5-1] handler throw on a recurring rule leaves status=scheduled with advanced nextRunAt", async () => {
    const eng = inMemoryAutomationEngine()
    await seed(eng, "a1", utc(2026, 5, 25, 10))
    const out = await tickScheduler({
      engine: eng,
      now: utc(2026, 5, 25, 10),
      handler: () => {
        throw new Error("transient boom")
      },
    })
    expect(out.kind).toBe("errored")
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    const row = list.value[0]!
    // RETRY contract: a recurring automation is NOT retired by one failure.
    expect(row.status).toBe("scheduled")
    expect(row.lastError).toBe("transient boom")
    expect(row.nextRunAt).toBeGreaterThan(utc(2026, 5, 25, 10))
    // It is still pickable by next() (i.e. it will retry).
    const n = await eng.next(row.nextRunAt)
    if (!n.ok) throw new Error("unreachable")
    expect(n.value?.id).toBe("a1")
  })

  test("[H5-2] handler throw on an EXHAUSTED rule (no future fire) retires to errored", async () => {
    const eng = inMemoryAutomationEngine()
    // COUNT=1 → after fireCount reaches 1, computeNextFire → never → nextRunAt null.
    await seed(eng, "a1", utc(2026, 5, 25, 10), "FREQ=DAILY;COUNT=1")
    const out = await tickScheduler({
      engine: eng,
      now: utc(2026, 5, 25, 10),
      handler: () => {
        throw new Error("final boom")
      },
    })
    expect(out.kind).toBe("errored")
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value[0]!.status).toBe("errored")
  })

  test("[H5-3] sqlite parity: errored+future stays scheduled, errored+exhausted retires", async () => {
    const db = new Database(":memory:")
    const eng = sqliteAutomationEngine(db)
    await seed(eng, "rec", utc(2026, 5, 25, 10))
    await seed(eng, "fin", utc(2026, 5, 25, 10), "FREQ=DAILY;COUNT=1")
    const throwHandler = () => {
      throw new Error("x")
    }
    await tickScheduler({ engine: eng, now: utc(2026, 5, 25, 10), handler: throwHandler })
    await tickScheduler({ engine: eng, now: utc(2026, 5, 25, 10), handler: throwHandler })
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    const rec = list.value.find((a) => a.id === "rec")!
    const fin = list.value.find((a) => a.id === "fin")!
    expect(rec.status).toBe("scheduled")
    expect(fin.status).toBe("errored")
  })

  test("[H5-4] restart replay: errored recurring automation retries after a fresh engine reload", async () => {
    const db = new Database(":memory:")
    const eng1 = sqliteAutomationEngine(db)
    await seed(eng1, "a1", utc(2026, 5, 25, 10))
    await tickScheduler({
      engine: eng1,
      now: utc(2026, 5, 25, 10),
      handler: () => {
        throw new Error("boom-before-restart")
      },
    })
    // Simulate a process restart: a brand-new engine over the SAME db file.
    const eng2 = sqliteAutomationEngine(db)
    const list = await eng2.list()
    if (!list.ok) throw new Error("unreachable")
    const row = list.value[0]!
    expect(row.status).toBe("scheduled")
    // The next fire is due → it retries.
    const n = await eng2.next(row.nextRunAt)
    if (!n.ok) throw new Error("unreachable")
    expect(n.value?.id).toBe("a1")
  })
})

describe("T10 M8/M11 — same-ms dedup + ticker-overlap claim isolation", () => {
  test("[M8-1] sqlite same-ms double finalize does NOT collide / rollback / refire", async () => {
    const db = new Database(":memory:")
    const eng = sqliteAutomationEngine(db)
    await seed(eng, "a1", utc(2026, 5, 25, 10))
    const now = utc(2026, 5, 25, 10)
    // Two finalize-class writes at the SAME firedAt ms. The id allocator MUST
    // disambiguate (monotonic nonce) so the second insert cannot UNIQUE-collide.
    await tickScheduler({ engine: eng, now, handler: async () => {} })
    const r2 = await eng.markRun({
      id: "a1",
      firedAt: now,
      outcome: "fired",
      nextRunAt: now + 1000,
      inboxTitle: "t",
      inboxSummary: "s",
    })
    expect(r2.ok).toBe(true)
    const runs = listAutomationRuns(db, "a1")
    // Two distinct run rows recorded — no rollback, no lost run.
    expect(runs.length).toBe(2)
    expect(new Set(runs.map((r) => r.id)).size).toBe(2)
  })

  test("[M8-2] in-memory + sqlite stay byte-equal under same-ms refire (parity)", async () => {
    const mem = inMemoryAutomationEngine()
    const db = new Database(":memory:")
    const sql = sqliteAutomationEngine(db)
    const now = utc(2026, 5, 25, 10)
    const run = async (eng: AutomationEnginePort) => {
      await seed(eng, "a1", now)
      await tickScheduler({ engine: eng, now, handler: async () => {} })
      await tickScheduler({ engine: eng, now, handler: async () => {} })
      const list = await eng.list()
      if (!list.ok) throw new Error("unreachable")
      return list.value[0]!
    }
    const m = await run(mem)
    const s = await run(sql)
    expect(m.status).toBe(s.status)
    expect(m.fireCount).toBe(s.fireCount)
    expect(m.nextRunAt).toBe(s.nextRunAt)
  })

  test("[M11-1] two claims in the same instant return DISJOINT rows (no double-execution)", async () => {
    const eng = inMemoryAutomationEngine()
    const now = utc(2026, 5, 25, 10)
    await seed(eng, "a", now)
    await seed(eng, "b", now)
    // Overlapping ticker: claim twice WITHOUT finalizing in between.
    const c1 = await eng.claim(now)
    const c2 = await eng.claim(now)
    if (!c1.ok || !c2.ok) throw new Error("claim failed")
    expect(c1.value).not.toBeNull()
    expect(c2.value).not.toBeNull()
    // Disjoint — the in-flight row is durably marked and not re-handed-out.
    expect(c1.value!.automation.id).not.toBe(c2.value!.automation.id)
    // A third claim returns null — both due rows are now in-flight.
    const c3 = await eng.claim(now)
    if (!c3.ok) throw new Error("unreachable")
    expect(c3.value).toBeNull()
  })

  test("[M11-2] sqlite: claim atomically excludes an in-flight row from a concurrent claim", async () => {
    const db = new Database(":memory:")
    const eng = sqliteAutomationEngine(db)
    const now = utc(2026, 5, 25, 10)
    await seed(eng, "only", now)
    const c1 = await eng.claim(now)
    const c2 = await eng.claim(now)
    if (!c1.ok || !c2.ok) throw new Error("claim failed")
    expect(c1.value).not.toBeNull()
    expect(c2.value).toBeNull() // single due row, claimed once
  })

  test("[claim-1] a claimed row can be finalized by claim token; finalize advances + records run", async () => {
    const db = new Database(":memory:")
    const eng = sqliteAutomationEngine(db)
    const now = utc(2026, 5, 25, 10)
    await seed(eng, "a1", now)
    const c = await eng.claim(now)
    if (!c.ok || c.value === null) throw new Error("claim failed")
    const fin = await eng.finalize({
      id: "a1",
      claimToken: c.value.claimToken,
      firedAt: now,
      outcome: "fired",
      nextRunAt: now + 86_400_000,
      inboxTitle: "t",
      inboxSummary: "s",
    })
    expect(fin.ok).toBe(true)
    const runs = listAutomationRuns(db, "a1")
    expect(runs.length).toBe(1)
    const list = await eng.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value[0]!.status).toBe("scheduled")
    expect(list.value[0]!.nextRunAt).toBe(now + 86_400_000)
  })

  test("[claim-2] crash recovery: a claimed-but-unfinalized row is reclaimable after restart", async () => {
    const db = new Database(":memory:")
    const eng1 = sqliteAutomationEngine(db)
    const now = utc(2026, 5, 25, 10)
    await seed(eng1, "a1", now)
    const c = await eng1.claim(now)
    if (!c.ok || c.value === null) throw new Error("claim failed")
    // Process dies here — no finalize. Restart:
    const eng2 = sqliteAutomationEngine(db)
    // A stale claim older than the reclaim window is re-offered.
    const reclaimed = await eng2.claim(now, { reclaimBefore: now })
    if (!reclaimed.ok) throw new Error("unreachable")
    expect(reclaimed.value?.automation.id).toBe("a1")
  })

  test("[claim-3] finalize with a STALE claim token is rejected (another worker owns it)", async () => {
    const eng = inMemoryAutomationEngine()
    const now = utc(2026, 5, 25, 10)
    await seed(eng, "a1", now)
    const c = await eng.claim(now)
    if (!c.ok || c.value === null) throw new Error("claim failed")
    const bad = await eng.finalize({
      id: "a1",
      claimToken: `${c.value.claimToken}-WRONG`,
      firedAt: now,
      outcome: "fired",
      nextRunAt: now + 1000,
      inboxTitle: "t",
      inboxSummary: "s",
    })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error("unreachable")
    expect(bad.code).toBe("not-found")
  })
})
