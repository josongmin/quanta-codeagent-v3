/**
 * Multi-agent coordination — Capability A: Task dependency DAG (PURE core).
 *
 * Plan: docs/plans/multiagent-coordination.md §2.A + §3 + §5.
 *
 * This file is a PURE, NO-THROW leaf: no I/O, no clock, no LLM, no `Date.now`,
 * no `Math.random`, no `localeCompare`. Every adversarial input returns a typed
 * value, never an exception. The side-effecting dispatch (the batch runner) is
 * driven SEPARATELY by `dag-gate.ts`, which consumes this core.
 *
 * Slice fence (biome `src/subagent/**`): imports ONLY `@/shared`. The
 * `TaskState` union is MIRRORED locally (the canonical declaration lives in
 * `@/mcp/tasks/types`, which `@/subagent` may NOT import — the fence forbids
 * `@/mcp`). The union is rmcp-0.15-closed (a 6th arm would be an MCP spec
 * change), so the mirror is safe and exhaustiveness-checked at the bottom.
 *
 * Invariants (plan §5):
 *  - A cyclic graph is REJECTED at submit (`detectCycle`) — never dispatched.
 *  - An edge to an unknown id is REJECTED (typed) — a dangling dep is a
 *    modeling bug, surfaced loudly rather than silently making a node
 *    permanently un-ready.
 *  - A `failed`/`cancelled` dependency BLOCKS its dependents forever
 *    (`blockedTasks`) — surfaced so the leader sees the dead branch; NEVER an
 *    indefinite silent hang.
 *  - Order is deterministic via `byteCompare` (locale-independent), never input
 *    order, never `localeCompare`.
 */

import { byteCompare } from "@/shared"

/** Lifecycle state of a single task. MIRROR of `@/mcp/tasks/types#TaskState`
 *  (the fence forbids `@/subagent` → `@/mcp`). rmcp-0.15-closed 5-arm union. */
export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled"

/** A node in the dependency graph. `dependsOn` = the ids this task is blocked by
 *  (`blockedBy`); the reverse edges (`blocks`) are derived. */
export interface TaskNode {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly state: TaskState
}

/** Result of `detectCycle`: either acyclic, or a typed rejection carrying the
 *  offending path. `cycle` lists the ids on the rejected path (for a cycle, the
 *  member ids; for an unknown/duplicate edge, the offending id(s)). */
export type CycleCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly cycle: readonly string[] }

/** Terminal-FAILURE states: a dependency in one of these blocks its dependents
 *  PERMANENTLY (they can never become ready). `cancelled` is grouped with
 *  `failed` because a cancelled prerequisite never produces its output. */
const isDeadDep = (s: TaskState): boolean => s === "failed" || s === "cancelled"

/** Index nodes by id. Returns `undefined` when an id appears twice (an
 *  ambiguous graph — the caller treats that as a rejection). */
const indexById = (nodes: readonly TaskNode[]): Map<string, TaskNode> | undefined => {
  const map = new Map<string, TaskNode>()
  for (const n of nodes) {
    if (map.has(n.id)) return undefined
    map.set(n.id, n)
  }
  return map
}

/** The duplicate ids in a node list (empty when all ids are unique). */
const duplicateIds = (nodes: readonly TaskNode[]): string[] => {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) dupes.push(n.id)
    else seen.add(n.id)
  }
  return dupes
}

/** First dangling edge `[node, dep]` (dep id not in the graph), or undefined. */
const danglingEdge = (
  nodes: readonly TaskNode[],
  byId: Map<string, TaskNode>,
): [string, string] | undefined => {
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!byId.has(dep)) return [n.id, dep]
    }
  }
  return undefined
}

/** DFS-colour marker: white (unseen) / grey (on stack) / black (done). */
type Colour = 0 | 1 | 2
interface Frame {
  id: string
  next: number
}

/** Close the cycle path: the DFS-stack suffix from `dep` to the top, plus `dep`
 *  again to make the loop explicit. */
const cyclePath = (stack: readonly Frame[], dep: string): string[] => {
  const fromIdx = stack.findIndex((f) => f.id === dep)
  const path = (fromIdx >= 0 ? stack.slice(fromIdx) : stack).map((f) => f.id)
  path.push(dep)
  return path
}

/**
 * Iterative 3-colour DFS from `start`. Returns the cycle path on a grey→grey
 * back-edge, else undefined (subtree acyclic). Mutates the shared `colour` map
 * so a later root skips already-blackened nodes. Iterative (not recursive) to
 * survive a very long chain without a stack overflow.
 */
const dfsFindCycle = (
  start: string,
  byId: Map<string, TaskNode>,
  colour: Map<string, Colour>,
): string[] | undefined => {
  const stack: Frame[] = [{ id: start, next: 0 }]
  colour.set(start, 1)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break
    const deps = byId.get(frame.id)?.dependsOn ?? []
    if (frame.next >= deps.length) {
      colour.set(frame.id, 2)
      stack.pop()
      continue
    }
    const dep = deps[frame.next]
    frame.next++
    if (dep === undefined) continue
    const c = colour.get(dep)
    if (c === 1) return cyclePath(stack, dep)
    if (c === 0) {
      colour.set(dep, 1)
      stack.push({ id: dep, next: 0 })
    }
  }
  return undefined
}

