/**
 * Git operation budget (Cursor `captureGitHistory` 5-knob absorption —
 * ADR-0107). Caps wall-time / commit-count / output-size for long-running
 * git invocations so a runaway walk on a huge repo cannot blow the agent
 * loop's latency or memory budget.
 *
 * Closed-port design: the budget is a TYPED interface plus a pure helper
 * `applyBudget` that derives an AbortSignal carrying the deadline. Tools
 * (`git_log`, `git_churn`, `git_blame_heatmap`, `git_upstream_check`)
 * accept an optional `budget` arg and pass the derived signal into the
 * runner. Absent budget ⇒ no signal derivation, byte-identical contract
 * with pre-budget callers.
 *
 * The five knobs mirror Cursor's `CaptureBudget` struct verbatim so a
 * future port of their gix-snapshot RefStore → Commit → PackTree →
 * PackBlob → Pack stage machine has a 1:1 contract surface. Of the five:
 *
 *   - `maxCommits`         — enforced today via `-n` flag at the call site
 *   - `maxWallTimeMs`      — enforced today via fused AbortSignal
 *   - `maxOutputBytes`     — enforced today via post-spawn output cap
 *   - `targetDurationMs`   — telemetry-only today (no enforcement)
 *   - `consecutiveOverBudget` — multi-run counter; tracked by the caller
 *
 * The last two are forward-compat type slots; they MUST stay in the
 * interface so a future user wiring them in does not need a type bump.
 */

export interface GitBudget {
  /** Cap on the number of commits the walker should process. Tools that
   *  shell out to `git log` translate this to `-n <maxCommits>`. */
  readonly maxCommits?: number
  /** Hard cap on wall-clock for the operation. Past this, the AbortSignal
   *  fires and the spawned git process is killed. */
  readonly maxWallTimeMs?: number
  /** Cap on the cumulative stdout bytes returned to the caller. Tools
   *  that compose results from multiple invocations sum across them. */
  readonly maxOutputBytes?: number
  /** Target latency for the operation. Crossing it is NOT an error —
   *  this is a telemetry hint for the caller to surface "this operation
   *  is slow" without hard-failing. */
  readonly targetDurationMs?: number
  /** Number of consecutive over-budget runs the caller will tolerate
   *  before halting future invocations. Multi-run state; one-call helpers
   *  in this module ignore it. */
  readonly consecutiveOverBudget?: number
}

/** Hard ceiling on any user-supplied wall-time budget. Catches a mis-typed
 *  cap (e.g. someone passes `5` thinking minutes instead of ms) — clamp
 *  to a generous-but-finite 60s so the AbortController has a real deadline.
 *  Tools that legitimately need longer should pin to `defaultGitRunner`'s
 *  own 30s timeout via NO budget (pass `undefined`) rather than asking for
 *  the moon. */
const MAX_WALL_TIME_HARD_MS = 60_000

/**
 * Derive a fused AbortSignal from an optional caller signal + an optional
 * budget. Returns the original `parent` unchanged when no time budget is
 * set — byte-identical, no listener overhead. When a budget IS set, the
 * returned signal aborts when either the parent aborts OR the budget's
 * wall-time elapses; whichever comes first wins. The returned `cleanup`
 * MUST be called by the caller in a `finally` to clear the timer and the
 * abort listener — otherwise a long-lived parent signal would leak a
 * listener for each call.
 *
 * Pure: no IO. The timer is set via {@link setTimeout}, which is
 * deterministic given the host clock.
 */
export const applyBudget = (
  parent: AbortSignal | undefined,
  budget: GitBudget | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } => {
  const walltime = budget?.maxWallTimeMs
  if (walltime === undefined || !Number.isFinite(walltime) || walltime <= 0) {
    return { signal: parent, cleanup: noop }
  }
  const clampedMs = Math.min(walltime, MAX_WALL_TIME_HARD_MS)
  const ctrl = new AbortController()
  const onParentAbort = (): void => {
    ctrl.abort(parent?.reason)
  }
  if (parent?.aborted) {
    ctrl.abort(parent.reason)
  } else if (parent !== undefined) {
    parent.addEventListener("abort", onParentAbort, { once: true })
  }
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`git operation exceeded maxWallTimeMs=${clampedMs}`))
  }, clampedMs)
  const cleanup = (): void => {
    clearTimeout(timer)
    if (parent !== undefined) parent.removeEventListener("abort", onParentAbort)
  }
  return { signal: ctrl.signal, cleanup }
}

const noop = (): void => {}

/**
 * Resolve the effective commit count for a tool from (a) explicit caller
 * arg, (b) the budget's `maxCommits` cap, (c) a tool-level default. The
 * smaller of (a) and (b) wins when both are set; the default fills in when
 * neither is. Used by `git_log` / `git_churn` to translate the budget into
 * the `-n <N>` flag.
 */
export const resolveMaxCommits = (
  explicit: number | undefined,
  budget: GitBudget | undefined,
  defaultCount: number,
): number => {
  const cap = budget?.maxCommits
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.min(explicit, cap) : explicit
  }
  if (cap !== undefined && Number.isFinite(cap) && cap > 0) return cap
  return defaultCount
}

/**
 * True when the actual elapsed milliseconds crossed the budget's
 * `targetDurationMs` threshold. Pure: returns a boolean for the caller to
 * surface as telemetry. Returns false when no target is set.
 */
export const crossedTarget = (elapsedMs: number, budget: GitBudget | undefined): boolean => {
  const target = budget?.targetDurationMs
  if (target === undefined || !Number.isFinite(target) || target <= 0) return false
  return elapsedMs > target
}
