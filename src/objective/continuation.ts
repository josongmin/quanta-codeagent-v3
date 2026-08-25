/**
 * H17 — Idle goal-continuation (Codex `core/src/goals.rs`).
 *
 * When a thread is IDLE and has an `active` goal, the agent should
 * automatically resume work on that goal instead of sitting silent. Codex
 * guards this aggressively — it skips the continuation when ANY of a closed set
 * of conditions holds, and serializes launches with a single-permit semaphore
 * so only one continuation is ever in flight.
 *
 * This module is the PURE core of that machine:
 *
 *   - {@link evaluateContinuation} — a TOTAL, no-I/O, no-clock decision over a
 *     plain `GoalContinuationInput` snapshot. Returns `launch: true` only when
 *     EVERY guard passes; otherwise `launch: false` with the verbatim Codex
 *     `skipReason`. The guards are evaluated in a fixed order so the reason is
 *     deterministic.
 *
 *   - {@link ContinuationSemaphore} — a single-permit, idempotent-release
 *     semaphore. `tryAcquire()` returns a permit or `null` if one is already
 *     held; `release()` is idempotent (a buggy double-release never leaks a
 *     second permit).
 *
 *   - {@link runIdleContinuation} — the thin orchestrator that wires the pure
 *     decision to injected ports (an `ObjectivePort`, a clock, the idle/turn/
 *     queue/mailbox/plan/ephemeral probes, and a `resume` sink). It reads the
 *     goal status at SCAN time, acquires the semaphore, RE-READS the status at
 *     LAUNCH time (the "goal changed before launch" guard), and only then calls
 *     `resume`. All side effects go through injected ports — no real loop, no
 *     env, no wall clock.
 *
 * Default-OFF (RFC §1.2): `enabled: false` ⇒ {@link evaluateContinuation}
 * returns `disabled` and {@link runIdleContinuation} never touches a port or
 * the resume sink — byte-identical to today's informational objective (no
 * continuation ever launches).
 *
 * LIVE WIRING: this module is NO LONGER dead. `runIdleContinuation` is driven
 * by the host binding `apps/cli/goal-continuation-hook.ts`: an event-driven
 * quiet-window controller invokes it only after a fresh authority revision and
 * host quiescence check. The `QUANTA_GOAL_ENFORCE` →
 * `goalContinuationEnforce` knob gates construction at the interactive
 * composition root. A real PTY continuation E2E, rather than a source-text
 * ratchet, proves the shipped queue → agent-turn path.
 * Separately, the budget-suppression path `objectiveBudgetExhausted` in
 * `@/agent/loop/emit-helpers` (reads the DERIVED `budget_limited` status) is a
 * DIFFERENT machine and still lives — the two are unrelated.
 *
 * SLICE FENCE: imports ONLY `./types` (the closed `ObjectivePort` +
 * `ObjectiveStatus`). Nothing from `@/agent` core, `@/reactor`, `@/apps`. The
 * host binds the probes/resume at the idle-monitor / reactor seam
 * (goal-continuation-hook).
 */

import type { ObjectivePort, ObjectiveStatus } from "./types"

/**
 * Closed set of continuation skip reasons — verbatim from Codex
 * `core/src/goals.rs` "skipping active goal continuation because …" guards,
 * plus `disabled` (our default-OFF gate) and `semaphore-busy` (the single
 * permit is already held). Exhaustive: adding a guard is a compile error at the
 * `evaluateContinuation` switch-free chain.
 */
export type ContinuationSkipReason =
  | "disabled" // default-OFF — feature not enabled
  | "not-idle" // thread is not idle (pending work appeared)
  | "no-goal" // no goal is set for the thread
  | "ephemeral-thread" // ephemeral thread — never auto-continues
  | "plan-mode-active" // plan mode is active
  | "turn-active" // a turn is already active
  | "queued-input" // queued input exists
  | "mailbox-input" // trigger-turn mailbox input is pending
  | "goal-not-active" // goal status is not `active` (paused/limited/blocked/done)
  | "goal-changed" // the goal changed (status) between scan and launch
  | "semaphore-busy" // another continuation already holds the single permit

