/**
 * Cross-subagent todo readback — data types (ADR-0255).
 *
 * Pure types only — no factory, no runtime state. Matches Roo wire
 * format: status arm uses underscore (`in_progress`, `completed`).
 * Intentionally distinct from ADR-0219's `FocusTodo` (hyphen arm) —
 * the slices are siblings, not the same type.
 *
 * `exactOptionalPropertyTypes` posture: NO optional fields on the
 * snapshot shape; an absent value would be `undefined` and that fights
 * the tsconfig. `TodoItem.id` and `TodoItem.text` are required.
 */

/** 3-state lifecycle for a todo item. Underscore form per Roo wire. */
export type TodoStatus = "pending" | "in_progress" | "completed"

/** One todo item — minimal shape. `id` is the merge key for
 *  `propagate`; `text` is free-form display. */
export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly status: TodoStatus
}

/** Frozen snapshot of one session's todo list at a moment in time.
 *  `updatedAt` is strictly monotonic per session (see store invariant
 *  HELL-TR-12). */
export interface TodoSnapshot {
  readonly items: readonly TodoItem[]
  readonly updatedAt: number
}

/** Error shape for `updateFrom`. Only failure mode in MVP is
 *  unknown-session. Kept open for future arms (e.g.,
 *  "snapshot-corrupt") without churn. */
export type UpdateError = {
  readonly kind: "session-not-found"
  readonly sessionId: string
}
