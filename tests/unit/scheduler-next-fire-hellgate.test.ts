/**
 * ADR-0161 Phase F hellgate — Schedule evaluator corner cases.
 *
 * never-fire / past until / DST UTC-invariance / count exhaustion / month
 * overflow boundaries.
 */

import { describe, expect, test } from "bun:test"
import { computeNextFire, iterateFires } from "@/scheduler/next-fire"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const r = (s: string): RRule => {
  const parsed = parseRRule(s)
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.code}`)
  const { ok: _ok, ...rest } = parsed
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s)

describe("computeNextFire hellgate", () => {
  test("[1] UNTIL past → never", () => {
    const next = computeNextFire(r("FREQ=DAILY;UNTIL=20250101T000000Z"), utc(2026, 5, 10), 0)
    expect(next).toBe("never")
  })

  test("[2] COUNT reached → never", () => {
    const next = computeNextFire(r("FREQ=DAILY;COUNT=3"), utc(2026, 5, 10), 3)
    expect(next).toBe("never")
  })

  test("[3] COUNT not reached → fires", () => {
    const next = computeNextFire(r("FREQ=DAILY;COUNT=3"), utc(2026, 5, 10), 2)
    expect(next).toBe(utc(2026, 5, 11))
  })

  test("[4] from-day is last fire (count=3, fired=2) → fires once more", () => {
    const gen = iterateFires(r("FREQ=DAILY;COUNT=2"), utc(2026, 5, 1))
    const out: number[] = []
    for (const f of gen) out.push(f)
    expect(out.length).toBe(2)
  })

  test("[5] WEEKLY past UNTIL → never", () => {
    const next = computeNextFire(r("FREQ=WEEKLY;UNTIL=20260101T000000Z"), utc(2026, 5, 10), 0)
    expect(next).toBe("never")
  })

  test("[6] MONTHLY past UNTIL → never", () => {
    const next = computeNextFire(r("FREQ=MONTHLY;UNTIL=20260101T000000Z"), utc(2026, 5, 10), 0)
    expect(next).toBe("never")
  })

  test("[7] from EXACTLY on fire instant → returns NEXT (strict >)", () => {
    const next = computeNextFire(r("FREQ=DAILY"), utc(2026, 5, 10, 9, 0), 0)
    expect(next).toBe(utc(2026, 5, 11, 9, 0))
    // For weekly the strict > also holds — Friday from a Friday → next Friday.
    const wk = computeNextFire(r("FREQ=WEEKLY;BYDAY=FR"), utc(2026, 5, 1), 0)
    expect(wk).toBe(utc(2026, 5, 8))
  })

  test("[8] DST UTC-invariance — fires at the same UTC ms regardless of TZ", () => {
    // US Eastern spring-forward: 2026-03-08 02:00 local → 03:00 local. UTC
    // is unaffected. A DAILY rule starting before the boundary still fires
    // at the same UTC ms every 24h.
    const next = computeNextFire(r("FREQ=DAILY"), utc(2026, 3, 7, 12), 0)
    expect(next).toBe(utc(2026, 3, 8, 12))
  })

  test("[9] year boundary — MONTHLY from Dec 31 → Jan 31", () => {
    const next = computeNextFire(r("FREQ=MONTHLY"), utc(2026, 12, 31, 12), 0)
    expect(next).toBe(utc(2027, 1, 31, 12))
  })

  test("[10] MONTHLY BYMONTHDAY=31 from Jan 31 → next is Mar 31 (skips Feb)", () => {
    const next = computeNextFire(r("FREQ=MONTHLY;BYMONTHDAY=31"), utc(2026, 1, 31), 0)
    expect(next).toBe(utc(2026, 3, 31))
  })

  test("[11] MONTHLY BYDAY=+5MO in Feb 2026 — skips to Mar", () => {
    const next = computeNextFire(r("FREQ=MONTHLY;BYDAY=+5MO"), utc(2026, 2, 1), 0)
    expect(next).toBe(utc(2026, 3, 30))
  })

  test("[12] WEEKLY BYDAY=MO,WE,FR — three fires per week", () => {
    const gen = iterateFires(r("FREQ=WEEKLY;BYDAY=MO,WE,FR"), utc(2026, 5, 3)) // Sunday
    // Mon 5/4, Wed 5/6, Fri 5/8, Mon 5/11, ...
    const out: number[] = []
    let count = 0
    for (const f of gen) {
      out.push(f)
      count += 1
      if (count >= 4) break
    }
    expect(out).toEqual([utc(2026, 5, 4), utc(2026, 5, 6), utc(2026, 5, 8), utc(2026, 5, 11)])
  })

  test("[13] DAILY INTERVAL=2 produces every-other-day series", () => {
    const gen = iterateFires(r("FREQ=DAILY;INTERVAL=2"), utc(2026, 5, 1))
    const out: number[] = []
    let count = 0
    for (const f of gen) {
      out.push(f)
      count += 1
      if (count >= 3) break
    }
    expect(out).toEqual([utc(2026, 5, 3), utc(2026, 5, 5), utc(2026, 5, 7)])
  })

  test("[14] iterator with UNTIL bound — yields nothing if UNTIL already past", () => {
    const gen = iterateFires(r("FREQ=DAILY;UNTIL=20250101T000000Z"), utc(2026, 5, 1))
    expect(gen.next().done).toBe(true)
  })
})
