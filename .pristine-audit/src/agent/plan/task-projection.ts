/**
 * RFC07-3 — task compatibility projection (pure read model).
 *
 * A Claude-compatible read alias over the canonical {@link Plan}. This module
 * introduces **no storage**: `owner`/`blockedBy`/`blocks` are derived on every
 * read from the sole write vocabulary (`assignee` + `dependencies`). There is
 * no stored reverse edge, no second `owner` field, and no mutation surface.
 *
 * Canonical mapping:
 *
 *   owner     := todo.assignee                          (omitted when absent)
 *   blockedBy := todo.dependencies                      (canonical inbound edge)
 *   blocks(A) := all todo ids B where A ∈ B.dependencies (reverse edge)
 *
 * Determinism: canonical todo order is (`createdAt`, then `id`). Every edge
 * array — inbound (`blockedBy`) and reverse (`blocks`) — is emitted in that same
 * canonical order, so object insertion order can never affect output. Empty edge
 * sets are explicit `[]` (never `undefined`). `owner` is omitted (key-absent)
 * when `assignee` is absent, matching the render contract.
 */

import type { Plan, TodoItem, TodoStatus } from "./types"

/**
 * One projected task row. `owner` is optional (omitted when the canonical
 * `assignee` is absent). `blockedBy`/`blocks` are always present, possibly
 * empty. This shape is mirrored structurally by `ProjectedPlanTask` in
 * `@/tool/types/context-seams.ts` for cross-slice by-value flow.
 */
export interface ProjectedPlanTask {
  readonly id: string
  /** RFC12-1 — the todo's display title (`content`), carried so a graph render
   *  (`plan-to-mermaid`) can label the node without a second projection pass.
   *  A pure display field; never a write vocabulary / control-flow input. */
  readonly title: string
  /** RFC12-1 — the todo's lifecycle status, carried so a graph render can class
   *  the node (pending/in_progress/completed/cancelled/blocked). Display-only. */
  readonly status: TodoStatus
  readonly owner?: string
  readonly blockedBy: readonly string[]
  readonly blocks: readonly string[]
}

/** Canonical todo comparator: `createdAt` ascending, ties broken by `id`. */
const byCanonicalOrder = (a: TodoItem, b: TodoItem): number =>
  a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/**
 * Pure projection of the canonical plan into Claude-compatible task rows.
 * Sorts the todo set once into canonical order, builds one reverse-edge map
 * from `dependencies`, and emits every row + edge array in that same order.
 */
export const projectPlanTasks = (plan: Plan): readonly ProjectedPlanTask[] => {
  const ordered = Object.values(plan.todos).slice().sort(byCanonicalOrder)

  // Membership set of REAL todo ids so a dangling dependency edge (which the DAG
  // validator normally rejects at mutation time) never invents a phantom blocker.
  const known = new Set(ordered.map((t) => t.id))

  // Reverse-edge map built by walking `ordered` once: each `blocks[dep]` list is
  // appended in canonical iteration order, so no second sort is needed.
  const blocksOf = new Map<string, string[]>()
  for (const t of ordered) {
    for (const dep of t.dependencies) {
      if (!known.has(dep)) continue // dangling edge — not a live blocker
      const list = blocksOf.get(dep)
      if (list === undefined) blocksOf.set(dep, [t.id])
      else list.push(t.id)
    }
  }

  return ordered.map(
    (t): ProjectedPlanTask => ({
      id: t.id,
      title: t.content,
      status: t.status,
      ...(t.assignee !== undefined ? { owner: t.assignee } : {}),
      // `blockedBy` is the canonical inbound edge, verbatim — the DAG validator
      // already rejects dangling/self/cycle deps at mutation time, so no filter.
      blockedBy: t.dependencies,
      blocks: blocksOf.get(t.id) ?? [],
    }),
  )
}
