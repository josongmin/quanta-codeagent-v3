/**
 * Activity projections (jun-15 P0-a) — DERIVED views of one snapshot.
 *
 * Every surface reads one of these; they all read the SAME
 * {@link ActivitySnapshot}, so the fleet view (L0) and the run tree (L1/L2)
 * can never disagree on membership or status. That single-source property is
 * what the drift ratchet pins: `projectFleet(snapshot)` derived from the spine
 * MUST equal the fleet rows the producers were built from.
 */

import type { ActivityNode, ActivitySnapshot, ActivityStatus } from "./types"

/** One L0 fleet row — a top-level agent run, plus its rolled-up descendant
 *  counters (so the fleet line shows the run's TOTAL tokens, not just the root
 *  node's). `childRunning`/`childStuck` drive the "9/17 · 1 stuck" summary. */
export interface FleetRow {
  readonly id: string
  readonly kind: ActivityNode["kind"]
  readonly label: string
  readonly status: ActivityStatus
  readonly tokens: number
  readonly toolCalls: number
  readonly descendants: number
  readonly running: number
  readonly stuck: number
  readonly startedAt?: number
  readonly endedAt?: number
}

/** Walk a node + all descendants, accumulating counters/status counts. Pure;
 *  cycle-safe via a visited set (a malformed tree with a parent cycle can't
 *  infinite-loop the projection). */
const rollup = (
  snapshot: ActivitySnapshot,
  rootId: string,
): { tokens: number; toolCalls: number; descendants: number; running: number; stuck: number } => {
  let tokens = 0
  let toolCalls = 0
  let descendants = 0
  let running = 0
  let stuck = 0
  const seen = new Set<string>()
  const stack: string[] = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const node = snapshot.byId.get(id)
    if (node === undefined) continue
    if (id !== rootId) {
      descendants += 1
      if (node.status === "running") running += 1
      if (node.status === "stuck") stuck += 1
    }
    tokens += node.tokens
    toolCalls += node.toolCalls
    for (const child of snapshot.childIds.get(id) ?? []) stack.push(child)
  }
  return { tokens, toolCalls, descendants, running, stuck }
}

/** L0 fleet projection — one row per root, descendants rolled up. Order is the
 *  snapshot's first-seen root order (deterministic). */
export const projectFleet = (snapshot: ActivitySnapshot): readonly FleetRow[] => {
  const rows: FleetRow[] = []
  for (const id of snapshot.roots) {
    const node = snapshot.byId.get(id)
    if (node === undefined) continue
    const r = rollup(snapshot, id)
    rows.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: node.status,
      tokens: r.tokens,
      toolCalls: r.toolCalls,
      descendants: r.descendants,
      running: r.running,
      stuck: r.stuck,
      ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
      ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
    })
  }
  return rows
}

/** A nested tree node for the L1/L2 zoom views (CLI `/activity`, Web waterfall). */
export interface ActivityTreeNode {
  readonly node: ActivityNode
  readonly children: readonly ActivityTreeNode[]
}

/** Build the nested tree for one root (or the whole forest if `rootId` omitted).
 *  Cycle-safe. Child order is the snapshot's first-seen order. */
export const projectTree = (
  snapshot: ActivitySnapshot,
  rootId?: string,
): readonly ActivityTreeNode[] => {
  const build = (id: string, seen: Set<string>): ActivityTreeNode | null => {
    if (seen.has(id)) return null
    const node = snapshot.byId.get(id)
    if (node === undefined) return null
    const nextSeen = new Set(seen).add(id)
    const children: ActivityTreeNode[] = []
    for (const childId of snapshot.childIds.get(id) ?? []) {
      const child = build(childId, nextSeen)
      if (child !== null) children.push(child)
    }
    return { node, children }
  }
  const ids = rootId !== undefined ? [rootId] : snapshot.roots
  const out: ActivityTreeNode[] = []
  for (const id of ids) {
    const t = build(id, new Set())
    if (t !== null) out.push(t)
  }
  return out
}
