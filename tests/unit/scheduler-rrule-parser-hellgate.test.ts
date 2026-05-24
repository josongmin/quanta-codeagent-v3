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

  test("[3] FREQ=HOURLY → unsupported-freq", () => {
    fail("FREQ=HOURLY", "unsupported-freq")
  })

  test("[3b] FREQ=YEARLY → unsupported-freq", () => {
    fail("FREQ=YEARLY", "unsupported-freq")
  })

  test("[3c] FREQ=MINUTELY → unsupported-freq", () => {
    fail("FREQ=MINUTELY", "unsupported-freq")
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
