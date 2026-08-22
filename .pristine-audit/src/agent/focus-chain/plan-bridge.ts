/**
 * Focus-chain ⇆ plan bridge (ADR-0219 / ADR-0095).
 *
 * THE missing wire. The Cline-absorption focus-chain tracker (ADR-0219)
 * re-injects the current todos every N turns, but in production nothing fed
 * it: the structured plan tools (`create_plan` / `update_todos` / …) write
 * the producer-side {@link Plan} in `config.planStore`, while the tracker is a
 * SEPARATE store whose only prod `setTodos` call site cleared it to `[]`. So
 * the re-injection was wired-but-inert — the loop seam appended nothing
 * because the tracker stayed empty.
 *
 * This module is the ONE place {@link Plan} (producer) meets
 * {@link FocusChainPort} (consumer). Mirrors the `mutator-adapter` precedent:
 * the bridge lives at the meeting point and owns the by-value translation so a
 * producer/consumer drift fails at exactly one site. Type-only import of the
 * plan shape keeps the focus-chain core pure (no runtime coupling).
 *
 * CHANGE-GATED: {@link syncFocusChainFromPlan} calls `setTodos` ONLY when the
 * mapped list differs from what the tracker already holds. This is load-bearing
 * for the drift detector — `setTodos` records activity (resets the drift
 * window), so syncing every turn unconditionally would mean the tracker NEVER
 * drifts. "Plan changed" IS the activity signal, exactly matching Cline's
 * "model touched its todos" semantics.
 *
 * No heuristics — the status map is a closed switch with a `never` default arm.
 *
 * SSOT NOTE: once a plan exists it is the source of truth for the focus chain.
 * A `/focus-chain reset` (which clears the tracker to `[]`) is therefore
 * transient — the next turn's change-gated sync re-derives the list from the
 * live plan. To stop seeing it, drop the plan (plan-exit), not the projection.
 */

import type { Plan, TodoItem, TodoStatus } from "@/agent/plan/types"
import { byteCompare } from "@/shared/byte-compare"
import type { FocusChainPort, FocusTodo } from "./port"

/** Map a producer {@link TodoStatus} onto the 3-state {@link FocusTodo} arm.
 *  Lossy by construction (5 → 3): `completed`/`cancelled` are both terminal →
 *  `done`; `blocked` is still open → `pending`. Closed switch, `never` default. */
const mapState = (status: TodoStatus): FocusTodo["state"] => {
  switch (status) {
    case "pending":
      return "pending"
    case "in_progress":
      return "in-progress"
    case "completed":
      return "done"
    case "cancelled":
      // Terminal — no longer actionable. FocusTodo has no "cancelled" arm; the
      // closest faithful rendering is a closed `[x]`.
      return "done"
    case "blocked":
      // Still open (waiting on a dependency) — render as an unchecked `[ ]`.
      return "pending"
    default: {
      const _e: never = status
      return _e
    }
  }
}

/** Deterministic display order for a {@link Plan}'s todo Record: `createdAt`
 *  ascending, tie-broken by `id` (the order the type doc prescribes). */
const orderedTodos = (plan: Plan): TodoItem[] =>
  Object.values(plan.todos).sort((a, b) => a.createdAt - b.createdAt || byteCompare(a.id, b.id))

/** Project a {@link Plan} (or `null`) onto the {@link FocusTodo[]} the tracker
 *  consumes. `null` ⇒ empty list (a dropped plan clears the focus chain). */
export const planToFocusTodos = (plan: Plan | null): FocusTodo[] => {
  if (plan === null) return []
  return orderedTodos(plan).map((t) => ({ text: t.content, state: mapState(t.status) }))
}

/** Structural equality of two focus-todo lists by (text, state) in order. */
const sameTodos = (a: readonly FocusTodo[], b: readonly FocusTodo[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.text !== b[i]?.text || a[i]?.state !== b[i]?.state) return false
  }
  return true
}

/**
 * Sync `tracker` from the current {@link Plan}. Returns `true` iff the tracker
 * was actually updated (the mapped plan differed from its current todos).
 *
 * CHANGE-GATED so the drift detector survives: an unchanged plan is a no-op
 * (no `setTodos` ⇒ no activity record ⇒ drift keeps accumulating). Call this
 * once per turn before reading the injection.
 */
export const syncFocusChainFromPlan = (tracker: FocusChainPort, plan: Plan | null): boolean => {
  const next = planToFocusTodos(plan)
  if (sameTodos(tracker.snapshotTodos(), next)) return false
  tracker.setTodos(next)
  return true
}
