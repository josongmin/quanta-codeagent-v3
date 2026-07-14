/**
 * `/agents --tree` spawn-tree builder — PURE, independently unit-testable.
 *
 * The multi-agent Sub-Agents panel reconstructs the real parent→child SPAWN
 * TREE from the lineage carried on each {@link AgentFleetRow} (`parentTaskId` /
 * `depth`), NOT the flat activity rows (whose `parentId` is null today). This
 * module owns the reconstruction so the renderer stays a thin projection.
 *
 * Robustness contract (SUBSTRATE-frozen, consumed read-only):
 *   - Root-level nodes (`parentTaskId === undefined`) sit at the top.
 *   - Children nest under their parent, ordered stably.
 *   - ORPHANS — a `parentTaskId` that points to a record NOT in the input
 *     (evicted from the registry's LRU) — are re-rooted at the top and marked
 *     `orphan: true`, never dropped.
 *   - CYCLES — a defensively-constructed A→B→A lineage — are broken: the
 *     traversal visits each node AT MOST ONCE, so it terminates (no throw, no
 *     infinite loop). A node already reachable elsewhere is not re-attached; a
 *     node reachable ONLY through a cycle is re-rooted as an orphan so it is
 *     never silently dropped.
 *
 * PURE: no clock, no I/O. Deterministic given the input row order.
 */

import type { AgentFleetRow } from "./agents-fleet-panel"

/** One node in the reconstructed spawn tree. Carries the source row plus the
 *  resolved tree metadata (render depth + children + orphan marker). */
export interface AgentTreeNode {
  readonly row: AgentFleetRow
  /** RENDER depth — 0 at the top level of the tree, +1 per nesting level.
   *  This is the INDENT level, derived from the reconstructed structure, NOT
   *  the row's own `depth` field (which is the registry spawn depth and may be
   *  inconsistent with the reachable structure, e.g. for an orphan). */
  readonly renderDepth: number
  /** Direct children, in stable (input) order. */
  readonly children: AgentTreeNode[]
  /** True when this node's `parentTaskId` referenced a record absent from the
   *  input (LRU-evicted) OR was only reachable via a cycle — re-rooted here so
   *  it is visible rather than dropped. */
  readonly orphan: boolean
}

/** The built tree: the top-level roots (real roots + re-rooted orphans), in a
 *  stable order (real roots first in input order, orphans after). */
export interface AgentTree {
  readonly roots: AgentTreeNode[]
}

interface MutableNode {
  readonly row: AgentFleetRow
  renderDepth: number
  readonly children: MutableNode[]
  orphan: boolean
}

/**
 * Reconstruct the spawn tree from a flat list of fleet rows.
 *
 * Algorithm (single pass + bounded DFS):
 *   1. Index every row by id (last write wins on a duplicate id — a registry
 *      never mints duplicates, but the builder stays total).
 *   2. Partition into real roots (`parentTaskId` undefined OR pointing at a
 *      missing id) and children (parent present in the index).
 *   3. DFS from each root, attaching children by parent id. A `visited` set
 *      guards against cycles AND diamond re-entry so every node is placed AT
 *      MOST ONCE and the walk always terminates.
 *   4. Any node never visited (reachable only through a cycle with no root
 *      entry) is re-rooted as an orphan — never dropped.
 */
/** Partition step: index by id, then split rows into real roots
 *  (`parentTaskId` undefined), orphan roots (parent missing or a self-loop) and
 *  a parent→children adjacency for everything else. Extracted to keep
 *  {@link rowsToTree} under the cognitive-complexity budget. */
interface Partitioned {
  readonly childrenOf: Map<string, AgentFleetRow[]>
  readonly rootRows: AgentFleetRow[]
  readonly orphanRootRows: AgentFleetRow[]
}

const partition = (rows: readonly AgentFleetRow[]): Partitioned => {
  const byId = new Map<string, AgentFleetRow>()
  for (const r of rows) byId.set(r.id, r)
  const childrenOf = new Map<string, AgentFleetRow[]>()
  const rootRows: AgentFleetRow[] = []
  const orphanRootRows: AgentFleetRow[] = []
  for (const r of rows) {
    const parentId = r.parentTaskId
    if (parentId === undefined) {
      rootRows.push(r)
    } else if (!byId.has(parentId) || parentId === r.id) {
      // Parent evicted (or a self-loop) — re-root as an orphan, never drop.
      orphanRootRows.push(r)
    } else {
      const bucket = childrenOf.get(parentId) ?? []
      bucket.push(r)
      childrenOf.set(parentId, bucket)
    }
  }
  return { childrenOf, rootRows, orphanRootRows }
}

export const rowsToTree = (rows: readonly AgentFleetRow[]): AgentTree => {
  const { childrenOf, rootRows, orphanRootRows } = partition(rows)
  const visited = new Set<string>()

  const build = (row: AgentFleetRow, renderDepth: number, orphan: boolean): MutableNode => {
    visited.add(row.id)
    const node: MutableNode = { row, renderDepth, children: [], orphan }
    const kids = childrenOf.get(row.id) ?? []
    for (const kid of kids) {
      // Cycle / diamond guard: never re-visit a node already placed.
      if (visited.has(kid.id)) continue
      node.children.push(build(kid, renderDepth + 1, false))
    }
    return node
  }

  const roots: MutableNode[] = []
  for (const r of rootRows) {
    if (visited.has(r.id)) continue
    roots.push(build(r, 0, false))
  }
  for (const r of orphanRootRows) {
    if (visited.has(r.id)) continue
    roots.push(build(r, 0, true))
  }
  // Any row reachable ONLY through a cycle (no root entry) was never visited —
  // re-root it as an orphan so it is rendered, not silently swallowed.
  for (const r of rows) {
    if (visited.has(r.id)) continue
    roots.push(build(r, 0, true))
  }

  return { roots }
}

/** Depth-first pre-order flatten of the tree into render order (parent before
 *  its children). Convenience for a renderer that emits one line per node. */
export const flattenTree = (tree: AgentTree): AgentTreeNode[] => {
  const out: AgentTreeNode[] = []
  const walk = (node: AgentTreeNode): void => {
    out.push(node)
    for (const c of node.children) walk(c)
  }
  for (const r of tree.roots) walk(r)
  return out
}

/** Return a NEW tree pruned to `renderDepth <= maxDepth`. Nodes deeper than the
 *  cap (and their subtrees) are dropped. `maxDepth < 0` yields an empty tree.
 *  Pure — never mutates the input tree. */
export const pruneTreeToDepth = (tree: AgentTree, maxDepth: number): AgentTree => {
  const prune = (node: AgentTreeNode): AgentTreeNode | undefined => {
    if (node.renderDepth > maxDepth) return undefined
    const children: AgentTreeNode[] = []
    for (const c of node.children) {
      const kept = prune(c)
      if (kept !== undefined) children.push(kept)
    }
    return { row: node.row, renderDepth: node.renderDepth, children, orphan: node.orphan }
  }
  const roots: AgentTreeNode[] = []
  for (const r of tree.roots) {
    const kept = prune(r)
    if (kept !== undefined) roots.push(kept)
  }
  return { roots }
}

/** Direct children of the task `id` in the reconstructed tree, as rows. Used by
 *  the `inspect <id>` drill-in to list a node's immediate spawns. Returns [] for
 *  an unknown id or a childless node. */
export const directChildrenOf = (rows: readonly AgentFleetRow[], id: string): AgentFleetRow[] => {
  const out: AgentFleetRow[] = []
  for (const r of rows) {
    if (r.parentTaskId === id && r.id !== id) out.push(r)
  }
  return out
}
