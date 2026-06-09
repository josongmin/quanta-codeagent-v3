/**
 * QUANTA_WEB_AGENT_STATE — pure plan-delta reducer.
 *
 * The agent-state channel ships a full plan snapshot on `plan.created` /
 * `plan.snapshot` and an incremental `AgentStatePlanDelta` on every
 * `plan.updated`. This module folds a delta onto the current plan so the
 * surface keeps a single live `AgentStatePlan` instead of re-rendering from a
 * snapshot each tick.
 *
 * Shapes are the COPIED frontend mirror in `../types/protocol.ts` (the
 * copy-not-import rule — the web bundle lives outside the bun tsconfig
 * `paths`). The 5 delta kinds are the surface-friendly granular taxonomy the
 * agent-state wire defines (NOT the coarser canonical `@/agent/plan` taxonomy):
 *
 *   - `todo_added`           → append `{ id: todoId, title: todoTitle, status:
 *                              "pending" }` (a fresh todo defaults to pending).
 *   - `todo_removed`         → drop the todo whose id is `todoId`.
 *   - `todo_status_changed`  → set that todo's `status` to `toStatus`.
 *   - `todo_renamed`         → set that todo's `title` to `toName`.
 *   - `plan_renamed`         → set the plan's `name` to `toName`.
 *
 * Each applied delta also stamps the plan's `version` from the `plan.updated`
 * frame so the surface's version stays monotonic with the daemon's.
 *
 * OUT-OF-ORDER SAFE: a delta that arrives with NO current plan (the
 * `plan.created` / `plan.snapshot` has not been seen yet) is a no-op — the
 * reducer returns the input plan unchanged (here `null`). A reorder where the
 * snapshot lands after a delta therefore never corrupts state: the snapshot
 * wins and later deltas fold onto it. Likewise a delta naming an unknown todo
 * (`todo_removed` / `todo_status_changed` / `todo_renamed`) or missing its
 * required field is a no-op on the todo list — the plan is returned with only
 * the version bumped, never throwing.
 *
 * PURE: no I/O, no clock, no `@/agent` runtime — a referentially-transparent
 * fold the hook (and the node test env) can exercise directly.
 */

import type { AgentStatePlan, AgentStatePlanDelta, AgentStateTodo } from "../types/protocol"

/**
 * The live plan + delta shapes this reducer folds over. Re-exported aliases of
 * the COPIED wire mirror (`../types/protocol.ts`) so the consumer
 * (`agent-state-hooks.ts`) and the panel name a single `PlanMirror` /
 * `PlanDeltaMirror` contract instead of reaching for the verbose
 * `AgentStatePlan*` wire names. Structurally identical — they ARE the wire
 * shapes (copy-not-import rule; the web bundle lives outside the bun tsconfig
 * `paths`).
 */
export type PlanMirror = AgentStatePlan
export type PlanDeltaMirror = AgentStatePlanDelta

/** Replace the todo with `id` via `mapper`, leaving the rest untouched. An
 *  unknown id maps to an unchanged list (no-op — never throws). */
const mapTodo = (
  todos: readonly AgentStateTodo[],
  id: string,
  mapper: (todo: AgentStateTodo) => AgentStateTodo,
): readonly AgentStateTodo[] => todos.map((todo) => (todo.id === id ? mapper(todo) : todo))

/* ------------------------------------------------------------------ */
/* Per-kind folds — each a thin, independently-readable transform that  */
/* returns the SAME plan reference when its delta cannot apply (missing  */
/* required field / unknown todo id ⇒ list / name untouched). Extracted  */
/* out of the dispatch so neither it nor this module trips the cognitive */
/* complexity ceiling.                                                  */
/* ------------------------------------------------------------------ */

const foldTodoAdded = (plan: PlanMirror, delta: PlanDeltaMirror): PlanMirror => {
  // Missing required field, or an add colliding with an existing id (the
  // snapshot already carries it), is a no-op — never duplicate the id.
  if (delta.todoId === undefined || delta.todoTitle === undefined) return plan
  if (plan.todos.some((todo) => todo.id === delta.todoId)) return plan
  const added: AgentStateTodo = { id: delta.todoId, title: delta.todoTitle, status: "pending" }
  return { ...plan, todos: [...plan.todos, added] }
}

const foldTodoRemoved = (plan: PlanMirror, delta: PlanDeltaMirror): PlanMirror =>
  delta.todoId === undefined
    ? plan
    : { ...plan, todos: plan.todos.filter((todo) => todo.id !== delta.todoId) }

const foldTodoStatusChanged = (plan: PlanMirror, delta: PlanDeltaMirror): PlanMirror => {
  const { todoId, toStatus } = delta
  if (todoId === undefined || toStatus === undefined) return plan
  return { ...plan, todos: mapTodo(plan.todos, todoId, (t) => ({ ...t, status: toStatus })) }
}

const foldTodoRenamed = (plan: PlanMirror, delta: PlanDeltaMirror): PlanMirror => {
  const { todoId, toName } = delta
  if (todoId === undefined || toName === undefined) return plan
  return { ...plan, todos: mapTodo(plan.todos, todoId, (t) => ({ ...t, title: toName })) }
}

const foldPlanRenamed = (plan: PlanMirror, delta: PlanDeltaMirror): PlanMirror =>
  delta.toName === undefined ? plan : { ...plan, name: delta.toName }

/** Dispatch table keyed by delta kind — a flat lookup (no nesting) so the
 *  applier stays under the cognitive-complexity ceiling. A kind absent here
 *  (forward-compat) keeps the plan; the version was already stamped. */
const FOLDERS: Record<
  PlanDeltaMirror["kind"],
  (plan: PlanMirror, delta: PlanDeltaMirror) => PlanMirror
> = {
  todo_added: foldTodoAdded,
  todo_removed: foldTodoRemoved,
  todo_status_changed: foldTodoStatusChanged,
  todo_renamed: foldTodoRenamed,
  plan_renamed: foldPlanRenamed,
}

/**
 * Fold one plan delta onto the current plan, stamping `version`.
 *
 * @param plan    The current live plan, or `null` if none has been seen yet.
 * @param delta   The incremental change from a `plan.updated` frame.
 * @param version The new plan version carried alongside the delta.
 * @returns The next plan, or the input `plan` UNCHANGED (incl. `null`) when the
 *          delta cannot apply (no current plan / missing required field /
 *          unknown todo id ⇒ todo list untouched, only version advances).
 */
export const applyPlanDelta = (
  plan: PlanMirror | null,
  delta: PlanDeltaMirror,
  version: number,
): PlanMirror | null => {
  // OUT-OF-ORDER SAFE: a delta with no current plan is a no-op. The snapshot
  // that creates the plan wins; later deltas fold onto it.
  if (plan === null) return plan
  // Stamp the new version first, then fold the kind-specific change onto it —
  // an inapplicable delta still advances the version (it really happened on the
  // daemon) but leaves the todo list / name untouched. An unrecognised kind
  // (forward-compat) has no folder ⇒ version-only bump.
  const versioned: PlanMirror = { ...plan, version }
  const fold = FOLDERS[delta.kind]
  return fold === undefined ? versioned : fold(versioned, delta)
}
