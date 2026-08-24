/**
 * DAG validation for plan dependencies (ADR-0095 draft).
 *
 * Three pure exports operating on a `Readonly<Record<string, TodoItem>>` graph:
 *
 *   - {@link validateDag} — full-plan validation. Returns the first failure in
 *     the priority order `self_dependency` → `dependency_unknown` →
 *     `dependency_cycle`. Reports as a typed {@link PlanMutationError} via
 *     {@link PlanResult}.
 *   - {@link findCycle} — DFS w/ tri-state colour. Returns the cycle path
 *     (traversal order, NOT necessarily canonical) or `null`. Optional
 *     `startId` narrows the search to nodes reachable from that root.
 *   - {@link topologicalSort} — Kahn-style ordering with deterministic tie-
 *     break by id (lexicographic). Returns the ordered ids or, if the graph
 *     has a cycle, `{ cycle: [...] }` mirroring {@link findCycle}'s shape.
 *
 * Complexity is O(V+E) for all three. The 100-node perf hellgate pins this
 * (`tests/unit/agent/plan/dag-hell.test.ts` — "perf: 100-node DAG validation
 * under 50ms").
 *
 * Slice rule: pure module. No clock, no I/O, no logger, no allocation beyond
 * the result. Safe for hot-path mutation pre-flight.
 */

import type { PlanResult, TodoItem } from "./types"

/** Graph adjacency view: every todo id → its outgoing dependency ids.
 *  Built once at the top of each public entry-point. */
type AdjacencyView = Readonly<Record<string, readonly string[]>>

interface OrderedFrontier {
  push(id: string): void
  pop(): string | undefined
  readonly size: number
}

const createOrderedFrontier = (seed: readonly string[] = []): OrderedFrontier => {
  const heap = [...seed]
  /** Swap two IN-RANGE slots. `?? ""` only satisfies `noUncheckedIndexedAccess`; both callers
   *  have already established both indices are occupied, so the default never fires. */
  const swap = (i: number, j: number): void => {
    ;[heap[i], heap[j]] = [heap[j] ?? "", heap[i] ?? ""]
  }
  /** Heap key at `i`, with an OUT-OF-RANGE slot reading as +∞ so a missing child can never win a
   *  `<` comparison. (`siftUp` deliberately does NOT use this — it compares only in-range slots.) */
  const keyAt = (i: number): string => heap[i] ?? "\uffff"
  /** Index of the smallest key among `i` and its two children — `i` itself when neither child is
   *  smaller (which is `siftDown`'s stopping condition). */
  const minOfNodeAndChildren = (i: number): number => {
    const left = i * 2 + 1
    const right = left + 1
    let smallest = i
    if (keyAt(left) < keyAt(smallest)) smallest = left
    if (keyAt(right) < keyAt(smallest)) smallest = right
    return smallest
  }
  const siftUp = (idx: number): void => {
    let current = idx
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2)
      if ((heap[parent] ?? "") <= (heap[current] ?? "")) break
      swap(parent, current)
      current = parent
    }
  }
  const siftDown = (idx: number): void => {
    let current = idx
    while (true) {
      const smallest = minOfNodeAndChildren(current)
      if (smallest === current) break
      swap(current, smallest)
      current = smallest
    }
  }
  for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i -= 1) siftDown(i)
  return {
    push(id: string) {
      heap.push(id)
      siftUp(heap.length - 1)
    },
    pop() {
      if (heap.length === 0) return undefined
      const first = heap[0]
      const last = heap.pop()
      if (heap.length > 0 && last !== undefined) {
        heap[0] = last
        siftDown(0)
      }
      return first
    },
    get size() {
      return heap.length
    },
  }
}

/** Build adjacency from todos. Self-deps are emitted intact so the caller
 *  can detect them BEFORE any cycle walk (priority order matters). */
const buildAdjacency = (todos: Readonly<Record<string, TodoItem>>): AdjacencyView => {
  const adj: Record<string, readonly string[]> = {}
  for (const id of Object.keys(todos)) {
    const t = todos[id]
    adj[id] = t === undefined ? [] : t.dependencies
  }
  return adj
}

