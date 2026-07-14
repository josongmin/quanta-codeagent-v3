/**
 * QUANTA_WEB_SUBAGENTS — the Sub-Agents panel model (pure reducer + tree).
 *
 * FAITHFUL PARALLEL of `agent-state-hooks.ts`: folds the out-of-band `subagent`
 * WS frames (`subagent_spawn` / `subagent_status`) into one live model the
 * {@link SubAgentsPanel} renders as the Codex Sub-Agents UX — an Active section
 * + a Done section, per-agent rows, the spawn TREE (children nested under their
 * parent via `parentTaskId` / `depth`), and drill-in to a node's detail.
 *
 * Fold semantics (a spawn ADDS a node; a status UPDATES it):
 *   - `subagent_spawn`  → upsert the node's lineage + description + agentType.
 *   - `subagent_status` → set the node's status / turns / finalTextPreview /
 *                         error. A status BEFORE its spawn is retained (partial
 *                         node) and completed when the spawn lands (out-of-order
 *                         delivery is possible on the wire).
 *
 * The COPIED frontend mirror type (`SubagentMessage`, copy-not-import) matches
 * `@/protocol/subagent-frame#SubagentMessage` — the web bundle lives outside the
 * bun tsconfig `paths`, same convention as `types/protocol.ts`.
 *
 * Default-OFF: with the daemon gate `QUANTA_WEB_SUBAGENTS` unset no `subagent`
 * frame ever decodes, the model stays {@link EMPTY_SUBAGENT_STATE}, and the
 * panel self-hides — chat UI byte-identical.
 */

import { useEffect, useReducer } from "react"

/* ------------------------------------------------------------------ */
/* Wire mirror (copy-not-import of @/protocol/subagent-frame)          */
/* ------------------------------------------------------------------ */

export type SubagentStatusValue = "running" | "completed" | "failed" | "stopped"

export interface SubagentSpawnMessage {
  readonly type: "subagent_spawn"
  readonly taskId: string
  readonly parentTaskId?: string
  readonly depth: number
  readonly description: string
  readonly agentType?: string
  readonly at: number
  readonly emittedAt: number
}

export interface SubagentStatusMessage {
  readonly type: "subagent_status"
  readonly taskId: string
  readonly status: SubagentStatusValue
  readonly at: number
  readonly turns?: number
  readonly finalTextPreview?: string
  readonly error?: string
  readonly emittedAt: number
}

export type SubagentMessage = SubagentSpawnMessage | SubagentStatusMessage

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/** One node in the spawn tree — the merged view of a subagent's spawn + latest
 *  status. `status === null` until a `subagent_status` frame arrives. */
export interface SubagentNode {
  readonly taskId: string
  readonly parentTaskId: string | null
  readonly depth: number
  readonly description: string
  readonly agentType: string | null
  readonly status: SubagentStatusValue | null
  readonly turns: number | null
  readonly finalTextPreview: string | null
  readonly error: string | null
  /** Insertion order (first frame seen for this taskId) — stable row ordering. */
  readonly seq: number
}

export interface SubagentState {
  /** Every node keyed by taskId (spawn-order preserved by Map iteration). */
  readonly nodes: ReadonlyMap<string, SubagentNode>
  /** Monotonic insertion counter (assigns each node's `seq`). */
  readonly nextSeq: number
}

export const EMPTY_SUBAGENT_STATE: SubagentState = {
  nodes: new Map(),
  nextSeq: 0,
}

/** Terminal statuses partition a node into the DONE section. */
const TERMINAL: ReadonlySet<SubagentStatusValue> = new Set(["completed", "failed", "stopped"])

export const isTerminal = (status: SubagentStatusValue | null): boolean =>
  status !== null && TERMINAL.has(status)

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

type SubagentAction = { type: "message"; msg: SubagentMessage } | { type: "reset" }

const EMPTY_NODE = (taskId: string, seq: number): SubagentNode => ({
  taskId,
  parentTaskId: null,
  depth: 0,
  description: "",
  agentType: null,
  status: null,
  turns: null,
  finalTextPreview: null,
  error: null,
  seq,
})

/** Cap the node Map so a long daemon session can't grow it without bound. The
 *  backend `TaskRegistry` LRU-evicts SETTLED records at 256 but SILENTLY (no
 *  removal frame), so the frontend must self-bound or it leaks memory + drifts
 *  to O(n²) selector cost over the session lifetime (hellaudit R2 MEDIUM). Only
 *  TERMINAL nodes are dropped (oldest `seq` first); a still-running node is
 *  NEVER evicted (it belongs in the Active list). Mutates the passed fresh Map. */
const MAX_NODES = 256
const capNodes = (nodes: Map<string, SubagentNode>): void => {
  if (nodes.size <= MAX_NODES) return
  const terminal = [...nodes.values()]
    .filter((n) => isTerminal(n.status))
    .sort((a, b) => a.seq - b.seq)
  let over = nodes.size - MAX_NODES
  for (const n of terminal) {
    if (over <= 0) break
    nodes.delete(n.taskId)
    over -= 1
  }
}

