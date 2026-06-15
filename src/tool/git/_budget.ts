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
 *
 * Wiring (ADR-0107 §wire): `withBudget` is the single LIVE consumer — it
 * decorates a {@link GitRunner} so EVERY git invocation routed through the
 * read-only tools (`git_log`, `git_churn`, `git_blame_heatmap`,
 * `git_upstream_check`) enforces the budget uniformly:
 *   - `maxWallTimeMs`  → fused AbortSignal via {@link applyBudget}
 *   - `maxOutputBytes` → post-spawn stdout truncation
 *   - `maxCommits`     → `-n <N>` arg clamp via {@link resolveMaxCommits}
 * The composition root resolves the budget from a runtime knob and passes it
 * into `gitTools(runner, { budget })`; absent ⇒ `withBudget` returns the SAME
 * runner reference (no allocation, byte-identical contract).
 */

import type { GitRunner } from "./types"

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

/** True iff the budget carries at least one ENFORCEABLE knob (`maxCommits` /
 *  `maxWallTimeMs` / `maxOutputBytes`). `targetDurationMs` /
 *  `consecutiveOverBudget` are telemetry/multi-run-only and do NOT make a
 *  budget enforceable on a single call — a budget of only those is inert, so
 *  {@link withBudget} returns the runner unchanged for byte-identity. */
const hasEnforceableKnob = (budget: GitBudget): boolean => {
  const positive = (v: number | undefined): boolean =>
    v !== undefined && Number.isFinite(v) && v > 0
  return (
    positive(budget.maxCommits) || positive(budget.maxWallTimeMs) || positive(budget.maxOutputBytes)
  )
}

/** Clamp a `git log ... -n <N>` arg list against the budget's `maxCommits`.
 *  Returns the SAME array reference when there is no `-n` flag with a numeric
 *  follower or no cap applies, so the common path allocates nothing. The clamp
 *  reuses {@link resolveMaxCommits} (explicit `-n` value × cap × itself as the
 *  default) so the smaller of the existing flag and the cap wins. */
const clampCommitArgs = (
  args: readonly string[],
  budget: GitBudget | undefined,
): readonly string[] => {
  const cap = budget?.maxCommits
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return args
  const idx = args.indexOf("-n")
  if (idx < 0 || idx + 1 >= args.length) return args
  const current = Number(args[idx + 1])
  if (!Number.isFinite(current) || current <= 0) return args
  const clamped = resolveMaxCommits(current, budget, current)
  if (clamped === current) return args
  const next = [...args]
  next[idx + 1] = String(clamped)
  return next
}

/**
 * Decorate a {@link GitRunner} so every invocation enforces `budget`. This is
 * the LIVE consumer of {@link applyBudget} / {@link resolveMaxCommits}: the
 * composition root resolves a budget from a runtime knob and wraps the runner
 * once, then `gitTools(wrapped)` builds all tools on top of it.
 *
 * Enforcement per call:
 *   1. `maxCommits`     — clamp any `-n <N>` flag down to the cap.
 *   2. `maxWallTimeMs`  — fuse a deadline AbortSignal onto the caller's signal;
 *      whichever fires first kills the spawned git process.
 *   3. `maxOutputBytes` — truncate the returned stdout to the cap (the spawn
 *      already completed, so this bounds what the tool parses/returns, never
 *      letting a runaway walk balloon the loop's memory).
 *
 * Default-OFF / inert-budget ⇒ returns the SAME runner reference (no wrapper
 * allocation), so a deployment that does not set the knob is byte-identical.
 * NO-THROW: delegates to the wrapped runner; the `applyBudget` cleanup runs in
 * a `finally` so a long-lived parent signal never leaks a listener.
 */
export const withBudget = (runner: GitRunner, budget: GitBudget | undefined): GitRunner => {
  if (budget === undefined || !hasEnforceableKnob(budget)) return runner
  const cap = budget.maxOutputBytes
  const capBytes = cap !== undefined && Number.isFinite(cap) && cap > 0 ? cap : undefined
  return {
    async run(args, cwd, signal) {
      const clampedArgs = clampCommitArgs(args, budget)
      const fused = applyBudget(signal, budget)
      try {
        const result = await runner.run(clampedArgs, cwd, fused.signal)
        if (capBytes !== undefined && result.stdout.length > capBytes) {
          return { ...result, stdout: result.stdout.slice(0, capBytes) }
        }
        return result
      } finally {
        fused.cleanup()
      }
    },
  }
}

/**
 * Resolve an optional {@link GitBudget} from a runtime env record. Pure +
 * env-INJECTED (the slice never reads `process.env` itself — the composition
 * root passes its already-loaded env), so the gate is hermetically testable.
 *
 * Each knob is an independent positive integer; a knob that is unset / blank /
 * non-positive / non-finite is OMITTED. When NO knob yields an enforceable
 * value the function returns `undefined`, so `gitTools(runner, { budget })`
 * passes `undefined` and {@link withBudget} returns the SAME runner reference —
 * byte-identical to the pre-budget registry. Knobs:
 *   - `QUANTA_GIT_BUDGET_MAX_COMMITS`       → `maxCommits` (`-n` clamp)
 *   - `QUANTA_GIT_BUDGET_WALL_MS`           → `maxWallTimeMs` (fused abort)
 *   - `QUANTA_GIT_BUDGET_MAX_OUTPUT_BYTES`  → `maxOutputBytes` (stdout cap)
 */
export const resolveGitBudget = (
  env: Readonly<Record<string, string | undefined>>,
): GitBudget | undefined => {
  const positiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const maxCommits = positiveInt(env.QUANTA_GIT_BUDGET_MAX_COMMITS)
  const maxWallTimeMs = positiveInt(env.QUANTA_GIT_BUDGET_WALL_MS)
  const maxOutputBytes = positiveInt(env.QUANTA_GIT_BUDGET_MAX_OUTPUT_BYTES)
  if (maxCommits === undefined && maxWallTimeMs === undefined && maxOutputBytes === undefined) {
    return undefined
  }
  return {
    ...(maxCommits !== undefined ? { maxCommits } : {}),
    ...(maxWallTimeMs !== undefined ? { maxWallTimeMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  }
}
