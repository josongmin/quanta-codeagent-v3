/**
 * B5 — web-frontend presence probe (pure, no DOM).
 *
 * The web mirror of the CLI's `computePresence` (`@/apps/cli/notify`): the
 * web-frontend is a separate build root and cannot import `src/`, so this pins
 * the SAME presence rule with a parallel unit test. B5 shipped CLI-only (an
 * activity-only `!idle.isIdle()` probe); this brings the decision to the web and
 * ADDS the browser visibility signal the CLI never had:
 *
 *     present = tabVisible AND recentlyActive
 *     recentlyActive = 0 < thresholdMs < ∞ AND (now - lastActivityAt) < thresholdMs
 *     tabVisible = (document.visibilityState === "visible")
 *
 * A hidden / backgrounded tab means the user has LOOKED AWAY regardless of a
 * recent keystroke, so visibility gates presence. The boolean feeds a push
 * decision as its `present` slot (suppress the notification while present) — the
 * competitor "presence-gated push" semantics, extended for the web.
 *
 * Fail-safe bias: when presence CANNOT be proven (non-positive / non-finite
 * threshold, or non-finite clock inputs) the result is `false` — "not present"
 * ⇒ do NOT suppress. A degenerate signal must never silently mute notifications.
 *
 * Pure: all signals are injected (no `document`, no clock) so the decision is
 * testable with a mocked visibility source.
 */

/** Default idle window (ms) — matches the CLI `QUANTA_IDLE_MS` default. */
export const DEFAULT_WEB_IDLE_MS = 60_000

/** The signals the web samples to decide presence. */
export interface WebPresenceSignals {
  /** Raw `document.visibilityState` (or undefined when unavailable). Only the
   *  literal "visible" counts as present. */
  readonly visibilityState: string | undefined
  /** Epoch-ms of the most recent user activity (pointer / key / focus). */
  readonly lastActivityAt: number
  /** Current epoch-ms. */
  readonly now: number
  /** Idle window in ms. Non-positive / non-finite ⇒ presence gate OFF. */
  readonly thresholdMs: number
}

/**
 * Map a raw `document.visibilityState` string to the presence-relevant boolean.
 * Only the explicit "visible" state counts; "hidden" / "prerender" / undefined
 * are treated as not-present (the user is not looking at this surface).
 */
export const isVisibilityPresent = (visibilityState: string | undefined): boolean =>
  visibilityState === "visible"

/**
 * Decide whether the user is present. Pure. Mirrors the CLI `computePresence`
 * rule (`tabVisible AND recentlyActive`) with the fail-safe bias.
 */
export const computeWebPresence = (signals: WebPresenceSignals): boolean => {
  const { visibilityState, lastActivityAt, now, thresholdMs } = signals
  // Visibility hard gate: a hidden surface is never present.
  if (!isVisibilityPresent(visibilityState)) return false
  // Presence gate OFF for a disabled / broken idle window ⇒ never present.
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  // A broken clock cannot prove presence ⇒ absent (do not suppress).
  if (!Number.isFinite(now) || !Number.isFinite(lastActivityAt)) return false
  // recentlyActive: strictly INSIDE the window (>= threshold is idle). Negative
  // elapsed (clock skew / future activity) is well inside the window ⇒ present.
  return now - lastActivityAt < thresholdMs
}
