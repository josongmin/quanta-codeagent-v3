/**
 * ADR-0394 — Objective as a first-class per-thread object (types).
 *
 * The biggest structural gap in quanta is that a thread's work has no first-
 * class "objective" tying it together: the goal, what "done" means, what is
 * blocking, what to do next, and the budget the work runs against. Compaction,
 * resume, subagent-result attribution, and approval flows all currently infer
 * intent from message scrollback instead of reading a typed object.
 *
 * This file defines the CLOSED model. The authority (`./authority`) is the only
 * writer.
 *
 * GOAL-01 (domain v2):
 *   - every objective carries an AUTHORITY-issued `objectiveId` generation and
 *     the `createdBy` actor; evidence is bound to that id;
 *   - `create` / `replace` / `clear` are distinct operations (no `set`);
 *   - `completed` is DERIVED only — the explicit intent is `active | paused`;
 *   - usage is settled by the HOST (`settleAttempt`), never self-reported.
 *
 * Slice fence: NO imports from `@/agent` core (loop/dispatch/prompt/features/
 * types), `@/apps`, or sibling slices. Pure data + a closed port.
 *
 * exactOptional: optional fields are OMITTED when absent (never `: undefined`).
 */

import type {
  CheckSpec,
  CriterionDeclaration,
  ManualCompletionReceipt,
  VerifierCompletionReceipt,
} from "./criteria/model"
import type { ObjectiveActor, ObjectiveMigrationSource } from "./provenance"

/** Lifecycle of an objective.
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
 *   - `completed`      — all (>=1) success criteria met with trusted evidence.
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

/** The only two EXPLICIT status intents (GOAL-01: `completed` is never explicit). */
export type ExplicitObjectiveStatus = "active" | "paused"

/** What a blocker is waiting on. Closed enum — drives later HITL/resume logic. */
export type WaitingOn = "user" | "tool" | "network" | "child_agent"

/**
 * A single, individually-checkable definition of "done" (RFC-03 C4).
 *
 * The criterion separates DECLARATION from EVIDENCE and comes in two families:
 *   - `manual`  — completed by an explicit actor attestation (advisory). Carries
 *     a {@link ManualCompletionReceipt} when met.
 *   - `checked` — declares an IMMUTABLE {@link CheckSpec}; may be completed ONLY
 *     by a verifier receipt ({@link VerifierCompletionReceipt}), NEVER by a
 *     `markCriterion`. Verifier-only INDEPENDENT of the propose gate.
 *
 * `id` / `text` / `met` are shared by both arms (every existing reader keeps
 * working). `kind` is the discriminant; a `checked` criterion additionally
 * carries its `check`. `completion` (present only when `met`) is the evidence
 * receipt whose variant matches the arm.
 */
export interface ManualCriterion {
  readonly kind: "manual"
  readonly id: string
  readonly text: string
  readonly met: boolean
  readonly completion?: ManualCompletionReceipt | undefined
}

export interface CheckedCriterion {
  readonly kind: "checked"
  readonly id: string
  readonly text: string
  readonly met: boolean
  readonly check: CheckSpec
  readonly completion?: VerifierCompletionReceipt | undefined
}

export type SuccessCriterion = ManualCriterion | CheckedCriterion

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

/** The caps a definition or a same-ID budget amendment may set. */
export interface ObjectiveBudgetLimit {
  readonly maxTokens?: number | undefined
  readonly maxTurns?: number | undefined
}

/**
 * GOAL-01 — what a caller supplies to `create` / `replace`. It NEVER carries an
 * id: the authority mints the `objectiveId` and binds `createdBy` from the bound
 * actor. `successCriteria` (string-only, ⇒ manual) and `criteria` (rich
 * declarations; a runnable `check` ⇒ checked) may both be supplied
 * (concatenated). The goal text is bounded by the domain's `MAX_GOAL_CHARS`.
 */
export interface GoalDefinition {
  readonly goal: string
  readonly successCriteria?: readonly string[] | undefined
  readonly criteria?: readonly CriterionDeclaration[] | undefined
  readonly budget?: ObjectiveBudgetLimit | undefined
}

/** The first-class objective owned by exactly one thread. */
export interface Objective {
  /** Authority-issued generation identity (fresh on `create` / `replace`). */
  readonly objectiveId: string
  readonly threadId: string
  readonly goal: string
  /** The bound actor that created this generation (never model-supplied). */
  readonly createdBy: ObjectiveActor
  /** Present only when this generation was migrated from a legacy snapshot. */
  readonly migrationSource?: ObjectiveMigrationSource
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
 * Closed port — the SYSTEM-actor surface of the authority. ALL methods NO-THROW.
 * Unknown `threadId` ⇒ `null` (mutators) and `null` (get). `now` is an injected
 * clock seam (default `Date.now`) for deterministic tests.
 *
 * STATUS DERIVATION RULE (pinned in `tests/unit/objective-hellgate.test.ts`
 * and documented verbatim in `docs/decisions/0394-objective-first-class.md`):
 *
 *   1. `blockers.length > 0`           ⇒ status = "blocked"   (highest priority)
 *   2. else all criteria met (>= 1)    ⇒ status = "completed"  (auto-derived)
 *   3. else                            ⇒ the last explicit intent (active | paused)
 *
 * Auto-completion with ZERO criteria is rejected (vacuous truth is not "done").
 * There is NO explicit `completed` and NO self-reported usage on this surface.
 */
export interface ObjectivePort {
  /** Mint a new objective generation. `null` when one already exists on the
   *  thread or the definition is malformed (goal empty / over the ceiling). */
  create(threadId: string, definition: GoalDefinition): Objective | null
  /** Replace the live generation with a fresh id; every evidence family starts
   *  empty. `null` when no objective exists or the definition is malformed. */
  replace(threadId: string, definition: GoalDefinition): Objective | null
  /** Delete the objective and its progress. The thread revision keeps
   *  advancing (tombstone). `false` when nothing was live. */
  clear(threadId: string): boolean
  get(threadId: string): Objective | null
  setExplicitStatus(threadId: string, status: ExplicitObjectiveStatus): Objective | null
  /** Same-ID budget-cap amendment (never touches `*Used`). */
  amendBudget(threadId: string, budget: ObjectiveBudgetLimit): Objective | null
  addBlocker(threadId: string, blocker: { reason: string; waitingOn: WaitingOn }): Objective | null
  clearBlocker(threadId: string, blockerId: string): Objective | null
  setNextActions(threadId: string, actions: readonly string[]): Objective | null
  markCriterion(threadId: string, criterionId: string, met: boolean): Objective | null
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
