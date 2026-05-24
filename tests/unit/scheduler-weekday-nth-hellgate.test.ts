/**
 * ADR-0161 Phase F hellgate — Weekday DSL rejections + nth-occurrence corner cases.
 *
 * Covers: zero ordinal / out-of-range ordinal / unknown day / Feb edge cases
 * (leap + non-leap) / 5th-occurrence missing / year boundary / DST UTC-only.
 */

import { describe, expect, test } from "bun:test"
import { nthWeekdayOfMonth, parseWeekday, serializeWeekday } from "@/scheduler/weekday"

describe("Weekday hellgate", () => {
  test("[1] 5th Monday of Feb 2026 (only 4 Mondays) → undefined", () => {
    expect(nthWeekdayOfMonth(2026, 2, "MO", 5)).toBeUndefined()
  })

  test("[2] 5th Thursday of leap Feb 2024 (Thu 1,8,15,22,29 — 5 Thursdays)", () => {
    // Feb 2024 had 5 Thursdays (1,8,15,22,29). Verify our calendar agrees.
    expect(nthWeekdayOfMonth(2024, 2, "TH", 5)).toBe(Date.UTC(2024, 1, 29))
  })

  test("[3] last Monday of Feb 2026 (= Feb 23)", () => {
    expect(nthWeekdayOfMonth(2026, 2, "MO", -1)).toBe(Date.UTC(2026, 1, 23))
  })

  test("[4] last Thursday of leap Feb 2024 (= Feb 29)", () => {
    expect(nthWeekdayOfMonth(2024, 2, "TH", -1)).toBe(Date.UTC(2024, 1, 29))
  })

  test("[5] 5th Friday of 2026-12 (Fri 4,11,18,25 — only 4 Fridays) → undefined", () => {
    expect(nthWeekdayOfMonth(2026, 12, "FR", 5)).toBeUndefined()
  })

  test("[6] parseWeekday('+0MO') → undefined (zero ordinal RFC violation)", () => {
    expect(parseWeekday("+0MO")).toBeUndefined()
  })

  test("[6b] parseWeekday('-0MO') → undefined", () => {
    expect(parseWeekday("-0MO")).toBeUndefined()
  })

  test("[7] parseWeekday('+6MO') → undefined (>5)", () => {
    expect(parseWeekday("+6MO")).toBeUndefined()
  })

  test("[7b] parseWeekday('-6MO') → undefined (-N out of range)", () => {
    expect(parseWeekday("-6MO")).toBeUndefined()
  })

  test("[8] parseWeekday('+1XX') → undefined (bad day)", () => {
    expect(parseWeekday("+1XX")).toBeUndefined()
  })

  test("[9] parseWeekday('MO') → bare (nth absent, key omitted)", () => {
    const w = parseWeekday("MO")
    expect(w).toEqual({ day: "MO" })
    expect("nth" in (w as object)).toBe(false)
  })

  test("[10] parseWeekday('+2MO') → {day,nth}", () => {
    expect(parseWeekday("+2MO")).toEqual({ day: "MO", nth: 2 })
  })

  test("[11] parseWeekday('-1FR') → {day:'FR', nth:-1}", () => {
    expect(parseWeekday("-1FR")).toEqual({ day: "FR", nth: -1 })
  })

  test("[12] nthWeekdayOfMonth(2026, 13, 'MO', 1) — month overflow → undefined", () => {
    expect(nthWeekdayOfMonth(2026, 13, "MO", 1)).toBeUndefined()
  })

  test("[12b] month = 0 → undefined", () => {
    expect(nthWeekdayOfMonth(2026, 0, "MO", 1)).toBeUndefined()
  })

  test("[13] DST irrelevance — all results are UTC midnight", () => {
    // The 2026-03-08 02:00 US Eastern spring-forward must NOT shift our
    // result (we are UTC-only). 2nd Sunday of March 2026 = 2026-03-08.
    expect(nthWeekdayOfMonth(2026, 3, "SU", 2)).toBe(Date.UTC(2026, 2, 8))
  })

  test("[14] non-integer nth → undefined", () => {
    expect(nthWeekdayOfMonth(2026, 5, "MO", 1.5)).toBeUndefined()
  })

  test("[15] parseWeekday(empty string) → undefined", () => {
    expect(parseWeekday("")).toBeUndefined()
  })

  test("[16] parseWeekday('+MO') (sign without digit) → undefined", () => {
    expect(parseWeekday("+MO")).toBeUndefined()
  })

  test("[17] serialize round-trip", () => {
    expect(serializeWeekday({ day: "MO" })).toBe("MO")
    expect(serializeWeekday({ day: "MO", nth: 2 })).toBe("+2MO")
    expect(serializeWeekday({ day: "FR", nth: -1 })).toBe("-1FR")
  })
})
