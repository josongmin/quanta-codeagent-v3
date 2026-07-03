/**
 * B5 (jul-04) — web-frontend presence probe test.
 *
 * The web mirror of the CLI's `computePresence` decision (`@/apps/cli/notify`):
 * `present = tabVisible AND recentlyActive`. The web supplies the REAL visibility
 * signal (`document.visibilityState === "visible"`) the CLI never had, plus the
 * same activity-window rule (default 60s, matching `QUANTA_IDLE_MS`).
 *
 * `computeWebPresence` is pure (injected `visibilityState`, `lastActivityAt`,
 * `now`, `thresholdMs`) so it is testable without a DOM. A separate
 * `makeVisibilityState` maps a raw string to the boolean the decision consumes,
 * so a mocked `document.visibilityState` source drives the real rule.
 */

import { describe, expect, it } from "vitest"
import {
  computeWebPresence,
  DEFAULT_WEB_IDLE_MS,
  isVisibilityPresent,
  type WebPresenceSignals,
} from "./presence-probe"

const base = (over: Partial<WebPresenceSignals> = {}): WebPresenceSignals => ({
  visibilityState: "visible",
  lastActivityAt: 1_000,
  now: 1_000,
  thresholdMs: 60_000,
  ...over,
})

describe("B5 web — isVisibilityPresent (visibilityState mapping)", () => {
  it("WP-01: 'visible' ⇒ true; 'hidden' ⇒ false", () => {
    expect(isVisibilityPresent("visible")).toBe(true)
    expect(isVisibilityPresent("hidden")).toBe(false)
  })

  it("WP-02: unknown / prerender / undefined ⇒ false (only explicit 'visible' counts)", () => {
    expect(isVisibilityPresent("prerender")).toBe(false)
    expect(isVisibilityPresent(undefined)).toBe(false)
    expect(isVisibilityPresent("")).toBe(false)
  })
})

describe("B5 web — computeWebPresence (visibility AND activity)", () => {
  it("WP-03: visible + just-active ⇒ present", () => {
    expect(computeWebPresence(base({ now: 1_000, lastActivityAt: 1_000 }))).toBe(true)
  })

  it("WP-04: visible + active within window (59s) ⇒ present", () => {
    expect(computeWebPresence(base({ now: 60_000, lastActivityAt: 1_000 }))).toBe(true)
  })

  it("WP-05: visible + away at/over threshold ⇒ absent", () => {
    expect(computeWebPresence(base({ now: 61_000, lastActivityAt: 1_000 }))).toBe(false)
    expect(computeWebPresence(base({ now: 200_000, lastActivityAt: 1_000 }))).toBe(false)
  })

  it("WP-06: HIDDEN tab ⇒ absent even if just-active (visibility gates)", () => {
    expect(
      computeWebPresence(base({ visibilityState: "hidden", now: 1_000, lastActivityAt: 1_000 })),
    ).toBe(false)
  })

  it("WP-07: degenerate threshold (<=0 / non-finite) ⇒ absent (gate off, never suppress)", () => {
    expect(computeWebPresence(base({ thresholdMs: 0 }))).toBe(false)
    expect(computeWebPresence(base({ thresholdMs: -1 }))).toBe(false)
    expect(computeWebPresence(base({ thresholdMs: Number.POSITIVE_INFINITY }))).toBe(false)
    expect(computeWebPresence(base({ thresholdMs: Number.NaN }))).toBe(false)
  })

  it("WP-08: non-finite clock inputs ⇒ absent (cannot prove presence)", () => {
    expect(computeWebPresence(base({ now: Number.NaN }))).toBe(false)
    expect(computeWebPresence(base({ lastActivityAt: Number.NaN }))).toBe(false)
  })

  it("WP-09: default idle window is 60_000ms (QUANTA_IDLE_MS parity)", () => {
    expect(DEFAULT_WEB_IDLE_MS).toBe(60_000)
    // Using the default threshold: active at 59s ⇒ present, 61s ⇒ absent.
    expect(
      computeWebPresence({
        visibilityState: "visible",
        lastActivityAt: 0,
        now: 59_000,
        thresholdMs: DEFAULT_WEB_IDLE_MS,
      }),
    ).toBe(true)
    expect(
      computeWebPresence({
        visibilityState: "visible",
        lastActivityAt: 0,
        now: 61_000,
        thresholdMs: DEFAULT_WEB_IDLE_MS,
      }),
    ).toBe(false)
  })
})
