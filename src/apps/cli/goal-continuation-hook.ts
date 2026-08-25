/**
 * Goal-continuation ticker — the LIVE host binding that activates the
 * previously-DEAD `@/objective` continuation machine (H17, absorbed from
 * Codex `core/src/goals.rs`).
 *
 * Codex's "Pursuing goal" behaviour: once an `active` goal is set, the agent
 * keeps resuming work on it turn after turn — whenever the thread goes idle and
 * no other work is pending — until the goal is `completed`, `blocked`, or a
 * budget/usage limit trips. The pure decision + semaphore already live in
 * `@/objective` (`runIdleContinuation`); they were just never driven by a
 * real clock. This module is that driver: a `setInterval` idle-poll that calls
 * `runIdleContinuation` with host-bound probes and a `resume` sink.
 *
 * DEFAULT-OFF (byte-identical): `enabled: false` (or a missing `threadId`) makes
 * {@link startGoalContinuationTicker} a no-op returning `undefined` — no timer
 * is armed, so a session that has not opted into `QUANTA_GOAL_ENFORCE` behaves
 * exactly as before.
 *
 * SLICE FENCE: imports ONLY the closed `@/objective` barrel
 * (`runIdleContinuation`, `ContinuationSemaphore`, and the `ContinuationDeps`
 * probe/`resume` shape). No `@/agent` core, no reactor internals.
 */

import {
  type ContinuationDeps,
  ContinuationSemaphore,
  createGoalWakeController,
  type GoalWakeAttempt,
  runIdleContinuation,
} from "@/objective"

/** The host-bound probes + resume sink (everything in `ContinuationDeps` except
 *  the pieces this driver owns: `enabled`, `semaphore`, `now`). */
export type GoalContinuationProbes = Omit<ContinuationDeps, "enabled" | "semaphore" | "now">

export interface StartGoalContinuationOpts {
  /** Gate — wire from `runtimeConfig().goalContinuationEnforce`
   *  (`QUANTA_GOAL_ENFORCE`). OFF ⇒ no timer, `undefined` return. */
  readonly enabled: boolean
  /** The thread whose goal is pursued. `undefined` (ephemeral session) ⇒ no-op. */
  readonly threadId: string | undefined
  /** Host-bound probes + resume sink. */
  readonly probes: GoalContinuationProbes
  /** Idle-poll cadence. Default 15s — the continuation only fires when the
   *  thread is genuinely idle, so this is the "how soon after you stop typing
   *  does it pick the goal back up" latency, not a busy-loop. */
  readonly intervalMs?: number
  /** Injected timer factory (tests pass a fake). Defaults to real `setInterval`. */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injected clearer (paired with {@link setIntervalFn}). */
  readonly clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void
}

export interface GoalContinuationTicker {
  /** Stop the idle-poll (idempotent). */
  stop(): void
}

/**
 * Event-facing lifecycle for the edge-triggered controller. The interactive
 * host relays only real events (goal mutation, local activity, turn
 * settlement); this object owns neither objective state nor queue state.
 */
export interface GoalWakeLifecycle {
  onGoalMutation(): void
  onActivity(): void
  onLocalInputSettled(): void
  onTurnSettled(): void
  stop(): void
}

