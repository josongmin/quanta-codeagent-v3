/**
 * ADR-0161 Phase F hellgate — RRULE parser RFC 5545 violations.
 *
 * Every rejection MUST map to one of the closed `RRuleParseErrorCode` arms
 * (`malformed` / `unsupported-freq` / `count-and-until` / `invalid-byday`)
 * so callers can branch deterministically without prose parsing.
 */

import { describe, expect, test } from "bun:test"
import { parseRRule, serializeRRule } from "@/scheduler/rrule-parser"

const fail = (s: string, code: string) => {
  const r = parseRRule(s)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe(code as typeof r.code)
}

describe("parseRRule hellgate", () => {
  test("[1] empty string → malformed", () => {
    fail("", "malformed")
  })

  test("[2] missing FREQ → malformed", () => {
    fail("INTERVAL=1", "malformed")
  })

  test("[3] FREQ=HOURLY → supported (B2)", () => {
    const r = parseRRule("FREQ=HOURLY")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.freq).toBe("HOURLY")
  })

  test("[3b] FREQ=YEARLY → unsupported-freq", () => {
    fail("FREQ=YEARLY", "unsupported-freq")
  })

  test("[3b2] FREQ=SECONDLY → unsupported-freq", () => {
    fail("FREQ=SECONDLY", "unsupported-freq")
  })

  test("[3c] FREQ=MINUTELY → supported (B2)", () => {
    const r = parseRRule("FREQ=MINUTELY")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.freq).toBe("MINUTELY")
  })

  test("[4] COUNT + UNTIL together → count-and-until", () => {
    fail("FREQ=WEEKLY;COUNT=5;UNTIL=20260601T000000Z", "count-and-until")
  })

  test("[5] BYDAY +0MO → invalid-byday", () => {
    fail("FREQ=WEEKLY;BYDAY=+0MO", "invalid-byday")
  })

  test("[6] BYDAY +99MO → invalid-byday", () => {
    fail("FREQ=WEEKLY;BYDAY=+99MO", "invalid-byday")
  })

  test("[7] BYDAY ZZ → invalid-byday", () => {
    fail("FREQ=WEEKLY;BYDAY=ZZ", "invalid-byday")
  })

  test("[8] BYMONTHDAY=0 → malformed", () => {
    fail("FREQ=MONTHLY;BYMONTHDAY=0", "malformed")
  })

  test("[9] BYMONTHDAY=32 → malformed", () => {
    fail("FREQ=MONTHLY;BYMONTHDAY=32", "malformed")
  })

  test("[10] INTERVAL=0 → malformed", () => {
    fail("FREQ=DAILY;INTERVAL=0", "malformed")
  })

  test("[11] INTERVAL=-1 → malformed", () => {
    fail("FREQ=DAILY;INTERVAL=-1", "malformed")
  })

  test("[12] serialize canonicalizes input case", () => {
    const r = parseRRule("freq=weekly;byday=mo,fr")
    if (!r.ok) throw new Error("expected ok")
    expect(serializeRRule(r)).toBe("FREQ=WEEKLY;BYDAY=MO,FR")
  })

  test("[13] idempotent round-trip on complex rule", () => {
    const canonical = "FREQ=MONTHLY;INTERVAL=2;BYDAY=+2MO,-1FR"
    const r1 = parseRRule(canonical)
    if (!r1.ok) throw new Error("r1 expected ok")
    const s1 = serializeRRule(r1)
    expect(s1).toBe(canonical)
    const r2 = parseRRule(s1)
    if (!r2.ok) throw new Error("r2 expected ok")
    expect(serializeRRule(r2)).toBe(canonical)
  })

  test("[14] duplicate key → malformed", () => {
    fail("FREQ=WEEKLY;INTERVAL=1;INTERVAL=2", "malformed")
  })

  test("[15] missing '=' → malformed", () => {
    fail("FREQ=WEEKLY;INTERVAL", "malformed")
  })

  test("[16] empty value → malformed", () => {
    fail("FREQ=WEEKLY;INTERVAL=", "malformed")
  })

  test("[17] unknown key → malformed", () => {
    fail("FREQ=WEEKLY;WKST=MO", "malformed")
  })

  test("[18] UNTIL without trailing Z → malformed", () => {
    fail("FREQ=WEEKLY;UNTIL=20260601T000000", "malformed")
  })

  test("[19] UNTIL with invalid date (Feb 30) → malformed", () => {
    fail("FREQ=WEEKLY;UNTIL=20260230T000000Z", "malformed")
  })

  test("[20] non-string input → malformed", () => {
    // Forced cast to exercise the runtime guard — DI tests pass real strings.
    fail(undefined as unknown as string, "malformed")
  })
})

/* ------------------------------------------------------------------ */
/* merged from scheduler-rrule-parser.test.ts */
/* ------------------------------------------------------------------ */

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
