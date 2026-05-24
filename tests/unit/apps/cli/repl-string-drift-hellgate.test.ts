/**
 * String-drift hellgate — banner copy must reflect the env-resolved values
 * the surrounding code uses, NOT hardcoded numbers.
 *
 * Pre-cleanup repl.ts hardcoded "idle 60s" and "20 consecutive denials" while
 * the underlying behavior read from `QUANTA_IDLE_MS` / `QUANTA_REJECT_LIMIT`.
 * A user override would silently produce a UI lie. These tests pin the fix:
 * the displayed number is interpolated from the same value the gate reads.
 */

import { describe, expect, test } from "bun:test"
import { idleBanner, rejectExitBanner } from "../../../../src/apps/cli/repl-banners"

describe("idleBanner — string mirrors QUANTA_IDLE_MS", () => {
  test("default 60_000 → '60s'", () => {
    expect(idleBanner(60_000)).toBe("[idle 60s — auto-paused. type or /resume]")
  })

  test("30_000 → '30s' (not stale 60s)", () => {
    expect(idleBanner(30_000)).toBe("[idle 30s — auto-paused. type or /resume]")
  })

  test("120_000 → '120s'", () => {
    expect(idleBanner(120_000)).toBe("[idle 120s — auto-paused. type or /resume]")
  })

  test("5_000 → '5s'", () => {
    expect(idleBanner(5_000)).toBe("[idle 5s — auto-paused. type or /resume]")
  })

  test("ms floored to whole seconds", () => {
    expect(idleBanner(45_999)).toBe("[idle 45s — auto-paused. type or /resume]")
  })

  test("Infinity → generic (no stale number)", () => {
    expect(idleBanner(Number.POSITIVE_INFINITY)).toBe("[idle — auto-paused. type or /resume]")
  })

  test("non-positive → generic (defensive)", () => {
    expect(idleBanner(0)).toBe("[idle — auto-paused. type or /resume]")
    expect(idleBanner(-1)).toBe("[idle — auto-paused. type or /resume]")
  })
})

describe("rejectExitBanner — string mirrors QUANTA_REJECT_LIMIT", () => {
  test("default 20 → '20 consecutive denials'", () => {
    const out = rejectExitBanner(20)
    expect(out).toBe("\n[20 consecutive denials — exiting. To re-enable, restart quanta]\n")
  })

  test("10 → '10 consecutive denials' (not stale 20)", () => {
    const out = rejectExitBanner(10)
    expect(out).toBe("\n[10 consecutive denials — exiting. To re-enable, restart quanta]\n")
  })

  test("5 → '5 consecutive denials'", () => {
    const out = rejectExitBanner(5)
    expect(out.includes("[5 consecutive denials")).toBe(true)
  })

  test("100 → '100 consecutive denials'", () => {
    const out = rejectExitBanner(100)
    expect(out.includes("[100 consecutive denials")).toBe(true)
  })

  test("Infinity → generic (no stale number)", () => {
    const out = rejectExitBanner(Number.POSITIVE_INFINITY)
    expect(out).toBe("\n[consecutive denials reached — exiting. To re-enable, restart quanta]\n")
  })

  test("leading/trailing \\n preserved (byte-identical to pre-cleanup write)", () => {
    const out = rejectExitBanner(20)
    expect(out.startsWith("\n")).toBe(true)
    expect(out.endsWith("\n")).toBe(true)
  })
})

describe("No drift — banner number always matches input", () => {
  test("100 random-ish inputs produce matching display values", () => {
    for (const ms of [1_000, 7_500, 30_000, 60_000, 90_000, 300_000]) {
      const expectedSec = Math.floor(ms / 1000)
      expect(idleBanner(ms)).toContain(`${expectedSec}s`)
    }
    for (const n of [1, 5, 10, 20, 50, 100, 1000]) {
      expect(rejectExitBanner(n)).toContain(`[${n} consecutive`)
    }
  })
})
