/**
 * Closed `TodoStatus` transition matrix (ADR-0093 draft, 2026-05-23).
 *
 * Pure module: a frozen lookup table + a pure predicate. The mutations layer
 * (`mutations.ts`) consults `isValidTransition` whenever a {@link TodoPatch}
 * sets `status`, and emits `PlanMutationError` `invalid_status_transition` on
 * denial.
 *
 * Rules (per docs/plans/plan-mode-sota-plus-plus.md §1):
 *
 *   pending      → in_progress | cancelled | blocked
 *   in_progress  → completed | blocked | cancelled
 *   blocked      → in_progress | cancelled
 *   completed    → (terminal — no outgoing)
 *   cancelled    → (terminal — no outgoing)
 *
 * Self-transitions are ALWAYS allowed at this layer (e.g. `pending → pending`).
 * The mutations layer is responsible for noop semantics (version bump without
 * touching `updatedAt` shouldn't happen — but a no-op status patch is legal).
 *
 * The matrix is hand-rolled (not derived from a graph) so a future status
 * literal forces an explicit decision at every callsite.
 */

import type { TodoStatus } from "./types"

/**
 * What each `TodoStatus` can transition INTO (NOT including self).
 * Terminal statuses (`completed`, `cancelled`) map to empty arrays.
 */
export const TRANSITION_MATRIX: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = Object.freeze({
  pending: Object.freeze(["in_progress", "cancelled", "blocked"] as const) as readonly TodoStatus[],
  in_progress: Object.freeze(["completed", "blocked", "cancelled"] as const) as readonly TodoStatus[],
  blocked: Object.freeze(["in_progress", "cancelled"] as const) as readonly TodoStatus[],
  completed: Object.freeze([] as const) as readonly TodoStatus[],
  cancelled: Object.freeze([] as const) as readonly TodoStatus[],
})

/**
 * Returns true iff `from → to` is legal. Self-transitions are allowed (the
 * mutations layer treats them as noop). Closed enum — adding a new
 * `TodoStatus` will require updating {@link TRANSITION_MATRIX}.
 */
export function isValidTransition(from: TodoStatus, to: TodoStatus): boolean {
  if (from === to) return true
  return TRANSITION_MATRIX[from].includes(to)
}