/**
 * A plain, side-effect-free snapshot of everything the continuation decision
 * needs. The orchestrator builds this from its injected probes; tests construct
 * it directly. `goalStatusAtScan` is the status read when the idle scan began;
 * `goalStatusAtLaunch` is the status re-read right before launch (they differ
 * when the goal changed mid-scan → the `goal-changed` guard fires). `null`
 * status ⇒ no goal is set.
 */
export interface GoalContinuationInput {
  readonly enabled: boolean
  readonly threadIdle: boolean
  readonly goalStatusAtScan: ObjectiveStatus | null
  readonly goalStatusAtLaunch: ObjectiveStatus | null
  readonly planModeActive: boolean
  readonly turnActive: boolean
  readonly queuedInputPending: boolean
  readonly mailboxInputPending: boolean
  readonly ephemeralThread: boolean
}

/** The decision: launch or skip-with-reason. */
export interface ContinuationDecision {
  readonly launch: boolean
  /** Present iff `launch === false`. */
  readonly skipReason?: ContinuationSkipReason
}

const skip = (reason: ContinuationSkipReason): ContinuationDecision => ({
  launch: false,
  skipReason: reason,
})

/**
 * PURE continuation decision. Evaluates the guards in a FIXED order so the
 * surfaced `skipReason` is deterministic (mirrors the Codex guard ordering):
 *
 *   1. disabled            (default-OFF gate — cheapest, no further reads)
 *   2. not-idle            (pending work appeared)
 *   3. no-goal             (nothing to continue)
 *   4. ephemeral-thread    (never auto-continues)
 *   5. plan-mode-active
 *   6. turn-active
 *   7. queued-input
 *   8. mailbox-input
 *   9. goal-not-active     (paused / usage_limited / budget_limited / blocked / completed)
 *  10. goal-changed        (status differs between scan and launch)
 *
 * Returns `launch: true` ONLY when every guard passes. Total function — never
 * throws.
 */
export const evaluateContinuation = (input: GoalContinuationInput): ContinuationDecision => {
  if (!input.enabled) return skip("disabled")
  if (!input.threadIdle) return skip("not-idle")
  if (input.goalStatusAtScan === null) return skip("no-goal")
  if (input.ephemeralThread) return skip("ephemeral-thread")
  if (input.planModeActive) return skip("plan-mode-active")
  if (input.turnActive) return skip("turn-active")
  if (input.queuedInputPending) return skip("queued-input")
  if (input.mailboxInputPending) return skip("mailbox-input")
  if (input.goalStatusAtScan !== "active") return skip("goal-not-active")
  // Goal must still be `active` at launch — anything else (including a
  // transition to limited/blocked/paused, or the goal being cleared) means the
  // goal changed before we could launch.
  if (input.goalStatusAtLaunch !== "active") return skip("goal-changed")
  return { launch: true }
}

/** A held permit. `release()` is idempotent. */
export interface ContinuationPermit {
  release(): void
}

/**
 * Single-permit semaphore. At most ONE continuation runs at a time across all
 * threads (matching Codex's single "goal continuation semaphore"). Synchronous
 * try-acquire (no queueing — a refused acquirer simply skips this scan and
 * retries on the next idle tick). `release()` is idempotent: a double-release
 * (or a release after a fresh acquire by someone else) never frees a permit it
 * does not own, so the invariant "≤ 1 permit outstanding" holds under any call
 * pattern.
 */
export class ContinuationSemaphore {
  #held = false