/**
 * Full DAG validation in three priority phases. Returns the FIRST failure
 * (no batching) so the caller learns one fixable problem at a time and the
 * test surface stays deterministic.
 *
 * Priority is fixed:
 *   1. `self_dependency` — a todo lists its own id in `dependencies`.
 *   2. `dependency_unknown` — a `dep` id does not exist in `todos`. The first
 *      encountered (by todo-key iteration order, which is insertion order in
 *      modern JS) is reported.
 *   3. `dependency_cycle` — full DFS over the remaining well-formed graph.
 */
export const validateDag = (todos: Readonly<Record<string, TodoItem>>): PlanResult<true> => {
  // Phase 1: self-deps. O(V+E).
  for (const id of Object.keys(todos)) {
    const t = todos[id]
    if (t === undefined) continue
    if (t.dependencies.includes(id)) {
      return { ok: false, error: { kind: "self_dependency", id } }
    }
  }
  // Phase 2: dangling refs. O(V+E).
  for (const id of Object.keys(todos)) {
    const t = todos[id]
    if (t === undefined) continue
    for (const dep of t.dependencies) {
      if (!(dep in todos)) {
        return { ok: false, error: { kind: "dependency_unknown", from: id, to: dep } }
      }
    }
  }
  // Phase 3: cycle detection. O(V+E).
  const cycle = findCycleInternal(buildAdjacency(todos), undefined)
  if (cycle !== null) {
    return { ok: false, error: { kind: "dependency_cycle", path: cycle } }
  }
  return { ok: true, value: true }
}

/**
 * DFS w/ tri-state colour. White = unvisited, Gray = on the current DFS path
 * (back-edge to a gray ⇒ cycle), Black = fully explored. Returns the cycle
 * path (from the back-edge target forward through the gray prefix back to
 * the back-edge source) or `null`.
 *
 * If `startId` is supplied, the search starts from that node and only walks
 * its reachable subgraph. Otherwise, every unvisited node is iterated in id
 * lexicographic order so the result is deterministic regardless of input
 * iteration order.
 */
export const findCycle = (
  todos: Readonly<Record<string, TodoItem>>,
  startId?: string,
): readonly string[] | null => findCycleInternal(buildAdjacency(todos), startId)

/** One entry on the iterative-DFS stack: a node plus the index of the next
 *  out-edge to consume from `adj[id]`. */
interface Frame {
  readonly id: string
  nextIdx: number
}

/** Rebuild the cycle path once a back-edge into `target` is found: the gray
 *  prefix of the stack from `target` forward, then `target` again to close the
 *  loop. Traversal order, NOT canonicalised — that IS the contract. */
const cyclePathFrom = (stack: readonly Frame[], target: string): readonly string[] => {
  const path: string[] = []
  let started = false
  for (const f of stack) {
    if (!started && f.id === target) started = true
    if (started) path.push(f.id)
  }
  path.push(target) // close the cycle
  return path
}

const findCycleInternal = (
  adj: AdjacencyView,
  startId: string | undefined,
): readonly string[] | null => {
  const colour: Record<string, 0 | 1 | 2> = {} // 0=white, 1=gray, 2=black
  const parent: Record<string, string | undefined> = {}
  let cycleResult: readonly string[] | null = null

  // Deterministic iteration: sort ids lexicographically when we visit roots.
  const roots = startId !== undefined ? [startId] : Object.keys(adj).slice().sort()

  /**
   * Advance the DFS by exactly ONE step from the top `frame`, mutating `stack`
   * and `colour` in place. Exactly one of these happens:
   *   - out-edges exhausted ⇒ paint the node black and POP it;
   *   - next edge is dangling/unknown ⇒ consume and skip it;
   *   - next edge hits a GRAY node ⇒ back-edge: return the cycle path;
   *   - next edge hits a WHITE node ⇒ paint gray, record parent, PUSH it;
   *   - next edge hits a BLACK node ⇒ already fully explored, skip.
   * Returns the cycle path only in the back-edge case, else `null`.
   */
  const stepFrame = (stack: Frame[], frame: Frame): readonly string[] | null => {
    const edges = adj[frame.id] ?? []
    if (frame.nextIdx >= edges.length) {
      // No more out-edges from this node — pop, paint black.
      colour[frame.id] = 2
      stack.pop()
      return null
    }
    const next = edges[frame.nextIdx]
    frame.nextIdx += 1
    if (next === undefined || !(next in adj)) return null // dangling skipped here (validateDag catches earlier)
    const c = colour[next] ?? 0
    if (c === 1) return cyclePathFrom(stack, next) // back-edge ⇒ cycle
    if (c === 0) {
      colour[next] = 1
      parent[next] = frame.id
      stack.push({ id: next, nextIdx: 0 })
    }
    // c === 2 (black): already fully explored, skip.
    return null
  }

  // Iterative DFS via explicit stack (avoid recursion blow for deep chains).
  const dfs = (root: string): readonly string[] | null => {
    if (!(root in adj)) return null // startId unknown ⇒ empty subgraph
    const rootColour = colour[root]
    if (rootColour !== undefined && rootColour !== 0) return null
    const stack: Frame[] = [{ id: root, nextIdx: 0 }]
    colour[root] = 1
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) break
      const found = stepFrame(stack, frame)
      if (found !== null) return found
    }
    return null
  }

  for (const root of roots) {
    if ((colour[root] ?? 0) !== 0) continue
    const found = dfs(root)
    if (found !== null) {
      cycleResult = found
      break
    }
  }
  return cycleResult
}