/**
 * Reject a cyclic graph, a graph with an edge to an unknown id, or a graph with
 * duplicate ids. PURE / NO-THROW. DFS with a 3-colour (white/grey/black) marker:
 * a grey→grey back-edge is a cycle.
 */
export const detectCycle = (nodes: readonly TaskNode[]): CycleCheck => {
  const byId = indexById(nodes)
  if (byId === undefined) return { ok: false, cycle: duplicateIds(nodes) }

  const dangling = danglingEdge(nodes, byId)
  if (dangling !== undefined) return { ok: false, cycle: dangling }

  const colour = new Map<string, Colour>()
  for (const n of nodes) colour.set(n.id, 0)
  for (const start of nodes) {
    if (colour.get(start.id) !== 0) continue
    const cycle = dfsFindCycle(start.id, byId, colour)
    if (cycle !== undefined) return { ok: false, cycle }
  }
  return { ok: true }
}

/** Stable, locale-independent sort by id. Returns a NEW array (no mutation). */
const sortById = (nodes: readonly TaskNode[]): TaskNode[] =>
  [...nodes].sort((a, b) => byteCompare(a.id, b.id))

/**
 * The `pending` nodes whose EVERY `dependsOn` is `completed`. PURE. Deterministic
 * `byteCompare` order. A node with a missing dep id is treated as NOT ready (the
 * dep is absent, so it can never be `completed`); `detectCycle` rejects such a
 * graph before dispatch, so this is defensive belt-and-braces.
 */
export const readyTasks = (nodes: readonly TaskNode[]): TaskNode[] => {
  const byId = new Map<string, TaskNode>()
  for (const n of nodes) byId.set(n.id, n)
  const ready = nodes.filter((n) => {
    if (n.state !== "pending") return false
    return n.dependsOn.every((dep) => byId.get(dep)?.state === "completed")
  })
  return sortById(ready)
}

/**
 * The `pending` nodes that can NEVER become ready because at least one
 * dependency is `failed`/`cancelled` — DIRECTLY or TRANSITIVELY. PURE.
 * Deterministic `byteCompare` order. This is the dead-branch surface: the
 * leader sees these instead of waiting forever (plan §5 liveness invariant).
 */
export const blockedTasks = (nodes: readonly TaskNode[]): TaskNode[] => {
  const byId = new Map<string, TaskNode>()
  for (const n of nodes) byId.set(n.id, n)

  // Memoised "is this id on a dead branch?" with cycle-safe visitation.
  const dead = new Map<string, boolean>()
  const visiting = new Set<string>()
  const isDead = (id: string): boolean => {
    const cached = dead.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return false // cycle guard (rejected elsewhere)
    const n = byId.get(id)
    if (n === undefined) return false
    if (isDeadDep(n.state)) {
      dead.set(id, true)
      return true
    }
    visiting.add(id)
    let result = false
    for (const dep of n.dependsOn) {
      if (isDead(dep)) {
        result = true
        break
      }
    }
    visiting.delete(id)
    dead.set(id, result)
    return result
  }

  const blocked = nodes.filter((n) => n.state === "pending" && isDead(n.id))
  return sortById(blocked)
}

/**
 * Mark `id` as `completed` and return the new node set plus the nodes it just
 * unblocked (became ready). PURE / NO-THROW. Completing an unknown id, or a node
 * that is NOT currently `in_progress`/`pending`, releases nothing new (idempotent
 * — re-completing an already-completed node is a no-op for `newlyReady`).
 *
 * `newlyReady` = nodes ready AFTER the transition that were NOT ready before —
 * exactly the set the completion unblocked.
 */
export const onComplete = (
  nodes: readonly TaskNode[],
  id: string,
): { nodes: TaskNode[]; newlyReady: TaskNode[] } => {
  const target = nodes.find((n) => n.id === id)
  // Unknown id, or already terminal-completed ⇒ no transition, nothing new.
  if (target === undefined || target.state === "completed") {
    return { nodes: [...nodes], newlyReady: [] }
  }

  const before = new Set(readyTasks(nodes).map((n) => n.id))
  const next: TaskNode[] = nodes.map((n) =>
    n.id === id ? { id: n.id, dependsOn: n.dependsOn, state: "completed" } : n,
  )
  const afterReady = readyTasks(next)
  const newlyReady = afterReady.filter((n) => !before.has(n.id))
  return { nodes: next, newlyReady }
}

/** Compile-time exhaustiveness anchor for the mirrored union — adding a 6th arm
 *  to `TaskState` (an MCP spec change) forces this to be revisited. */
const _ALL_TASK_STATES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<TaskState>

export type { _ALL_TASK_STATES as TaskStateTuple }
