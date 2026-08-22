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
 * SLICE FENCE: imports ONLY sibling `./types`. Pure data.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { Objective } from "./types"

/** The caller's last EXPLICIT status intent — the only status source on restore
 *  (mirrors the store's internal `explicitStatus` so the derived status is
 *  reconstructed, never conflated with auto-derived completion). */
export type ExplicitStatus = "active" | "paused" | "completed"

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
 * has no objective (either never set, or the snapshot predates one). `prepare`
 * returns this as the immutable prior; `restore` consumes it under CAS.
 */
export interface ObjectiveDomainSnapshot {
  readonly threadId: string
  readonly revision: number
  readonly state: ObjectiveThreadSnapshot | null
}
