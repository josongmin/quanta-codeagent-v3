/**
 * ADR-0161 Phase A — Weekday DSL happy paths.
 *
 * Hellgate (zero ordinal / out-of-range / unknown day / month-with-no-Nth)
 * lives in `scheduler-weekday-nth-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import {
  allOccurrencesInMonth,
  nthWeekdayOfMonth,
  parseWeekday,
  serializeWeekday,
} from "@/scheduler/weekday"

describe("parseWeekday / serializeWeekday", () => {
  test("bare weekday", () => {
    expect(parseWeekday("MO")).toEqual({ day: "MO" })
    expect(serializeWeekday({ day: "MO" })).toBe("MO")
  })

  test("positive ordinal", () => {
    expect(parseWeekday("+2MO")).toEqual({ day: "MO", nth: 2 })
    expect(serializeWeekday({ day: "MO", nth: 2 })).toBe("+2MO")
  })

  test("negative ordinal", () => {
    expect(parseWeekday("-1FR")).toEqual({ day: "FR", nth: -1 })
    expect(serializeWeekday({ day: "FR", nth: -1 })).toBe("-1FR")
  })

  test("all weekdays roundtrip", () => {
    for (const d of ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const) {
      const tok = `+3${d}`
      const w = parseWeekday(tok)
      expect(w).toEqual({ day: d, nth: 3 })
      if (w === undefined) throw new Error(`expected parsed weekday for ${tok}`)
      expect(serializeWeekday(w)).toBe(tok)
    }
  })

  test("case-insensitive day token", () => {
    expect(parseWeekday("+2mo")).toEqual({ day: "MO", nth: 2 })
  })
})

describe("nthWeekdayOfMonth", () => {
  test("1st Monday of 2026-05 (=2026-05-04 UTC)", () => {
    const ms = nthWeekdayOfMonth(2026, 5, "MO", 1)
    expect(ms).toBe(Date.UTC(2026, 4, 4))
  })

  test("2nd Wednesday of 2026-05 (=2026-05-13 UTC)", () => {
    const ms = nthWeekdayOfMonth(2026, 5, "WE", 2)
    expect(ms).toBe(Date.UTC(2026, 4, 13))
  })

  test("last Friday of 2026-05 (=2026-05-29)", () => {
    const ms = nthWeekdayOfMonth(2026, 5, "FR", -1)
    expect(ms).toBe(Date.UTC(2026, 4, 29))
  })

  test("last Monday of Feb 2026 (=2026-02-23)", () => {
    const ms = nthWeekdayOfMonth(2026, 2, "MO", -1)
    expect(ms).toBe(Date.UTC(2026, 1, 23))
  })

  test("2nd-to-last Friday of 2026-05 (=2026-05-22)", () => {
    const ms = nthWeekdayOfMonth(2026, 5, "FR", -2)
    expect(ms).toBe(Date.UTC(2026, 4, 22))
  })

  test("5th occurrence exists when month has 5 weekdays", () => {
    // 2026-05 has 5 Fridays (1, 8, 15, 22, 29) → 5th = 2026-05-29.
    const ms = nthWeekdayOfMonth(2026, 5, "FR", 5)
    expect(ms).toBe(Date.UTC(2026, 4, 29))
  })

  test("year boundary — Jan 2027 first Monday", () => {
    // 2027-01-01 is a Friday; first Monday is 2027-01-04.
    const ms = nthWeekdayOfMonth(2027, 1, "MO", 1)
    expect(ms).toBe(Date.UTC(2027, 0, 4))
  })
})

describe("allOccurrencesInMonth", () => {
  test("Mondays of 2026-05 = [4, 11, 18, 25]", () => {
    const out = allOccurrencesInMonth(2026, 5, "MO")
    expect(out).toEqual([
      Date.UTC(2026, 4, 4),
      Date.UTC(2026, 4, 11),
      Date.UTC(2026, 4, 18),
      Date.UTC(2026, 4, 25),
    ])
  })

  test("Fridays of 2026-05 = [1, 8, 15, 22, 29] — 5 occurrences", () => {
    const out = allOccurrencesInMonth(2026, 5, "FR")
    expect(out.length).toBe(5)
  })
})
