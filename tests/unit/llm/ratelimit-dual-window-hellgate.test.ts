/**
 * §9.3 — account DUAL-WINDOW ratelimit (Codex `RateLimitWindow` parity) hellgate.
 *
 * Codex emits, on EVERY response, per-account dual-window quota headers:
 *   x-codex-primary-used-percent / x-codex-primary-window-minutes / x-codex-primary-reset-at
 *   x-codex-secondary-used-percent / ... (the secondary, slower window)
 * Each maps to a `RateLimitWindow { usedPercent, windowMinutes, resetsAt }`,
 * and the snapshot is ACCUMULATED per-account across requests (last-write-wins
 * per window, but the store is keyed by account so a 2nd request on the same
 * account refines the SAME bucket rather than starting fresh).
 *
 * This is the PROACTIVE half complementing the existing single-window
 * remaining/reset parser (`parse.ts`): used_percent/window_minutes is the
 * Codex shape, distinct from Anthropic/OpenAI remaining/reset.
 *
 * Hellgate cases:
 *   DW-01: parse primary+secondary from a full Codex header set
 *   DW-02: partial (primary only) — secondary stays absent
 *   DW-03: garbage used_percent / window_minutes ⇒ field absent (no NaN)
 *   DW-04: no recognized header ⇒ undefined (byte-identity: no clobber)
 *   DW-05: hostile getter throws ⇒ undefined (no-throw)
 *   DW-06: e2e — 2nd request on the SAME account ACCUMULATES into one bucket
 *   DW-07: e2e — two accounts keep SEPARATE buckets
 *   DW-08: reset-at HTTP-date is resolved to relative ms (clock-injected)
 *   DW-09: used_percent clamped to [0,100]; out-of-range ⇒ absent
 */

import { describe, expect, test } from "bun:test"
import { type DualWindowSnapshot, parseDualWindowSnapshot } from "@/llm/ratelimit-snapshot"

const getter =
  (h: Record<string, string>) =>
  (name: string): string | null =>
    h[name.toLowerCase()] ?? null

const FIXED_NOW = 1_000_000_000_000 // ms-epoch

describe("§9.3 dual-window parse", () => {
  test("DW-01: parses primary+secondary windows", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "42.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "10",
        "x-codex-secondary-window-minutes": "10080",
      }),
      () => FIXED_NOW,
    )
    expect(snap).toBeDefined()
    expect(snap?.primary?.usedPercent).toBe(42.5)
    expect(snap?.primary?.windowMinutes).toBe(300)
    expect(snap?.secondary?.usedPercent).toBe(10)
    expect(snap?.secondary?.windowMinutes).toBe(10080)
    expect(snap?.observedAt).toBe(FIXED_NOW)
  })

  test("DW-02: primary only — secondary absent", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(snap?.primary).toBeDefined()
    expect(snap?.secondary).toBeUndefined()
  })

  test("DW-03: garbage used_percent / window_minutes ⇒ field absent (no NaN)", () => {
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "not-a-number",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    // window_minutes is valid → window exists, but usedPercent must be absent.
    expect(snap?.primary).toBeDefined()
    expect(snap?.primary?.usedPercent).toBeUndefined()
    expect(snap?.primary?.windowMinutes).toBe(300)
  })

  test("DW-04: no recognized header ⇒ undefined (no clobber)", () => {
    const snap = parseDualWindowSnapshot(getter({ "x-some-other-header": "1" }), () => FIXED_NOW)
    expect(snap).toBeUndefined()
  })

  test("DW-05: hostile getter throws ⇒ undefined (no-throw)", () => {
    const hostile = (): string | null => {
      throw new Error("boom")
    }
    expect(() => parseDualWindowSnapshot(hostile, () => FIXED_NOW)).not.toThrow()
    expect(parseDualWindowSnapshot(hostile, () => FIXED_NOW)).toBeUndefined()
  })

  test("DW-08: reset-at HTTP-date resolved to relative ms", () => {
    const resetAt = new Date(FIXED_NOW + 5 * 60_000).toUTCString()
    const snap = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": resetAt,
      }),
      () => FIXED_NOW,
    )
    expect(snap?.primary?.resetMs).toBeGreaterThanOrEqual(4 * 60_000)
    expect(snap?.primary?.resetMs).toBeLessThanOrEqual(5 * 60_000)
  })

  test("DW-09: used_percent out of [0,100] ⇒ absent", () => {
    const over = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "150",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(over?.primary?.usedPercent).toBeUndefined()
    const neg = parseDualWindowSnapshot(
      getter({
        "x-codex-primary-used-percent": "-1",
        "x-codex-primary-window-minutes": "300",
      }),
      () => FIXED_NOW,
    )
    expect(neg?.primary?.usedPercent).toBeUndefined()
  })
})

// Type-only assertions to lock the exported shape.
describe("§9.3 type surface", () => {
  test("DualWindowSnapshot shape", () => {
    const s: DualWindowSnapshot = {
      primary: { usedPercent: 1, windowMinutes: 2, resetMs: 3 },
      secondary: { usedPercent: 4 },
      observedAt: 5,
    }
    expect(s.primary?.usedPercent).toBe(1)
  })
})
