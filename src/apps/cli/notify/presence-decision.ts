/**
 * B5 (jul-04) — pure presence-FROM-SIGNALS decision. The surface-portable core
 * B5 lacked: it shipped CLI-only as `isUserPresent = () => !idle.isIdle()` (an
 * activity-only probe). This extracts the DECISION so the web can reuse the same
 * rule, extended with the browser visibility signal the CLI never had:
 *
 *     present = tabVisible AND recentlyActive
 *     recentlyActive = 0 < thresholdMs < ∞ AND (now - lastActivityAt) < thresholdMs
 *
 * `recentlyActive` mirrors the CLI {@link IdleMonitor}'s `!isIdle()` window
 * (`QUANTA_IDLE_MS`): active within the last `thresholdMs` ⇒ present. `tabVisible`
 * is the ADDITIONAL web signal (`document.visibilityState === "visible"`); a
 * hidden/backgrounded tab means the user has LOOKED AWAY regardless of a recent
 * keystroke, so visibility gates presence. The CLI has no tab and passes
 * `tabVisible: true`, collapsing this to the legacy activity-only behavior
 * (byte-identical to `!isIdle()`).
 *
 * The resulting boolean feeds {@link shouldPush} as its `present` slot — this
 * module decides PRESENCE, `shouldPush` decides SUPPRESSION PRECEDENCE. Keeping
 * them separate means the web reuses the presence rule without re-deriving the
 * config/transport precedence.
 *
 * Fail-safe bias: when presence CANNOT be proven (non-finite / non-positive
 * threshold, or non-finite clock inputs) the decision is `false` — "not present"
 * ⇒ do NOT suppress the notification. A degenerate signal must never silently
 * swallow a push forever. This matches IdleMonitor's "idle disabled ⇒ isIdle
 * false" intent at the notification layer: an off/broken idle window means the
 * presence gate is OFF (never suppress), not permanently-present.
 *
 * Pure: `now` / `lastActivityAt` are injected epoch-ms; no clock, no DOM, no env.
 */

/** The signals a surface samples to decide whether the user is present. */
export interface PresenceSignals {
  /** True iff the surface is foreground/visible. CLI passes `true` (no tab);
   *  web passes `document.visibilityState === "visible"`. A hidden surface is
   *  never present. */
  readonly tabVisible: boolean
  /** Epoch-ms of the most recent user activity (keypress / focus / turn). */
  readonly lastActivityAt: number
  /** Current epoch-ms (injected clock). */
  readonly now: number
  /** Idle window in ms (the CLI `QUANTA_IDLE_MS`; default 60_000 upstream).
   *  Non-positive or non-finite ⇒ presence gate OFF ⇒ never present. */
  readonly thresholdMs: number
}

/**
 * Decide whether the user is present. Pure. See the module docstring for the
 * `tabVisible AND recentlyActive` rule and the fail-safe bias.
 */
export const computePresence = (signals: PresenceSignals): boolean => {
  const { tabVisible, lastActivityAt, now, thresholdMs } = signals
  // Visibility is a hard gate: a hidden surface is never present.
  if (tabVisible !== true) return false
  // Presence gate OFF for a disabled / broken idle window ⇒ never present
  // (never suppress). Mirrors IdleMonitor's non-positive / non-finite handling.
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  // A broken clock cannot prove presence ⇒ absent (do not suppress).
  if (!Number.isFinite(now) || !Number.isFinite(lastActivityAt)) return false
  // recentlyActive: strictly INSIDE the window (>= threshold is idle, matching
  // IdleMonitor's `now - lastActive >= idleMs ⇒ isIdle`). Negative elapsed
  // (future activity / clock skew) is well inside the window ⇒ present.
  const elapsed = now - lastActivityAt
  return elapsed < thresholdMs
}