export interface StartGoalWakeOpts {
  readonly enabled: boolean
  readonly threadId: string | undefined
  readonly probes: GoalContinuationProbes
  /** Revisioned projection from the same authority `/goal` mutates. */
  readonly readDomain: (threadId: string) => import("@/objective").ObjectiveDomainSnapshot
  /** Goal-specific quiescence duration, independent of UI presence handling. */
  readonly quietWindowMs: number
  /** Optional typed queue hand-off. The CLI uses this to retain the captured
   * revision through dequeue; legacy hosts may keep the plain resume sink. */
  readonly resumeAttempt?: (threadId: string, attempt: GoalWakeAttempt) => Promise<void>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/** Goal pursuit's own quiet period. It is intentionally independent of the
 * UI idle-suppression window (`QUANTA_IDLE_MS`). */
export const DEFAULT_GOAL_QUIET_MS = 15_000

const DEFAULT_INTERVAL_MS = 15_000

/**
 * Build the event-driven successor to {@link startGoalContinuationTicker}.
 *
 * The legacy ticker remains exported for compatibility and its independent
 * regression rails. New interactive wiring uses this controller: one timer is
 * armed from concrete goal/turn edges, then revision + quiescence are checked
 * again immediately before the existing continuation orchestrator enqueues.
 */
export const startGoalWakeController = (opts: StartGoalWakeOpts): GoalWakeLifecycle | undefined => {
  const threadId = opts.threadId
  if (!opts.enabled || threadId === undefined || threadId.length === 0) return undefined

  const continuationDeps: ContinuationDeps = {
    ...opts.probes,
    enabled: true,
    semaphore: new ContinuationSemaphore(),
    now: () => Date.now(),
  }
  const setFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  let checkpointOrdinal = 0

  const controller = createGoalWakeController({
    enabled: true,
    quietWindowMs: opts.quietWindowMs,
    timer: {
      set: (fn, ms) => setFn(fn, ms),
      clear: (handle) => clearFn(handle as ReturnType<typeof setTimeout>),
    },
    readDomain: opts.readDomain,
    // The controller rechecks the SAME host guards before claiming an attempt;
    // runIdleContinuation repeats them at enqueue time to close the last race.
    stillQuiescent: (id) =>
      continuationDeps.threadIdle(id) &&
      !continuationDeps.planModeActive(id) &&
      !continuationDeps.turnActive(id) &&
      !continuationDeps.queuedInputPending(id) &&
      !continuationDeps.mailboxInputPending(id) &&
      !continuationDeps.isEphemeral(id),
    enqueue: async (attempt) => {
      const guardedDeps: ContinuationDeps = {
        ...continuationDeps,
        resume: async (id) => {
          // `runIdleContinuation` rechecks goal status. This additional exact
          // revision fence closes active→active edits between timer fire and
          // queue hand-off; the CLI keeps the same metadata to recheck at
          // dequeue immediately before the agent body starts.
          const current = opts.readDomain(id)
          if (
            current.state === null ||
            current.state.objective.status !== "active" ||
            current.revision !== attempt.objectiveRevision
          ) {
            throw new Error("goal wake became stale before queue hand-off")
          }
          if (opts.resumeAttempt !== undefined) {
            await opts.resumeAttempt(id, attempt)
            return
          }
          await opts.probes.resume(id)
        },
      }
      const outcome = await runIdleContinuation(threadId, guardedDeps)
      // A second guard can reject after the controller's fire-time decision.
      // Treat that as a rejected enqueue so the attempt reservation releases
      // rather than silently consuming a retry opportunity.
      if (!outcome.launched) throw new Error(`goal wake not launched: ${outcome.skipReason}`)
    },
  })

  const resetForNextCheckpoint = (): void => {
    const ordinal = checkpointOrdinal
    checkpointOrdinal += 1
    controller.reset({ threadId, checkpointOrdinal: ordinal })
  }

  // A resumed session may already carry an active goal before the first user
  // action, so it needs one initial quiet-window arm.
  resetForNextCheckpoint()
  return {
    onGoalMutation: resetForNextCheckpoint,
    onActivity: () => controller.onActivity(),
    onLocalInputSettled: resetForNextCheckpoint,
    onTurnSettled: resetForNextCheckpoint,
    stop: () => controller.stop(),
  }
}

/**
 * Arm the idle-poll that drives goal continuation. Returns `undefined` when the
 * feature is off or the session is ephemeral (no persistent thread to pursue),
 * so callers can `if (ticker !== undefined) closeStack.push(...)`.
 *
 * The timer is `.unref()`'d so it never keeps the process alive on its own.
 * Each tick delegates to `runIdleContinuation`, which is NO-THROW and
 * self-serializing via the single-permit semaphore — overlapping ticks (a slow
 * resume) can never launch two continuations.
 */
export const startGoalContinuationTicker = (
  opts: StartGoalContinuationOpts,
): GoalContinuationTicker | undefined => {
  const threadId = opts.threadId
  if (!opts.enabled || threadId === undefined || threadId.length === 0) return undefined

  const deps: ContinuationDeps = {
    ...opts.probes,
    enabled: true,
    semaphore: new ContinuationSemaphore(),
    now: () => Date.now(),
  }

  const setFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearFn = opts.clearIntervalFn ?? ((h) => clearInterval(h))

  let stopped = false
  const handle = setFn(() => {
    // `clearInterval` cannot retract a callback already queued by the event
    // loop. Re-check the lifecycle gate at callback execution so session
    // teardown cannot resume a goal after `stop()` returned.
    if (stopped) return
    // Fire-and-forget: runIdleContinuation is NO-THROW and the semaphore guards
    // re-entrancy, so an unresolved resume simply skips the next tick.
    void runIdleContinuation(threadId, deps)
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Never hold the event loop open just for the poll.
  ;(handle as { unref?: () => void }).unref?.()

  return {
    stop: (): void => {
      if (stopped) return
      stopped = true
      clearFn(handle)
    },
  }
}