/**
 * Topological sort. Returns the id order on success, or `{ cycle }` on
 * failure (same path shape as {@link findCycle}). Tie-break: lexicographic
 * by id (deterministic regardless of input iteration).
 *
 * Algorithm: Kahn (BFS over in-degree=0 frontier). Stable tie-break by a
 * lexicographic min-heap frontier, so each enqueue/dequeue is O(log V)
 * without the `shift()`/linear-insert behaviour of a sorted array.
 */
/** Kahn's two working tables, built in ONE pass over the todos: `inDeg[id]` =
 *  how many not-yet-emitted prerequisites `id` still has, and `out[dep]` = the
 *  ids that become eligible when `dep` is emitted. A dangling dep contributes
 *  NO edge (`validateDag`'s job to report; the sort just skips it). */
interface DegreeTables {
  readonly inDeg: Record<string, number>
  readonly out: Record<string, string[]>
}

const buildDegreeTables = (
  todos: Readonly<Record<string, TodoItem>>,
  ids: readonly string[],
): DegreeTables => {
  const inDeg: Record<string, number> = {}
  const out: Record<string, string[]> = {}
  for (const id of ids) {
    inDeg[id] = 0
    out[id] = []
  }
  for (const id of ids) {
    const t = todos[id]
    if (t === undefined) continue
    for (const dep of t.dependencies) {
      if (!(dep in inDeg)) continue // dangling — validateDag's job; sort skips
      // Edge: id depends on dep, so dep MUST come first ⇒ edge dep → id.
      inDeg[id] = (inDeg[id] ?? 0) + 1
      out[dep]?.push(id)
    }
  }
  return { inDeg, out }
}

/** Drain the in-degree-0 frontier (Kahn's main loop), emitting ids in
 *  lexicographic tie-break order. MUTATES `inDeg` as prerequisites are retired.
 *  A short result (fewer than every id) means the remainder is cyclic. */
const drainFrontier = (ids: readonly string[], tables: DegreeTables): string[] => {
  const { inDeg, out } = tables
  const frontier = createOrderedFrontier(ids.filter((id) => (inDeg[id] ?? 0) === 0))
  const result: string[] = []
  while (frontier.size > 0) {
    const next = frontier.pop()
    if (next === undefined) break
    result.push(next)
    for (const child of out[next] ?? []) {
      const d = (inDeg[child] ?? 1) - 1
      inDeg[child] = d
      if (d === 0) frontier.push(child)
    }
  }
  return result
}

export const topologicalSort = (
  todos: Readonly<Record<string, TodoItem>>,
): readonly string[] | { readonly cycle: readonly string[] } => {
  const ids = Object.keys(todos)
  if (ids.length === 0) return []
  const result = drainFrontier(ids, buildDegreeTables(todos, ids))
  if (result.length !== ids.length) {
    // Remaining nodes form one or more cycles. Return the first one.
    const cycle = findCycleInternal(buildAdjacency(todos), undefined)
    return { cycle: cycle ?? [] }
  }
  return result
}
