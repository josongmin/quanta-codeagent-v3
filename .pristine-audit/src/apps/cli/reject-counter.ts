/**
 * Consecutive-denial counter (Cursor 3.2 inspired — §4.1 verbatim).
 *
 * Tracks how many permission-confirm prompts the user has denied IN A ROW.
 * One acceptance resets the counter to zero (the threshold compares against
 * the *consecutive* run, not lifetime denials). When the count exceeds
 * `threshold` (default 20), `shouldAutoExit()` returns true and the REPL
 * unwinds via the prompt-source `null` return (graceful loop exit — not
 * `process.exit`) so deferred cleanup (MCP shutdown, status-bar teardown,
 * sessions-pruner) all run.
 *
 * Why graceful instead of process.exit: the runRepl `finally` block calls
 * `shutdownMcp()`. A bare `process.exit(0)` from a deep onConfirm callback
 * skips that. Returning `null` from the prompt source bubbles up to the
 * runInteractive driver which unwinds normally.
 *
 * `threshold = Infinity` ⇒ `shouldAutoExit()` is always false. That's how
 * `QUANTA_REJECT_LIMIT=0` (which `runRepl` reads as Infinity) disables the
 * mechanism — no internal kill-switch needed.
 *
 * Slice discipline: pure data structure, no IO, no imports.
 */

export const DEFAULT_THRESHOLD = 20

export interface RejectCounter {
  /** Record one denial. Returns the new (post-increment) total. */
  recordDeny(): number
  /** Record one acceptance. Resets the consecutive counter to zero. */
  recordAccept(): void
  /** Current consecutive-denial count. */
  count(): number
  /** True iff `count() >= threshold`. Strict `>=` (not `>`) so the spec's
   *  "20-reject auto-exit" fires on the 20th denial, not the 21st. */
  shouldAutoExit(): boolean
  /** Reset state (test seam). */
  reset(): void
  /** #22 — the RESOLVED auto-exit threshold this counter enforces (=
   *  `threshold` or {@link DEFAULT_THRESHOLD}). Exposed so the exit banner
   *  interpolates the SAME number the gate trips on, killing the hardcoded-"20"
   *  UI-lie when an operator overrides `QUANTA_REJECT_LIMIT`. Optional so
   *  existing test doubles stay assignable; the real factory always sets it. */
  readonly limit?: number
}

export interface RejectCounterOptions {
  /** Trigger threshold. Default 20 (Cursor §4.1). `Infinity` disables. */
  threshold?: number
}

export const createRejectCounter = (opts?: RejectCounterOptions): RejectCounter => {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD
  let consecutive = 0

  return {
    limit: threshold,
    recordDeny: (): number => {
      consecutive += 1
      return consecutive
    },
    recordAccept: (): void => {
      consecutive = 0
    },
    count: (): number => consecutive,
    shouldAutoExit: (): boolean => {
      if (!Number.isFinite(threshold)) return false
      if (threshold <= 0) return false
      return consecutive >= threshold
    },
    reset: (): void => {
      consecutive = 0
    },
  }
}
