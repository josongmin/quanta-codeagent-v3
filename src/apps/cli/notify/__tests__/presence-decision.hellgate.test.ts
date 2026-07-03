/**
 * B5 (jul-04) HELLGATE — pure presence-FROM-SIGNALS decision.
 *
 * B5 shipped CLI-only: `isUserPresent = () => !idle.isIdle()` — an activity-only
 * probe with no surface-portable core. This extracts the presence DECISION to a
 * pure helper both the CLI and the web can reuse:
 *
 *   present = tabVisible AND recentlyActive
 *
 * where `recentlyActive = (now - lastActivityAt) < thresholdMs` mirrors the CLI
 * IdleMonitor's `!isIdle()` window (`QUANTA_IDLE_MS`), and `tabVisible` is the
 * ADDITIONAL web signal (`document.visibilityState === "visible"`). The CLI has
 * no tab, so it passes `tabVisible: true` ⇒ activity-only, byte-identical to the
 * legacy `!isIdle()`.
 *
 * A backgrounded/hidden tab means the user has LOOKED AWAY even if they typed a
 * millisecond ago — so visibility gates presence. This is exactly the competitor
 * "suppress the push while the user is present" semantics, extended with the web
 * visibility signal the CLI never had.
 *
 * Pure: `now` and `lastActivityAt` are injected epoch-ms; no clock, no DOM.
 */

import { describe, expect, test } from "bun:test"
import { computePresence, type PresenceSignals } from "../presence-decision"

const base = (over: Partial<PresenceSignals> = {}): PresenceSignals => ({
  tabVisible: true,
  lastActivityAt: 1_000,
  now: 1_000,
  thresholdMs: 60_000,
  ...over,
})

describe("B5 computePresence — activity window (mirrors CLI !isIdle)", () => {
  test("PD-01: just-active + visible ⇒ present", () => {
    expect(computePresence(base({ now: 1_000, lastActivityAt: 1_000 }))).toBe(true)
  })

  test("PD-02: active within threshold ⇒ present", () => {
    // 59s since activity, threshold 60s ⇒ still present.
    expect(computePresence(base({ now: 60_000, lastActivityAt: 1_000 }))).toBe(true)
  })

  test("PD-03: away exactly at threshold ⇒ absent (>= is idle, matching IdleMonitor)", () => {
    // 60_000ms elapsed, threshold 60_000 ⇒ isIdle true ⇒ NOT present.
    expect(computePresence(base({ now: 61_000, lastActivityAt: 1_000 }))).toBe(false)
  })

  test("PD-04: away beyond threshold ⇒ absent", () => {
    expect(computePresence(base({ now: 200_000, lastActivityAt: 1_000 }))).toBe(false)
  })
})

describe("B5 computePresence — visibility gate (web-only signal)", () => {
  test("PD-05: hidden tab ⇒ absent even if just-active", () => {
    expect(computePresence(base({ tabVisible: false, now: 1_000, lastActivityAt: 1_000 }))).toBe(
      false,
    )
  })

  test("PD-06: visible tab is REQUIRED — visibility ANDs with activity", () => {
    // Active but hidden ⇒ absent; visible but stale ⇒ absent; both ⇒ present.
    expect(computePresence(base({ tabVisible: false, now: 1_000, lastActivityAt: 1_000 }))).toBe(
      false,
    )
    expect(computePresence(base({ tabVisible: true, now: 200_000, lastActivityAt: 1_000 }))).toBe(
      false,
    )
    expect(computePresence(base({ tabVisible: true, now: 1_000, lastActivityAt: 1_000 }))).toBe(true)
  })

  test("PD-07: CLI parity — tabVisible:true makes it activity-only (byte-identical to !isIdle)", () => {
    // With tabVisible pinned true, present iff within window — exactly !isIdle().
    expect(computePresence(base({ tabVisible: true, now: 30_000, lastActivityAt: 1_000 }))).toBe(
      true,
    )
    expect(computePresence(base({ tabVisible: true, now: 90_000, lastActivityAt: 1_000 }))).toBe(
      false,
    )
  })
})

describe("B5 computePresence — degenerate thresholds (fail-safe, no false-present)", () => {
  test("PD-08: threshold <= 0 ⇒ never present (idle disabled ⇒ never suppress)", () => {
    // Mirrors IdleMonitor: idleMs <= 0 ⇒ isIdle false ⇒ !isIdle true would mean
    // ALWAYS present. But an idle-disabled surface must NOT permanently suppress
    // pushes, so a non-positive threshold means "presence gate off" ⇒ never present.
    expect(computePresence(base({ thresholdMs: 0, now: 1_000, lastActivityAt: 1_000 }))).toBe(false)
    expect(computePresence(base({ thresholdMs: -5, now: 1_000, lastActivityAt: 1_000 }))).toBe(false)
  })

  test("PD-09: non-finite threshold (Infinity) ⇒ never present (gate off)", () => {
    expect(
      computePresence(base({ thresholdMs: Number.POSITIVE_INFINITY, now: 1_000, lastActivityAt: 1_000 })),
    ).toBe(false)
    expect(computePresence(base({ thresholdMs: Number.NaN, now: 1_000, lastActivityAt: 1_000 }))).toBe(
      false,
    )
  })

  test("PD-10: future lastActivityAt (clock skew) ⇒ treated as just-active (present if visible)", () => {
    // now < lastActivityAt ⇒ elapsed negative ⇒ well within window ⇒ present.
    expect(computePresence(base({ now: 1_000, lastActivityAt: 5_000 }))).toBe(true)
  })

  test("PD-11: non-finite now / lastActivityAt ⇒ absent (cannot prove presence ⇒ do not suppress)", () => {
    expect(computePresence(base({ now: Number.NaN, lastActivityAt: 1_000 }))).toBe(false)
    expect(computePresence(base({ now: 1_000, lastActivityAt: Number.NaN }))).toBe(false)
  })
})
