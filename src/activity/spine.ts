/**
 * Agent Activity Spine — pure reducer + materializer (jun-15 P0-a).
 *
 * `reduceActivity(state, event)` folds one {@link AgentActivityEvent} into the
 * accumulator; `materialize(state)` projects it into an immutable
 * {@link ActivitySnapshot} (tree + aggregates). Both PURE + NO-THROW.
 *
 * Honesty invariants (the spine exists to PREVENT dishonest status):
 *  - **Container status is DERIVED, never asserted.** A node WITH children
 *    (a `workflow` run, a `phase`) never shows a status that contradicts its
 *    descendants: a closed container with a failed child reads `failed`; an
 *    open container with a stuck/running child reads `stuck`/`running`. Leaf
 *    nodes keep their asserted status. This is computed bottom-up in
 *    `materialize`, so EVERY projection (fleet/tree/aggregate) sees the honest
 *    status — pinned by the drift ratchet.
 *  - NO-THROW: a status/metric for an unknown id is dropped; a producer bug
 *    never crashes the spine.
 *  - Deterministic: first-seen insertion order for roots + children (captured
 *    in dedicated arrays, never a Map-iteration accident).
 *  - Structural sharing: every change REPLACES the node object (never mutates
 *    in place), so a snapshot taken earlier stays frozen.
 */

import type {
  ActivityAggregate,
  ActivityNode,
  ActivitySnapshot,
  ActivityStatus,
  AgentActivityEvent,
  NodeInit,
} from "./types"

/** Mutable fold accumulator. Opaque to callers. */
export interface ActivityState {
  readonly nodes: Map<string, ActivityNode>
  /** First-seen child order, keyed by parent id. */
  readonly childOrder: Map<string, string[]>
  /** First-seen root order (parentId === null). A DEDICATED array — not a
   *  sentinel key in `childOrder` — so a producer id can never collide with the
   *  root bucket. */
  readonly rootOrder: string[]
}

export const emptyActivityState = (): ActivityState => ({
  nodes: new Map(),
  childOrder: new Map(),
  rootOrder: [],
})

/** Kinds counted as an "agent" for the header headcount (excludes the
 *  structural `phase` grouping and `tool` leaves). */
const AGENT_KINDS = new Set([
  "workflow",
  "agent",
  "subagent",
  "reactor",
  "daemon",
  "remote",
  "scheduled",
])

/** Statuses that CLOSE a node (stamp `endedAt`); also the "caller settled it"
 *  signal for the derived-status rule. */
const TERMINAL = new Set<ActivityStatus>(["done", "failed", "skipped", "stopped"])

const pushUnique = (arr: string[], id: string): void => {
  if (!arr.includes(id)) arr.push(id)
}

/** Record `id` under its parent (or the root bucket), exactly once. */
const link = (state: ActivityState, parentId: string | null, id: string): void => {
  if (parentId === null) {
    pushUnique(state.rootOrder, id)
    return
  }
  let kids = state.childOrder.get(parentId)
  if (kids === undefined) {
    kids = []
    state.childOrder.set(parentId, kids)
  }
  pushUnique(kids, id)
}

const openNode = (state: ActivityState, init: NodeInit): void => {
  const existing = state.nodes.get(init.id)
  if (existing !== undefined) {
    // Idempotent re-open. Identity (id/kind/PARENT) + lifecycle + counters are
    // IMMUTABLE after open — re-parenting a live node is rejected by design (a
    // producer that re-emits on reconnect must keep the same parent). Only the
    // presentational `label`/`meta` refresh. Pass `meta: {}` to clear.
    state.nodes.set(init.id, {
      ...existing,
      label: init.label,
      ...(init.meta !== undefined ? { meta: init.meta } : {}),
    })
    return
  }
  state.nodes.set(init.id, {
    id: init.id,
    parentId: init.parentId,
    kind: init.kind,
    label: init.label,
    status: init.status ?? "running",
    tokens: 0,
    toolCalls: 0,
    ...(init.at !== undefined ? { startedAt: init.at } : {}),
    ...(init.meta !== undefined ? { meta: init.meta } : {}),
  })
  link(state, init.parentId, init.id)
}

/** Apply a status transition to a node, returning the REPLACEMENT node (never
 *  mutated in place). `stuck`/`endedAt` are MANAGED here: stripped then
 *  conditionally re-added so, under exactOptionalPropertyTypes, a cleared field
 *  is OMITTED (not set to undefined). `startedAt` rides along in `rest`. */
const applyStatus = (
  node: ActivityNode,
  event: Extract<AgentActivityEvent, { type: "node_status" }>,
): ActivityNode => {
  const closing = TERMINAL.has(event.status)
  const { stuck: _drop, endedAt: _dropEnd, ...rest } = node
  // `stuck` lives only while stuck; any other status clears it (omitted).
  const base: ActivityNode =
    event.status === "stuck"
      ? { ...rest, status: event.status, stuck: event.stuck ?? { reason: "unknown" } }
      : { ...rest, status: event.status }
  // Stamp startedAt on the first non-terminal transition if open had none.
  const withStart: ActivityNode =
    event.at !== undefined && node.startedAt === undefined && !closing
      ? { ...base, startedAt: event.at }
      : base
  // Closing stamps endedAt; reviving (non-terminal after a close) leaves it
  // omitted so a running node never carries a stale end time.
  const closeAt = event.at ?? node.endedAt
  return closing && closeAt !== undefined ? { ...withStart, endedAt: closeAt } : withStart
}

