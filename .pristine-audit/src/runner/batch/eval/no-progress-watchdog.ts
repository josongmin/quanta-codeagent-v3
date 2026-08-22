/**
 * Per-instance NO-PROGRESS (idle) watchdog — the missing third leg of hang
 * detection.
 *
 * The hang class (jun-27, full-remote A/B): a box made LLM calls continuously
 * (NetOut active, low CPU) yet completed NO turns for 77min on a single case.
 * Neither existing guard fired:
 *   - the empty-stream breaker watches for EMPTY streams; under throttle the
 *     streams were non-empty (slow/partial), so it never tripped.
 *   - {@link ./run-health} classifies FINISHED instances; a hung instance never
 *     returns, so the post-instance gate never even ran.
 * The operator's only signal was "the newest span stopped arriving" — i.e.
 * forward progress stalled. This watchdog formalizes exactly that: a budget that
 * RESETS on every progress event and declares `stalled` once it elapses, so a
 * caller can abort the wedged instance and free the loop instead of hanging it.
 *
 * PURE + injected clock → fully offline-testable. The wiring (what counts as
 * "progress" — a new run.log line / a completed turn — and what "abort" does) is
 * the caller's; this module owns only the timing decision.
 */

/** A monotonic idle tracker. `now()` is injected so tests drive time directly. */
export interface NoProgressWatchdog {
  /** Record a forward-progress event (new run.log line / completed turn). Resets
   *  the idle clock. */
  progress(): void
  /** ms elapsed since the last progress event (or since construction). */
  idleMs(): number
  /** True once `idleMs() >= budget` — no forward progress within the budget. */
  stalled(): boolean
  /** A stable one-line reason for the abort log (id + idle seconds). */
  reason(id: string): string
}

export interface NoProgressWatchdogOptions {
  /** Idle budget in ms — no progress for this long ⇒ stalled. */
  readonly budgetMs: number
  /** Injected clock (ms). Defaults to Date.now in production callers, but is
   *  REQUIRED here so the slice stays deterministic + offline-testable. */
  readonly now: () => number
}

export const makeNoProgressWatchdog = (opts: NoProgressWatchdogOptions): NoProgressWatchdog => {
  // Clamp a non-positive/NaN budget to a sane floor so a misconfigured 0 can't
  // declare every instance instantly stalled (the gate must be opt-in-safe).
  const budget = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : Infinity
  let last = opts.now()
  return {
    progress: () => {
      last = opts.now()
    },
    idleMs: () => Math.max(0, opts.now() - last),
    stalled: () => opts.now() - last >= budget,
    reason: (id) =>
      `no forward progress for ${Math.round((opts.now() - last) / 1000)}s on ${id} ` +
      `(budget ${Math.round(budget / 1000)}s) — instance wedged (throttle / stuck stream); ` +
      "aborting it so the run continues",
  }
}

/** Resolve the idle budget (ms) from the bench env. Default-OFF (`Infinity` ⇒
 *  never fires) unless `QUANTA_BENCH_NO_PROGRESS_ABORT_S` sets a positive seconds
 *  value, so enabling the abort is an explicit operator decision (the watchdog is
 *  always *observable* via {@link makeNoProgressWatchdog}; only the abort is gated).
 *  Env is read in the bench composition layer, never in this slice-pure module. */
export const resolveNoProgressBudgetMs = (env: Record<string, string | undefined>): number => {
  const raw = env.QUANTA_BENCH_NO_PROGRESS_ABORT_S
  if (raw === undefined || raw.trim() === "") return Infinity
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Infinity
}
