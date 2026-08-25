/**
 * RFC-03 C1 — authority-level domain model: per-thread revision + the immutable
 * thread state needed for EXACT restore.
 *
 * The public `Objective` (`./types`) is a DERIVED projection; it omits the
 * internal `explicitStatus` intent and the transient usage window. A faithful
 * undo/restore must round-trip those too, so the authority captures an
 * `ObjectiveThreadSnapshot` (the full serializable per-thread state, sourced
 * from the store's snapshot codec) alongside a monotonic `revision`.
 *
 * GOAL-01: `completed` is NEVER an explicit intent — only `active | paused`.
 * A thread whose objective was CLEARED keeps its revision as a TOMBSTONE
 * (`state: null`, `revision > 0`) so a stale pre-clear command is CAS-rejected
 * even after a restart.
 *
 * SLICE FENCE: imports ONLY sibling `./types`. Pure data.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ProgressReceipt } from "./progress-receipt"
import type { ExplicitObjectiveStatus, Objective } from "./types"

/** GOAL-02 — what kind of stopping contract an objective declares. */
export type ValidationContract = "missing" | "manual-only" | "checked"

/** The caller's last EXPLICIT status intent — the only status source on restore. */
export type ExplicitStatus = ExplicitObjectiveStatus

/**
 * The FULL serializable state of one thread's objective — the public projection
 * plus the two fields the projection drops. This is what `restore` writes back
 * verbatim so ids / met / ordering / blockers / next actions / provenance /
 * status intent survive an undo exactly.
 */
export interface ObjectiveThreadSnapshot {
  readonly objective: Objective
  /** The persisted explicit intent (never inferred from the derived status). */
  readonly explicitStatus: ExplicitStatus
  /** Transient usage-window expiry (epoch ms); omitted when no window is set. */
  readonly usageLimitedUntil?: number | undefined
}

/**
 * A per-thread domain snapshot with its revision. `state === null` ⇒ the thread
 * has no objective (never set, cleared — a tombstone when `revision > 0` — or
 * the snapshot predates one). `prepare` returns this as the immutable prior;
 * `restore` consumes it under CAS.
 */
export interface ObjectiveDomainSnapshot {
  readonly threadId: string
  readonly revision: number
  readonly state: ObjectiveThreadSnapshot | null
  /** Bounded durable evidence packets; never contains prompt/transcript text. */
  readonly progressReceipts?: readonly ProgressReceipt[]
  /** GOAL-02 — derived from the live criteria; absent when `state` is null. */
  readonly validationContract?: ValidationContract
}
