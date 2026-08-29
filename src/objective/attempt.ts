/**
 * GOAL-04 — attributed objective ATTEMPTS.
 *
 * Only explicitly attributed goal work is charged to an objective: a turn the
 * wake controller enqueued (`autonomous-continuation`) or a user-requested goal
 * turn (`user-requested-goal-work`). Ordinary chat carries no attempt and moves
 * no objective budget.
 *
 * The HOST mints the attempt (never the model) and hands it to the runtime
 * through an {@link ObjectiveAttemptSlot} — a single-occupancy, host-owned side
 * channel the CLI/web surface claims right before the turn it attributes and
 * the runtime takes at the start of that turn. Turns are serialized per
 * session, so one slot cannot be double-claimed by two live turns; a stale
 * claim that was never taken is released by the surface.
 *
 * Two-phase accounting (durable): `beginAttempt` reserves the turn (and the
 * autonomous hard-cap slot) BEFORE the paid provider call; `settleAttempt`
 * closes it exactly once with the measured usage. A crash between the two
 * leaves the attempt STARTED — the slot stays consumed and is never replayed.
 *
 * SLICE FENCE: pure — no runtime imports.
 */

export type ObjectiveAttemptProvenance = "autonomous-continuation" | "user-requested-goal-work"

export interface ObjectiveAttemptContext {
  readonly threadId: string
  readonly objectiveId: string
  /** Audit evidence (not a CAS target): the revision the host saw at claim time. */
  readonly startedRevision: number
  readonly attemptId: string
  readonly provenance: ObjectiveAttemptProvenance
  readonly executionMode: "foreground" | "background"
}

/** The durable STARTED record the authority keeps until settlement. */
export interface StartedObjectiveAttempt {
  readonly attemptId: string
  readonly provenance: ObjectiveAttemptProvenance
  readonly executionMode: "foreground" | "background"
  readonly startedRevision: number
  readonly startedAt: number
}

/** Per-objective attempt accounting (persisted with the objective). */
export interface ObjectiveAttemptState {
  /** Durable starts of AUTONOMOUS attempts — the product hard-cap counter
   *  (GOAL-06 reads it; it is never reset by pause/resume/amend). */
  readonly autonomousTurnsStarted: number
  /** The unsettled started attempt, if any. */
  readonly started?: StartedObjectiveAttempt
}

/** What `beginAttempt` carries (the authority stamps `startedAt`). */
export interface ObjectiveAttemptStart {
  readonly objectiveId: string
  readonly attemptId: string
  readonly provenance: ObjectiveAttemptProvenance
  readonly executionMode: "foreground" | "background"
  readonly startedRevision: number
}

export type ObjectiveAttemptSlotStatus =
  | { readonly kind: "empty" }
  | { readonly kind: "claimed"; readonly attempt: ObjectiveAttemptContext }
  | {
      readonly kind: "fail-stopped"
      readonly reason: string
      /** The objective generation the failed attempt belonged to; a NEW
       *  generation (different objectiveId) is what lifts the fail-stop. */
      readonly objectiveId?: string | undefined
    }

/**
 * Single-occupancy host side channel between the surface (claims) and the
 * runtime (takes). Once FAIL-STOPPED (terminal persistence failed after a
 * settlement, so the durable state is uncertain) no further attempt may be
 * claimed until an operator starts a new objective generation.
 */
export interface ObjectiveAttemptSlot {
  /** Reserve the slot for the next turn. `false` when occupied or fail-stopped. */
  claim(attempt: ObjectiveAttemptContext): boolean
  /** Consume the claim (the runtime, at turn start). */
  take(): ObjectiveAttemptContext | undefined
  /** Drop a claim the turn never consumed (the surface, when the turn did not start). */
  release(): void
  /** Mark the session fail-stopped (durable uncertainty). Terminal until `recover`. */
  failStop(reason: string, objectiveId?: string): void
  /** Explicit operator recovery (a new objective generation was started). */
  recover(): void
  status(): ObjectiveAttemptSlotStatus
}

export const createObjectiveAttemptSlot = (): ObjectiveAttemptSlot => {
  let claimed: ObjectiveAttemptContext | undefined
  let failStop: string | undefined
  let failStopObjectiveId: string | undefined
  return {
    claim(attempt) {
      if (failStop !== undefined || claimed !== undefined) return false
      claimed = attempt
      return true
    },
    take() {
      const current = claimed
      claimed = undefined
      return current
    },
    release() {
      claimed = undefined
    },
    failStop(reason, objectiveId) {
      failStop = reason
      failStopObjectiveId = objectiveId
      claimed = undefined
    },
    recover() {
      failStop = undefined
      failStopObjectiveId = undefined
    },
    status() {
      if (failStop !== undefined) {
        return { kind: "fail-stopped", reason: failStop, objectiveId: failStopObjectiveId }
      }
      return claimed === undefined ? { kind: "empty" } : { kind: "claimed", attempt: claimed }
    },
  }
}

const PROVENANCES: ReadonlySet<string> = new Set<ObjectiveAttemptProvenance>([
  "autonomous-continuation",
  "user-requested-goal-work",
])

export const isObjectiveAttemptProvenance = (v: unknown): v is ObjectiveAttemptProvenance =>
  typeof v === "string" && PROVENANCES.has(v)
