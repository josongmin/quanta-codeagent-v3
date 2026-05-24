/**
 * ADR-0161 Phase A — RRULE parser happy paths + idempotency.
 *
 * The malformed / RFC-violating cases live in
 * `scheduler-rrule-parser-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { parseRRule, serializeRRule } from "@/scheduler/rrule-parser"

const ok = (s: string) => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`expected parse OK, got ${r.code}: ${r.message}`)
  return r
}

describe("parseRRule — happy paths", () => {
  test("daily, freq only", () => {
    const r = ok("FREQ=DAILY")
    expect(r.freq).toBe("DAILY")
    expect(r.interval).toBeUndefined()
    expect(r.count).toBeUndefined()
    expect(r.until).toBeUndefined()
    expect(r.byDay).toBeUndefined()
    expect(r.byMonthDay).toBeUndefined()
  })

  test("weekly with interval", () => {
    const r = ok("FREQ=WEEKLY;INTERVAL=2")
    expect(r.freq).toBe("WEEKLY")
    expect(r.interval).toBe(2)
  })

  test("weekly with count", () => {
    const r = ok("FREQ=WEEKLY;COUNT=5")
    expect(r.count).toBe(5)
    expect(r.until).toBeUndefined()
  })

  test("weekly with until (UTC)", () => {
    const r = ok("FREQ=WEEKLY;UNTIL=20260601T000000Z")
    expect(r.until).toBe(Date.UTC(2026, 5, 1, 0, 0, 0))
    expect(r.count).toBeUndefined()
  })

  test("weekly byDay list", () => {
    const r = ok("FREQ=WEEKLY;BYDAY=MO,WE,FR")
    expect(r.byDay).toEqual([{ day: "MO" }, { day: "WE" }, { day: "FR" }])
  })

  test("monthly nth-occurrence byDay", () => {
    const r = ok("FREQ=MONTHLY;BYDAY=+2MO,-1FR")
    expect(r.byDay).toEqual([
      { day: "MO", nth: 2 },
      { day: "FR", nth: -1 },
    ])
  })

  test("monthly byMonthDay", () => {
    const r = ok("FREQ=MONTHLY;BYMONTHDAY=1,15,28")
    expect(r.byMonthDay).toEqual([1, 15, 28])
  })

  test("case-insensitive keys, weekday upper-case-normalized", () => {
    const r = ok("freq=monthly;byday=mo,we;bymonthday=15")
    expect(r.freq).toBe("MONTHLY")
    expect(r.byDay).toEqual([{ day: "MO" }, { day: "WE" }])
  })
})

describe("serializeRRule + round-trip", () => {
  test("freq only — canonical", () => {
    const r = ok("FREQ=DAILY")
    expect(serializeRRule(r)).toBe("FREQ=DAILY")
  })

  test("preserves all set keys in canonical order", () => {
    const s = "FREQ=MONTHLY;INTERVAL=2;BYDAY=+2MO,-1FR;BYMONTHDAY=15"
    const r = ok(s)
    expect(serializeRRule(r)).toBe(s)
  })

  test("idempotent round-trip", () => {
    const inputs = [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      "FREQ=MONTHLY;BYDAY=-1FR;INTERVAL=3",
      "FREQ=WEEKLY;COUNT=10",
      "FREQ=WEEKLY;UNTIL=20260601T120000Z",
    ]
    for (const input of inputs) {
      const r1 = ok(input)
      const s1 = serializeRRule(r1)
      const r2 = ok(s1)
      expect(serializeRRule(r2)).toBe(s1)
    }
  })

  test("UNTIL ms preserved across round-trip", () => {
    const r = ok("FREQ=WEEKLY;UNTIL=20261231T235959Z")
    const s = serializeRRule(r)
    expect(s).toBe("FREQ=WEEKLY;UNTIL=20261231T235959Z")
  })
})
