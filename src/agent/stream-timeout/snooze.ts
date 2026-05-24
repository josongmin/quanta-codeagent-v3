/**
 * ADR-0200 — SnoozeController. Decoupled from the watchdog so a CLI
 * surface (REPL `/snooze 5m`) can OWN the controller and inject the
 * SAME instance into a long-running stream's policy.
 *
 * Plane-clean: imports nothing.
 */

/** Read+write surface a watchdog consumes (via `policy.snooze`). The
 *  CLI/REPL owns the controller; the watchdog only POLLS `isPaused()`. */
export interface SnoozeController {
  /** Pause for `durationMs`. Auto-resume after the duration unless
   *  explicitly resumed earlier. A subsequent `pause()` while paused
   *  REPLACES the deadline (LATEST-WINS semantics — user re-snoozed). */
  pause(durationMs: number): void
  /** Manually wake. No-op when not paused. */
  resume(): void
  /** Current pause state. The watchdog reads this each loop iteration. */
  isPaused(): boolean
}

export interface SnoozeOpts {
  /** Injection seam for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** Build a fresh {@link SnoozeController}. Each call returns a new
 *  controller with its own deadline. */
export const createSnoozeController = (opts?: SnoozeOpts): SnoozeController => {
  const now = opts?.now ?? Date.now
  let deadline = 0
  return {
    pause(durationMs) {
      const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
      deadline = now() + ms
    },
    resume() {
      deadline = 0
    },
    isPaused() {
      return now() < deadline
    },
  }
}