const applySpawn = (state: SubagentState, msg: SubagentSpawnMessage): SubagentState => {
  const prior = state.nodes.get(msg.taskId)
  const seq = prior?.seq ?? state.nextSeq
  const base = prior ?? EMPTY_NODE(msg.taskId, seq)
  const node: SubagentNode = {
    ...base,
    parentTaskId: msg.parentTaskId ?? null,
    depth: msg.depth,
    description: msg.description,
    agentType: msg.agentType ?? null,
  }
  const nodes = new Map(state.nodes)
  nodes.set(msg.taskId, node)
  capNodes(nodes)
  return { nodes, nextSeq: prior === undefined ? state.nextSeq + 1 : state.nextSeq }
}

const applyStatus = (state: SubagentState, msg: SubagentStatusMessage): SubagentState => {
  const prior = state.nodes.get(msg.taskId)
  const seq = prior?.seq ?? state.nextSeq
  const base = prior ?? EMPTY_NODE(msg.taskId, seq)
  const node: SubagentNode = {
    ...base,
    status: msg.status,
    turns: msg.turns ?? base.turns,
    finalTextPreview: msg.finalTextPreview ?? base.finalTextPreview,
    error: msg.error ?? base.error,
  }
  const nodes = new Map(state.nodes)
  nodes.set(msg.taskId, node)
  capNodes(nodes)
  return { nodes, nextSeq: prior === undefined ? state.nextSeq + 1 : state.nextSeq }
}

/**
 * Fold one subagent frame onto the model. Pure (exported so the state semantics
 * are unit-tested in the node env, no DOM). A spawn ADDS a node; a status
 * UPDATES it (retaining a node created status-first for out-of-order delivery).
 */
export const subagentReducer = (state: SubagentState, action: SubagentAction): SubagentState => {
  if (action.type === "reset") return EMPTY_SUBAGENT_STATE
  const { msg } = action
  if (msg.type === "subagent_spawn") return applySpawn(state, msg)
  if (msg.type === "subagent_status") return applyStatus(state, msg)
  return state
}

/* ------------------------------------------------------------------ */
/* Selectors — Active / Done partition + the spawn TREE                */
/* ------------------------------------------------------------------ */

const bySeq = (a: SubagentNode, b: SubagentNode): number => a.seq - b.seq

/** All nodes in insertion order. */
export const allNodes = (state: SubagentState): SubagentNode[] =>
  [...state.nodes.values()].sort(bySeq)

/** Nodes NOT yet in a terminal status (the Active section). */
export const activeNodes = (state: SubagentState): SubagentNode[] =>
  allNodes(state).filter((n) => !isTerminal(n.status))

/** Nodes in a terminal status (the Done section). */
export const doneNodes = (state: SubagentState): SubagentNode[] =>
  allNodes(state).filter((n) => isTerminal(n.status))

/** Direct children of a node (drill-in / tree nesting) in insertion order. */
export const nodeChildren = (state: SubagentState, taskId: string): SubagentNode[] =>
  allNodes(state).filter((n) => n.parentTaskId === taskId)

/** A tree node = a model node + its recursively-built children. */
export interface SubagentTreeNode {
  readonly node: SubagentNode
  readonly children: SubagentTreeNode[]
}

/**
 * Build the spawn TREE from the flat model: nodes whose `parentTaskId` is null
 * (or points at an unknown/absent parent — a dropped-parent orphan still shows)
 * are roots; every other node nests under its parent. Insertion-ordered at each
 * level. Per-walk `seen` set stops infinite recursion; any node NOT reachable
 * from a real root (a pure cycle A↔B where each is the other's "parent") is
 * re-rooted in a final sweep so it still shows instead of silently vanishing —
 * mirrors the CLI `rowsToTree` builder (hellaudit MEDIUM, 2026-07-15).
 */
export const buildSubagentTree = (state: SubagentState): SubagentTreeNode[] => {
  const nodes = allNodes(state)
  const present = new Set(nodes.map((n) => n.taskId))
  const emitted = new Set<string>()
  const build = (node: SubagentNode, seen: ReadonlySet<string>): SubagentTreeNode => {
    const nextSeen = new Set(seen).add(node.taskId)
    emitted.add(node.taskId)
    return {
      node,
      children: nodes
        .filter((n) => n.parentTaskId === node.taskId && !nextSeen.has(n.taskId))
        .map((child) => build(child, nextSeen)),
    }
  }
  const isRoot = (n: SubagentNode): boolean =>
    n.parentTaskId === null || !present.has(n.parentTaskId)
  const roots = nodes.filter(isRoot).map((n) => build(n, new Set<string>()))
  // Re-root any node a real root never reached (cycle-only nodes) so it is never
  // silently dropped. `build`'s `seen` guard breaks the cycle on the way down.
  for (const n of nodes) {
    if (!emitted.has(n.taskId)) roots.push(build(n, new Set<string>()))
  }
  return roots
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

/** Minimal event source the hook subscribes to. The production caller wraps the
 *  client's `onSubagent` channel; tests pass a stub. Mirrors `AgentStateSource`. */
export interface SubagentSource {
  subscribe(handler: (msg: SubagentMessage) => void): () => void
}

/**
 * Subscribe to the subagent channel and fold every frame into one live
 * {@link SubagentState}. With `source === null` (gate OFF / no client) the hook
 * never subscribes and returns {@link EMPTY_SUBAGENT_STATE} — the panel renders
 * nothing (default-OFF, chat UI unchanged).
 */
export const useSubagentState = (source: SubagentSource | null): SubagentState => {
  const [state, dispatch] = useReducer(subagentReducer, EMPTY_SUBAGENT_STATE)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => dispatch({ type: "message", msg }))
  }, [source])
  return state
}
