/**
 * ADR-0394 — Objective as a first-class per-thread object (types).
 *
 * The biggest structural gap in quanta is that a thread's work has no first-
 * class "objective" tying it together: the goal, what "done" means, what is
 * blocking, what to do next, and the budget the work runs against. Compaction,
 * resume, subagent-result attribution, and approval flows all currently infer
 * intent from message scrollback instead of reading a typed object.
 *
 * This file defines the CLOSED model. The store (`./store`) is the only
 * mutator. This wave is MODEL ONLY — nothing here is wired into the agent
 * loop, dispatch, features, prompt, or any tool. It is a self-contained slice.
 *
 * Slice fence: NO imports from `@/agent` core (loop/dispatch/prompt/features/
 * types), `@/apps`, or sibling slices. Pure data + a closed port.
 *
 * exactOptional: optional fields are OMITTED when absent (never `: undefined`).
 */

/** Lifecycle of an objective. `completed` may be auto-derived (see port doc).
 *
 * H17 (Codex `core/src/goals.rs`) makes this the SIX-state goal machine:
 *
 *   active | paused | usage_limited | budget_limited | completed | blocked
 *
 * Two values are EXPLICIT caller intents: `active` (default) and `paused`
 * (manually suspended — does NOT auto-resume on idle). The other four are
 * DERIVED (never set directly):
 *   - `blocked`        — derived from a non-empty blocker list (highest).
 *   - `usage_limited`  — H17 transient, AUTO-RESETTING external usage/rate
 *                        window. While `now < usageLimitedUntil` (and the store
 *                        enforces) the status is `usage_limited`; once the clock
 *                        passes the window it re-derives back to the explicit
 *                        value — no sticky flag. Distinct from `budget_limited`
 *                        (the goal's own hard cap).
 *   - `budget_limited` — the goal's own token/turn cap reached (`tokensUsed >=
 *                        maxTokens` or `turnsUsed >= maxTurns`); a HARD stop.
 *   - `completed`      — all (>=1) success criteria met.
 *
 * `usage_limited` / `budget_limited` surface ONLY when the store is constructed
 * with `enforceBudget: true`. With the default (informational) store the status
 * NEVER takes either derived limit value — byte-identical to ADR-0394. */
export type ObjectiveStatus =
  | "active"
  | "paused"
  | "usage_limited"
  | "budget_limited"
  | "completed"
  | "blocked"

/** What a blocker is waiting on. Closed enum — drives later HITL/resume logic. */
export type WaitingOn = "user" | "tool" | "network" | "child_agent"

/** A single, individually-checkable definition of "done". */
export interface SuccessCriterion {
  readonly id: string
  readonly text: string
  readonly met: boolean
}

/** Something preventing forward progress. `since` is an epoch-ms stamp. */
export interface Blocker {
  readonly id: string
  readonly reason: string
  readonly waitingOn: WaitingOn
  readonly since: number // epoch ms
}

/** Budget envelope. `max*` are optional caps; `*Used` are running totals. */
export interface ObjectiveBudget {
  readonly maxTokens?: number
  readonly tokensUsed: number
  readonly maxTurns?: number
  readonly turnsUsed: number
}

/** The first-class objective owned by exactly one thread. */
export interface Objective {
  readonly threadId: string
  readonly goal: string
  readonly successCriteria: readonly SuccessCriterion[]
  readonly status: ObjectiveStatus
  readonly budget: ObjectiveBudget
  readonly blockers: readonly Blocker[]
  readonly nextActions: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Serializable point-in-time view of every objective in a store. */
export interface ObjectiveSnapshot {
  readonly objectives: readonly Objective[]
}

/**
 * Closed port. ALL methods NO-THROW. Unknown `threadId` ⇒ `null` (mutators)
 * and `null` (get). `now` is an injected clock seam (default `Date.now`) for
 * deterministic tests.
 *
 * STATUS DERIVATION RULE (pinned in `tests/unit/objective-hellgate.test.ts`
 * and documented verbatim in `docs/decisions/0394-objective-first-class.md`):
 *
 *   1. `blockers.length > 0`           ⇒ status = "blocked"   (highest priority)
 *   2. else all criteria met (>= 1)    ⇒ status = "completed"  (auto-derived)
 *   3. else                            ⇒ the last explicit `updateStatus`
 *                                        value, defaulting to "active".
 *
 * `updateStatus("completed")` is honored ONLY while NOT blocked; a non-empty
 * blocker list always wins. Auto-completion with ZERO criteria is rejected
 * (vacuous truth is not "done").
 */
export interface ObjectivePort {
  set(
    threadId: string,
    init: {
      goal: string
      successCriteria?: readonly string[]
      budget?: { maxTokens?: number; maxTurns?: number }
    },
  ): Objective
  get(threadId: string): Objective | null
  updateStatus(threadId: string, status: ObjectiveStatus): Objective | null
  addBlocker(threadId: string, blocker: { reason: string; waitingOn: WaitingOn }): Objective | null
  clearBlocker(threadId: string, blockerId: string): Objective | null
  setNextActions(threadId: string, actions: readonly string[]): Objective | null
  markCriterion(threadId: string, criterionId: string, met: boolean): Objective | null
  recordUsage(threadId: string, used: { tokens?: number; turns?: number }): Objective | null
  /** H17 — mark a transient, AUTO-RESETTING external usage/rate limit on this
   *  goal until `untilEpochMs` (clock-derived). While `now < untilEpochMs` the
   *  derived status is `usage_limited` (when the store enforces); once the clock
   *  passes the window the status re-derives back to the explicit value — no
   *  sticky flag. A no-op under the informational store. Passing a non-finite
   *  or past `untilEpochMs` clears any window. */
  markUsageLimited(threadId: string, untilEpochMs: number): Objective | null
  list(): readonly Objective[]
  toSnapshot(): ObjectiveSnapshot
  fromSnapshot(snap: ObjectiveSnapshot): void
}