  /** Acquire the single permit, or `null` if it is already held. */
  tryAcquire(): ContinuationPermit | null {
    if (this.#held) return null
    this.#held = true
    let released = false
    return {
      release: (): void => {
        if (released) return // idempotent — this permit was already released
        released = true
        this.#held = false
      },
    }
  }
}

/**
 * The injected concerns the orchestrator needs. All probes are pull-style
 * (the orchestrator reads them at scan/launch time). `resume` is the
 * `AgentLoopPort`-shaped sink the host binds to its real enqueue/wake path; it
 * MAY throw — the orchestrator wraps it so a throwing resume degrades to a
 * skip, never crashing the idle tick.
 */
export interface ContinuationDeps {
  /** Default-OFF gate (host wires from `QUANTA_GOAL_ENFORCE`). */
  readonly enabled: boolean
  /** The objective store — read-only here (status reads only). */
  readonly objective: Pick<ObjectivePort, "get">
  /** The single-permit semaphore shared across all idle scans. */
  readonly semaphore: ContinuationSemaphore
  /** Injected clock (reserved for future window-aware scheduling; kept so the
   *  orchestrator never reaches for a wall clock). */
  readonly now: () => number
  readonly threadIdle: (threadId: string) => boolean
  readonly planModeActive: (threadId: string) => boolean
  readonly turnActive: (threadId: string) => boolean
  readonly queuedInputPending: (threadId: string) => boolean
  readonly mailboxInputPending: (threadId: string) => boolean
  readonly isEphemeral: (threadId: string) => boolean
  /** Resume the goal — the `AgentLoopPort`-shaped wake/enqueue sink. */
  readonly resume: (threadId: string) => Promise<void>
}

/** The orchestrator result. `launched` true ⇒ `resume` was invoked. */
export interface ContinuationRunResult {
  readonly launched: boolean
  readonly skipReason?: ContinuationSkipReason
}

const probe = (fn: (id: string) => boolean, id: string): boolean => {
  try {
    return fn(id) === true
  } catch {
    // These are all BLOCKING predicates (plan/turn/queue/mailbox/ephemeral).
    // Unknown host state must suppress an autonomous wake, never be normalized
    // to "nothing pending" and launch through a failed safety probe.
    return true
  }
}

/**
 * Run one idle-continuation scan for `threadId`. Reads the goal status at scan
 * time, evaluates the pure guards, acquires the single permit, RE-READS the
 * status at launch (the goal-changed guard), then calls `resume`. NO-THROW:
 * any internal failure degrades to `{ launched: false }`. The semaphore permit
 * is always released in a `finally`, even if `resume` throws.
 */
export const runIdleContinuation = async (
  threadId: string,
  deps: ContinuationDeps,
): Promise<ContinuationRunResult> => {
  try {
    // Cheap default-OFF short-circuit BEFORE any port read.
    if (!deps.enabled) return { launched: false, skipReason: "disabled" }
    if (typeof threadId !== "string" || threadId.length === 0) {
      return { launched: false, skipReason: "no-goal" }
    }

    const statusAtScan = readStatus(deps, threadId)
    // A throwing idle probe must NOT auto-continue — treat as not-idle.
    const idle = probeIdle(deps.threadIdle, threadId)

    const scanInput: GoalContinuationInput = {
      enabled: true,
      threadIdle: idle,
      goalStatusAtScan: statusAtScan,
      // At scan we have not re-read yet; mirror scan so the pure guards before
      // the goal-changed check are evaluated against the scan snapshot.
      goalStatusAtLaunch: statusAtScan,
      planModeActive: probe(deps.planModeActive, threadId),
      turnActive: probe(deps.turnActive, threadId),
      queuedInputPending: probe(deps.queuedInputPending, threadId),
      mailboxInputPending: probe(deps.mailboxInputPending, threadId),
      ephemeralThread: probe(deps.isEphemeral, threadId),
    }

    const preDecision = evaluateContinuation(scanInput)
    if (!preDecision.launch) {
      return {
        launched: false,
        ...(preDecision.skipReason ? { skipReason: preDecision.skipReason } : {}),
      }
    }

    // All scan-time guards passed — try to take the single permit.
    const permit = deps.semaphore.tryAcquire()
    if (permit === null) return { launched: false, skipReason: "semaphore-busy" }

    try {
      // RE-READ the status at launch — the goal may have changed (became
      // limited/blocked/completed/paused or was cleared) while we acquired.
      const statusAtLaunch = readStatus(deps, threadId)
      const launchDecision = evaluateContinuation({
        ...scanInput,
        goalStatusAtLaunch: statusAtLaunch,
      })
      if (!launchDecision.launch) {
        return {
          launched: false,
          ...(launchDecision.skipReason ? { skipReason: launchDecision.skipReason } : {}),
        }
      }
      await deps.resume(threadId)
      return { launched: true }
    } finally {
      permit.release()
    }
  } catch {
    return { launched: false }
  }
}

const readStatus = (deps: ContinuationDeps, threadId: string): ObjectiveStatus | null => {
  try {
    return deps.objective.get(threadId)?.status ?? null
  } catch {
    return null
  }
}

const probeIdle = (fn: (id: string) => boolean, id: string): boolean => {
  try {
    return fn(id) === true
  } catch {
    return false // a throwing idle probe blocks continuation (treated not-idle)
  }
}
