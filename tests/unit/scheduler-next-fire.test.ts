/**
 * ADR-0161 Phase B — Schedule evaluator happy paths.
 *
 * Hellgate (DST / never-fire / count=0 / past-until / interval=0 fallback /
 * year overflow) lives in `scheduler-next-fire-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { computeNextFire, iterateFires } from "@/scheduler/next-fire"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const r = (s: string): RRule => {
  const parsed = parseRRule(s)
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.code}`)
  // Strip `ok: true` discriminator — RRule fields only.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ok: _ok, ...rest } = parsed
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s)

describe("computeNextFire — DAILY", () => {
  test("daily next is +1 day", () => {
    const fire = computeNextFire(r("FREQ=DAILY"), utc(2026, 5, 10, 9, 0), 0)
    expect(fire).toBe(utc(2026, 5, 11, 9, 0))
  })

  test("daily INTERVAL=2 — every other day", () => {
    const next1 = computeNextFire(r("FREQ=DAILY;INTERVAL=2"), utc(2026, 5, 10), 0)
    expect(next1).toBe(utc(2026, 5, 12))
  })

  test("daily BYDAY=MO from Friday → next Monday", () => {
    const next = computeNextFire(r("FREQ=DAILY;BYDAY=MO"), utc(2026, 5, 8), 0)
    // 2026-05-08 is Friday; next Monday is 2026-05-11.
    expect(next).toBe(utc(2026, 5, 11))
  })
})

describe("computeNextFire — WEEKLY", () => {
  test("weekly default — next week same weekday", () => {
    // 2026-05-10 is a Sunday.
    const next = computeNextFire(r("FREQ=WEEKLY"), utc(2026, 5, 10), 0)
    expect(next).toBe(utc(2026, 5, 17))
  })

  test("weekly BYDAY=MO,WE,FR from a Sunday → next Monday", () => {
    // 2026-05-10 Sunday → next Monday 2026-05-11.
    const next = computeNextFire(r("FREQ=WEEKLY;BYDAY=MO,WE,FR"), utc(2026, 5, 10), 0)
    expect(next).toBe(utc(2026, 5, 11))
  })

  test("weekly BYDAY=FR — fires every Friday only", () => {
    const gen = iterateFires(r("FREQ=WEEKLY;BYDAY=FR"), utc(2026, 5, 1))
    // 2026-05-01 is Friday; strict `>` so next is 2026-05-08.
    expect(gen.next().value).toBe(utc(2026, 5, 8))
    expect(gen.next().value).toBe(utc(2026, 5, 15))
    expect(gen.next().value).toBe(utc(2026, 5, 22))
  })
})

describe("computeNextFire — MONTHLY", () => {
  test("monthly default — same day-of-month next month", () => {
    const next = computeNextFire(r("FREQ=MONTHLY"), utc(2026, 5, 15, 12), 0)
    expect(next).toBe(utc(2026, 6, 15, 12))
  })

  test("monthly BYMONTHDAY=31 in Feb → skip to Mar 31", () => {
    const next = computeNextFire(r("FREQ=MONTHLY;BYMONTHDAY=31"), utc(2026, 1, 31), 0)
    expect(next).toBe(utc(2026, 3, 31))
  })

  test("monthly BYDAY=+5MO in Feb 2026 (no 5th Monday) → skip to Mar", () => {
    // Feb 2026 has 4 Mondays; March 2026 has 5 (2, 9, 16, 23, 30).
    const next = computeNextFire(r("FREQ=MONTHLY;BYDAY=+5MO"), utc(2026, 2, 1), 0)
    expect(next).toBe(utc(2026, 3, 30))
  })

  test("monthly BYDAY=-1FR — last Friday of every month", () => {
    const next = computeNextFire(r("FREQ=MONTHLY;BYDAY=-1FR"), utc(2026, 5, 1), 0)
    // Last Friday of May 2026 = 2026-05-29.
    expect(next).toBe(utc(2026, 5, 29))
  })
})

describe("iterateFires", () => {
  test("COUNT bound — yields exactly N fires", () => {
    const gen = iterateFires(r("FREQ=DAILY;COUNT=3"), utc(2026, 5, 1))
    const out: number[] = []
    for (const f of gen) out.push(f)
    // computeNextFire enforces count via fireCount — but iterator emits at
    // most COUNT items by managing fireCount internally.
    expect(out.length).toBe(3)
    expect(out[0]).toBe(utc(2026, 5, 2))
    expect(out[2]).toBe(utc(2026, 5, 4))
  })

  test("UNTIL bound — stops at UNTIL", () => {
    const gen = iterateFires(r("FREQ=DAILY;UNTIL=20260505T000000Z"), utc(2026, 5, 1))
    const out: number[] = []
    for (const f of gen) out.push(f)
    expect(out).toEqual([utc(2026, 5, 2), utc(2026, 5, 3), utc(2026, 5, 4), utc(2026, 5, 5)])
  })
})

describe("strict `>` boundary", () => {
  test("from exactly on a fire boundary → returns NEXT", () => {
    // Daily — from is itself a fire candidate, next must be tomorrow.
    const next = computeNextFire(r("FREQ=DAILY"), utc(2026, 5, 10, 9), 0)
    expect(next).toBe(utc(2026, 5, 11, 9))
  })
})
