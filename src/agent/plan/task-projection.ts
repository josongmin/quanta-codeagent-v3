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

import type { Plan, TodoItem } from "./types"

/**
 * One projected task row. `owner` is optional (omitted when the canonical
 * `assignee` is absent). `blockedBy`/`blocks` are always present, possibly
 * empty. This shape is mirrored structurally by `ProjectedPlanTask` in
 * `@/tool/types/context-seams.ts` for cross-slice by-value flow.
 */
export interface ProjectedPlanTask {
  readonly id: string
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

  // Reverse-edge map: for each dependency `dep`, remember the canonical rank of
  // the dependent so `blocks[dep]` can be emitted in canonical order without a
  // second sort. Only edges whose endpoints both exist as real todos count.
  const rank = new Map<string, number>()
  ordered.forEach((t, i) => rank.set(t.id, i))

  const blocksOf = new Map<string, string[]>()
  for (const t of ordered) {
    for (const dep of t.dependencies) {
      if (!rank.has(dep)) continue // dangling edge — not a live blocker
      const list = blocksOf.get(dep)
      if (list === undefined) blocksOf.set(dep, [t.id])
      else list.push(t.id)
    }
  }
  // Each `blocks` list was appended in canonical iteration order already, so no
  // re-sort is needed; the pushes happened while walking `ordered`.

  return ordered.map((t): ProjectedPlanTask => ({
    id: t.id,
    ...(t.assignee !== undefined ? { owner: t.assignee } : {}),
    // `blockedBy` is the canonical inbound edge, verbatim — the DAG validator
    // already rejects dangling/self/cycle deps at mutation time, so no filter.
    blockedBy: t.dependencies,
    blocks: blocksOf.get(t.id) ?? [],
  }))
}
