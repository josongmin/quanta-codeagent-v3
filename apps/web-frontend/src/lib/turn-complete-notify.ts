/**
 * UUX-3-05 — OS turn-complete notification (the presence-probe's first
 * call site).
 *
 * `presence-probe.ts` shipped the pure decision (`computeWebPresence`) with
 * zero consumers. This module wires it: subscribe to the session event
 * stream; on `turn.completed` while the user is NOT present (hidden /
 * backgrounded tab, or idle past the activity window), fire a browser
 * Notification so the user learns the agent finished without staring at the
 * tab.
 *
 * Gates (all silent-degrade — a notification must never break the app):
 *   - presence: decided by the EXISTING `computeWebPresence` (visibility AND
 *     recent activity, fail-safe "cannot prove presence ⇒ notify") — NOT
 *     reimplemented here;
 *   - permission: only `"granted"` notifies. `"denied"` / `"default"` /
 *     API-absent (non-secure context, node) degrade silently. When the
 *     permission is still `"default"` at install time, an optional
 *     `requestPermission` is fired once best-effort (browsers may require a
 *     user gesture and reject — that rejection is swallowed: silent degrade);
 *   - a throwing Notification constructor is swallowed (some webviews expose
 *     the symbol but throw on construction).
 *
 * Everything is injected (subscribe / signals / permission / show) so the
 * seam is unit-testable in the node env; `installTurnCompleteNotifyBrowser`
 * is the thin App-side adapter over the real globals.
 */

import { computeWebPresence, DEFAULT_WEB_IDLE_MS, type WebPresenceSignals } from "./presence-probe"

export const TURN_COMPLETE_NOTIFICATION_TITLE = "quanta — turn complete"
export const TURN_COMPLETE_NOTIFICATION_BODY = "The agent finished a turn while you were away."

/**
 * Pure decision: notify iff the event is a turn completion AND the user is
 * not present (per `computeWebPresence`) AND notifications are permitted.
 */
export const shouldNotifyTurnComplete = (
  eventType: string,
  signals: WebPresenceSignals,
  permission: string | undefined,
): boolean =>
  eventType === "turn.completed" && permission === "granted" && !computeWebPresence(signals)

export interface TurnCompleteNotifyDeps {
  /** Session event source — the host passes `client.onAny`. Returns the
   *  unsubscribe. Only `event.type` is consulted. */
  readonly subscribe: (handler: (event: { readonly type: string }) => void) => () => void
  /** Sampled at event time (visibility + activity clock). */
  readonly getSignals: () => WebPresenceSignals
  /** `Notification.permission`, or undefined when the API is unavailable. */
  readonly permission: () => string | undefined
  /** Fire the notification (e.g. `new Notification(title, options)`). */
  readonly show: (title: string, options?: { readonly body?: string }) => void
  /** Optional one-shot best-effort `Notification.requestPermission` — fired at
   *  install when the permission is still "default". Rejections are swallowed. */
  readonly requestPermission?: () => Promise<unknown>
}

/** Wire the notification seam. Returns the teardown. */
export const installTurnCompleteNotify = (deps: TurnCompleteNotifyDeps): (() => void) => {
  // Best-effort permission prompt while the state is undecided. Browsers may
  // require a user gesture and auto-deny — both outcomes degrade silently.
  if (deps.permission() === "default" && deps.requestPermission !== undefined) {
    try {
      void deps.requestPermission().catch(() => {})
    } catch {
      // silent degrade — the API exists but threw synchronously
    }
  }
  return deps.subscribe((event) => {
    if (!shouldNotifyTurnComplete(event.type, deps.getSignals(), deps.permission())) return
    try {
      deps.show(TURN_COMPLETE_NOTIFICATION_TITLE, { body: TURN_COMPLETE_NOTIFICATION_BODY })
    } catch {
      // silent degrade — never let a notification failure poison the stream
    }
  })
}

/** DOM events that count as "user activity" for the presence window —
 *  mirrors the presence-probe doc ("pointer / key / focus"). */
export const ACTIVITY_EVENTS = ["pointerdown", "keydown", "focus"] as const

/**
 * Browser adapter: tracks activity via window listeners, samples the real
 * `document.visibilityState` + `Notification` global, and installs the seam.
 * Returns a teardown that detaches everything. Safe when `Notification` is
 * absent (the permission getter yields undefined ⇒ never notifies).
 */
export const installTurnCompleteNotifyBrowser = (
  subscribe: TurnCompleteNotifyDeps["subscribe"],
): (() => void) => {
  let lastActivityAt = Date.now()
  const markActive = (): void => {
    lastActivityAt = Date.now()
  }
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, markActive, { passive: true })
  }
  const notificationCtor = (
    globalThis as {
      Notification?: { permission?: string; requestPermission?: () => Promise<unknown> }
    }
  ).Notification
  const off = installTurnCompleteNotify({
    subscribe,
    getSignals: () => ({
      visibilityState: typeof document !== "undefined" ? document.visibilityState : undefined,
      lastActivityAt,
      now: Date.now(),
      thresholdMs: DEFAULT_WEB_IDLE_MS,
    }),
    permission: () =>
      typeof notificationCtor?.permission === "string" ? notificationCtor.permission : undefined,
    show: (title, options) => {
      // The ctor presence is re-checked at fire time; construction may still
      // throw in odd webviews — installTurnCompleteNotify swallows it. The
      // fixed `tag` makes rapid successive completions COALESCE (replace)
      // instead of stacking a pile of notifications.
      const Ctor = (
        globalThis as {
          Notification?: new (t: string, o?: { body?: string; tag?: string }) => unknown
        }
      ).Notification
      if (Ctor === undefined) return
      new Ctor(title, { ...options, tag: "quanta-turn-complete" })
    },
    ...(typeof notificationCtor?.requestPermission === "function"
      ? { requestPermission: () => notificationCtor.requestPermission?.() ?? Promise.resolve() }
      : {}),
  })
  return () => {
    off()
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, markActive)
    }
  }
}
