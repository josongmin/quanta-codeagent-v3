/**
 * UUX-3-05 — OS turn-complete notification WIRING seam.
 *
 * `lib/presence-probe.ts` shipped with the pure decision (`computeWebPresence`)
 * and ZERO call sites. This pins the consumer: `installTurnCompleteNotify`
 * subscribes to the session event stream and, on `turn.completed` while the
 * user is NOT present (hidden tab / idle — decided by the EXISTING
 * `computeWebPresence`, not a reimplementation), fires a browser Notification.
 *
 * Permission-gated + silent degrade:
 *   - permission "granted"  ⇒ notify
 *   - permission "denied" / "default" / API absent (undefined) ⇒ no notify,
 *     no throw
 *   - a throwing Notification constructor must never propagate
 *
 * All signals injected (subscribe / getSignals / permission / show) so the
 * seam is testable in the node env without a DOM.
 */

import { describe, expect, it } from "vitest"
import type { WebPresenceSignals } from "./presence-probe"
import {
  installTurnCompleteNotify,
  shouldNotifyTurnComplete,
  TURN_COMPLETE_NOTIFICATION_TITLE,
} from "./turn-complete-notify"

type Handler = (event: { type: string }) => void

const makeHarness = (over: {
  signals?: Partial<WebPresenceSignals>
  permission?: string | undefined
}) => {
  const handlers: Handler[] = []
  const shown: Array<{ title: string; body?: string }> = []
  let unsubscribed = 0
  const signals: WebPresenceSignals = {
    visibilityState: "hidden",
    lastActivityAt: 0,
    now: 1_000_000, // long past the activity window ⇒ not recently active
    thresholdMs: 60_000,
    ...over.signals,
  }
  const off = installTurnCompleteNotify({
    subscribe: (h) => {
      handlers.push(h)
      return () => {
        unsubscribed += 1
      }
    },
    getSignals: () => signals,
    permission: () => ("permission" in over ? over.permission : "granted"),
    show: (title, options) => {
      shown.push({ title, ...(options?.body !== undefined ? { body: options.body } : {}) })
    },
  })
  const emit = (type: string): void => {
    for (const h of handlers) h({ type })
  }
  return { emit, shown, off, unsubscribedCount: () => unsubscribed }
}

describe("UUX-3-05 — turn-complete notification wiring", () => {
  it("TN-01: hidden tab + turn.completed + granted ⇒ notify fires (title pinned)", () => {
    const h = makeHarness({ signals: { visibilityState: "hidden" } })
    h.emit("turn.completed")
    expect(h.shown.length).toBe(1)
    expect(h.shown[0]?.title).toBe(TURN_COMPLETE_NOTIFICATION_TITLE)
  })

  it("TN-02: focused/visible + recently active ⇒ suppressed (user is present)", () => {
    const h = makeHarness({
      signals: { visibilityState: "visible", lastActivityAt: 999_500, now: 1_000_000 },
    })
    h.emit("turn.completed")
    expect(h.shown.length).toBe(0)
  })

  it("TN-03: visible but IDLE past the window ⇒ notify (presence needs BOTH)", () => {
    const h = makeHarness({
      signals: { visibilityState: "visible", lastActivityAt: 0, now: 1_000_000 },
    })
    h.emit("turn.completed")
    expect(h.shown.length).toBe(1)
  })

  it("TN-04: non-completed events never notify", () => {
    const h = makeHarness({})
    h.emit("turn.started")
    h.emit("message.delta")
    h.emit("turn.failed")
    expect(h.shown.length).toBe(0)
  })

  it("TN-05: permission denied / default / API absent ⇒ silent degrade", () => {
    for (const permission of ["denied", "default", undefined]) {
      const h = makeHarness({ permission })
      h.emit("turn.completed")
      expect(h.shown.length).toBe(0)
    }
  })

  it("TN-06: a throwing notifier never propagates into the event stream", () => {
    const handlers: Handler[] = []
    installTurnCompleteNotify({
      subscribe: (h) => {
        handlers.push(h)
        return () => {}
      },
      getSignals: () => ({
        visibilityState: "hidden",
        lastActivityAt: 0,
        now: 1_000_000,
        thresholdMs: 60_000,
      }),
      permission: () => "granted",
      show: () => {
        throw new Error("Notification constructor blew up")
      },
    })
    expect(() => {
      for (const h of handlers) h({ type: "turn.completed" })
    }).not.toThrow()
  })

  it("TN-07: teardown detaches the subscription", () => {
    const h = makeHarness({})
    h.off()
    expect(h.unsubscribedCount()).toBe(1)
  })

  it("TN-08: decision helper delegates to computeWebPresence (not a reimplementation)", () => {
    // present ⇒ suppress
    expect(
      shouldNotifyTurnComplete(
        "turn.completed",
        {
          visibilityState: "visible",
          lastActivityAt: 1_000,
          now: 1_000,
          thresholdMs: 60_000,
        },
        "granted",
      ),
    ).toBe(false)
    // fail-safe bias carried over: a broken clock cannot prove presence ⇒ notify
    expect(
      shouldNotifyTurnComplete(
        "turn.completed",
        {
          visibilityState: "visible",
          lastActivityAt: Number.NaN,
          now: Number.NaN,
          thresholdMs: 60_000,
        },
        "granted",
      ),
    ).toBe(true)
  })
})