/** Coerce a delta to an additive, monotonic, non-negative number (a non-finite
 *  / non-positive delta ⇒ 0 — no NaN/negative poisoning of the counters). */
const posDelta = (d: number | undefined): number =>
  Number.isFinite(d) && (d as number) > 0 ? (d as number) : 0

export const reduceActivity = (state: ActivityState, event: AgentActivityEvent): ActivityState => {
  switch (event.type) {
    case "node_open":
      openNode(state, event.node)
      return state
    case "node_status": {
      const node = state.nodes.get(event.id)
      if (node !== undefined) state.nodes.set(event.id, applyStatus(node, event)) // else NO-THROW drop
      return state
    }
    case "node_metric": {
      const node = state.nodes.get(event.id)
      if (node === undefined) return state // NO-THROW: drop unknown id
      const dt = posDelta(event.tokensDelta)
      const dc = posDelta(event.toolCallsDelta)
      if (dt === 0 && dc === 0) return state
      state.nodes.set(event.id, {
        ...node,
        tokens: node.tokens + dt,
        toolCalls: node.toolCalls + dc,
      })
      return state
    }
    default: {
      const _never: never = event
      return state
    }
  }
}

/** Fold a whole event sequence (convenience for producers/tests). */
export const reduceAll = (events: Iterable<AgentActivityEvent>): ActivityState => {
  const state = emptyActivityState()
  for (const e of events) reduceActivity(state, e)
  return state
}

/** Effective status of a container from its (already-effective) child statuses.
 *  CLOSED container (caller settled it): failed if any child failed, else the
 *  asserted terminal status. OPEN container: running/stuck reflecting live
 *  children; otherwise stays as asserted (more work may yet be enumerated — we
 *  do NOT prematurely mark it done). */
const deriveContainerStatus = (
  asserted: ActivityStatus,
  childStatuses: readonly ActivityStatus[],
): ActivityStatus => {
  const has = (s: ActivityStatus): boolean => childStatuses.includes(s)
  if (TERMINAL.has(asserted)) {
    return has("failed") ? "failed" : asserted
  }
  if (has("running") || has("pending")) return "running"
  if (has("stuck")) return "stuck"
  return asserted
}

/** Bottom-up effective-status pass. Memoized + cycle-safe (a node in its own
 *  ancestry resolves to its asserted status rather than looping). */
const computeEffectiveStatuses = (
  nodes: ReadonlyMap<string, ActivityNode>,
  childIds: ReadonlyMap<string, readonly string[]>,
): Map<string, ActivityStatus> => {
  const memo = new Map<string, ActivityStatus>()
  const visit = (id: string, ancestry: ReadonlySet<string>): ActivityStatus => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const node = nodes.get(id)
    if (node === undefined) return "pending"
    const kids = childIds.get(id) ?? []
    if (kids.length === 0 || ancestry.has(id)) {
      memo.set(id, node.status)
      return node.status
    }
    const nextAncestry = new Set(ancestry).add(id)
    const childStatuses = kids
      .filter((k) => !nextAncestry.has(k))
      .map((k) => visit(k, nextAncestry))
    const eff = deriveContainerStatus(node.status, childStatuses)
    memo.set(id, eff)
    return eff
  }
  for (const id of nodes.keys()) visit(id, new Set())
  return memo
}

const computeAggregate = (
  nodes: ReadonlyMap<string, ActivityNode>,
  childIds: ReadonlyMap<string, readonly string[]>,
): ActivityAggregate => {
  let agents = 0
  let running = 0
  let stuck = 0
  let tokens = 0
  let toolCalls = 0
  for (const n of nodes.values()) {
    if (AGENT_KINDS.has(n.kind)) {
      agents += 1
      // running/stuck count actual WORKERS — agent-kind LEAVES — not container
      // runs (a workflow run shows `stuck` because a child is stuck; counting
      // both would double-count one blocked situation).
      const isLeaf = (childIds.get(n.id)?.length ?? 0) === 0
      if (isLeaf && n.status === "running") running += 1
      if (isLeaf && n.status === "stuck") stuck += 1
    }
    tokens += n.tokens
    toolCalls += n.toolCalls
  }
  return { agents, running, stuck, tokens, toolCalls }
}

/** Project the accumulator into an immutable snapshot. Container statuses are
 *  replaced by their derived (honest) value; counters/order are copies so a
 *  later fold cannot mutate this snapshot. */
export const materialize = (state: ActivityState): ActivitySnapshot => {
  const childIds = new Map<string, readonly string[]>()
  for (const [parent, kids] of state.childOrder) childIds.set(parent, [...kids])

  const effective = computeEffectiveStatuses(state.nodes, childIds)
  const byId = new Map<string, ActivityNode>()
  for (const [id, node] of state.nodes) {
    const eff = effective.get(id)
    byId.set(id, eff !== undefined && eff !== node.status ? { ...node, status: eff } : node)
  }
  return {
    roots: [...state.rootOrder],
    byId,
    childIds,
    aggregate: computeAggregate(byId, childIds),
  }
}
