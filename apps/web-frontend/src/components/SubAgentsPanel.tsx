/**
 * QUANTA_WEB_SUBAGENTS — SubAgentsPanel (Codex Sub-Agents panel equivalent).
 *
 * Renders the multi-agent orchestration UX carried out-of-band on the
 * `QUANTA_WEB_SUBAGENTS` channel (FAITHFUL PARALLEL of {@link AgentStatePanel}):
 *
 *   - **Active** section — nodes not yet in a terminal status, as the spawn
 *     TREE (children indented under their parent via `parentTaskId` / `depth`).
 *   - **Done** section — nodes in a terminal status (completed / failed /
 *     stopped), also as the tree.
 *   - Per-agent ROW — nickname/agentType, a status BADGE (working / waiting /
 *     done / failed), and a bounded task-description preview.
 *   - **Drill-in** — clicking a row selects it; the detail view shows the
 *     delegated task, the final-response preview, and the node's children, with
 *     a **back-to-parent** affordance (to the parent node, or the list).
 *
 * The model is produced by `useSubagentState` over the `subagent` frame stream
 * (a spawn ADDS a node; a status UPDATES it). Default-OFF: an empty model (gate
 * OFF / no frame) renders nothing — chat UI unchanged.
 */

import { memo, useState } from "react"
import {
  activeNodes,
  buildSubagentTree,
  doneNodes,
  type SubagentNode,
  type SubagentState,
  type SubagentStatusValue,
  type SubagentTreeNode,
} from "../ws/subagent-model"

const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/** Does the model carry any subagent node? SSOT for the panel's self-hide AND
 *  the App-level column-visibility gate (so the two never drift). */
export const subagentHasContent = (state: SubagentState): boolean => state.nodes.size > 0

/* ------------------------------------------------------------------ */
/* Status badge                                                        */
/* ------------------------------------------------------------------ */

/** Map a node status to the Codex-style badge label + tone. `null` (spawned but
 *  no status yet) reads as "working" — the node is live. */
const badgeFor = (status: SubagentStatusValue | null): { label: string; tone: string } => {
  switch (status) {
    case "running":
    case null:
      return { label: "working", tone: "bg-info/15 text-info" }
    case "completed":
      return { label: "done", tone: "bg-success/15 text-success" }
    case "failed":
      return { label: "failed", tone: "bg-danger/15 text-danger" }
    case "stopped":
      return { label: "stopped", tone: "bg-black/[0.05] text-ink-secondary" }
  }
}

const StatusBadge = ({ status }: { status: SubagentStatusValue | null }): JSX.Element => {
  const { label, tone } = badgeFor(status)
  return (
    <span
      data-testid="subagent-status-badge"
      data-status={label}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {label}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

const nickname = (node: SubagentNode): string =>
  node.agentType !== null && node.agentType.length > 0 ? node.agentType : node.taskId

/** A single per-agent row: nickname/agentType + status badge + bounded
 *  description preview. Clicking selects it (drill-in). */
const SubagentRow = ({
  node,
  onSelect,
}: {
  node: SubagentNode
  onSelect: (taskId: string) => void
}): JSX.Element => (
  <button
    type="button"
    data-testid="subagent-row"
    data-task-id={node.taskId}
    onClick={() => onSelect(node.taskId)}
    className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-surface-input"
  >
    <span className="shrink-0 font-mono text-xs text-ink-secondary">{nickname(node)}</span>
    <StatusBadge status={node.status} />
    <span className="min-w-0 flex-1 truncate text-xs text-ink-tertiary">{node.description}</span>
  </button>
)

/** Render a tree node + its children, indenting each level by `depth`. */
const TreeRow = memo(
  ({
    tree,
    onSelect,
  }: {
    tree: SubagentTreeNode
    onSelect: (taskId: string) => void
  }): JSX.Element => (
    <li data-testid="subagent-tree-node">
      <div style={{ paddingLeft: `${tree.node.depth * 12}px` }}>
        <SubagentRow node={tree.node} onSelect={onSelect} />
      </div>
      {tree.children.length > 0 ? (
        <ul className="space-y-0.5">
          {tree.children.map((c) => (
            <TreeRow key={c.node.taskId} tree={c} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  ),
)

/** A titled section rendering a filtered set of the tree (Active / Done). Empty
 *  ⇒ renders nothing. The `filter` keeps only the nodes belonging to the section
 *  but preserves the parent nesting for context. */
const TreeSection = ({
  title,
  testid,
  roots,
  onSelect,
}: {
  title: string
  testid: string
  roots: SubagentTreeNode[]
  onSelect: (taskId: string) => void
}): JSX.Element | null => {
  if (roots.length === 0) return null
  return (
    <section className={CARD} data-testid={testid}>
      <h3 className={LABEL}>{title}</h3>
      <ul className="mt-1.5 space-y-0.5">
        {roots.map((r) => (
          <TreeRow key={r.node.taskId} tree={r} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Tree pruning to a section                                           */
/* ------------------------------------------------------------------ */

/**
 * Prune the full spawn tree to only the nodes in `keep` (an Active or Done
 * taskId set), preserving nesting: a kept node stays under its nearest kept
 * ancestor; a dropped ancestor's kept descendants lift to fill the gap. This
 * keeps a section's tree readable when a parent belongs to the OTHER section.
 */
const pruneTree = (roots: SubagentTreeNode[], keep: ReadonlySet<string>): SubagentTreeNode[] => {
  const walk = (t: SubagentTreeNode): SubagentTreeNode[] => {
    const prunedChildren = t.children.flatMap(walk)
    if (keep.has(t.node.taskId)) return [{ node: t.node, children: prunedChildren }]
    // Dropped node — lift its kept descendants to this level.
    return prunedChildren
  }
  return roots.flatMap(walk)
}

/* ------------------------------------------------------------------ */
/* Drill-in detail                                                     */
/* ------------------------------------------------------------------ */

const SubagentDetail = ({
  node,
  childNodes,
  onSelect,
  onBack,
  backLabel,
}: {
  node: SubagentNode
  childNodes: SubagentNode[]
  onSelect: (taskId: string) => void
  onBack: () => void
  backLabel: string
}): JSX.Element => (
  <section className={CARD} data-testid="subagent-detail" data-task-id={node.taskId}>
    <header className="flex items-center justify-between">
      <button
        type="button"
        data-testid="subagent-back"
        onClick={onBack}
        className="text-[11px] text-ink-tertiary hover:text-ink-secondary"
      >
        ← {backLabel}
      </button>
      <StatusBadge status={node.status} />
    </header>
    <h3 className="mt-1.5 font-mono text-xs text-ink-secondary">{nickname(node)}</h3>
    <div className="mt-1.5">
      <span className={LABEL}>Delegated task</span>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink">{node.description}</p>
    </div>
    {node.finalTextPreview !== null ? (
      <div className="mt-2" data-testid="subagent-detail-final">
        <span className={LABEL}>Final response</span>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-secondary">
          {node.finalTextPreview}
        </p>
      </div>
    ) : null}
    {node.error !== null ? (
      <div className="mt-2" data-testid="subagent-detail-error">
        <span className={LABEL}>Error</span>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-danger">{node.error}</p>
      </div>
    ) : null}
    {childNodes.length > 0 ? (
      <div className="mt-2" data-testid="subagent-detail-children">
        <span className={LABEL}>Children</span>
        <ul className="mt-1 space-y-0.5">
          {childNodes.map((c) => (
            <SubagentRow key={c.taskId} node={c} onSelect={onSelect} />
          ))}
        </ul>
      </div>
    ) : null}
  </section>
)

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface SubAgentsPanelProps {
  readonly state: SubagentState
}

export const SubAgentsPanel = memo(({ state }: SubAgentsPanelProps): JSX.Element | null => {
  const [selected, setSelected] = useState<string | null>(null)
  // Default-OFF: an empty model renders nothing (chat UI unchanged).
  if (!subagentHasContent(state)) return null

  const roots = buildSubagentTree(state)
  const selectedNode = selected !== null ? (state.nodes.get(selected) ?? null) : null

  if (selectedNode !== null) {
    const kids = [...state.nodes.values()].filter((n) => n.parentTaskId === selectedNode.taskId)
    const parent = selectedNode.parentTaskId
    // back-to-parent when the node has a (present) parent, else back to the list.
    const backToParent = parent !== null && state.nodes.has(parent)
    return (
      <section
        aria-label="sub-agents"
        data-testid="subagents-panel"
        className="flex flex-col gap-2"
      >
        <header className="flex items-center justify-between">
          <span className={LABEL}>Sub-agents</span>
        </header>
        <SubagentDetail
          node={selectedNode}
          childNodes={kids}
          onSelect={setSelected}
          onBack={() => setSelected(backToParent ? parent : null)}
          backLabel={backToParent ? "parent" : "all"}
        />
      </section>
    )
  }

  const activeIds = new Set(activeNodes(state).map((n) => n.taskId))
  const doneIds = new Set(doneNodes(state).map((n) => n.taskId))
  return (
    <section aria-label="sub-agents" data-testid="subagents-panel" className="flex flex-col gap-2">
      <header className="flex items-center justify-between">
        <span className={LABEL}>Sub-agents</span>
      </header>
      <TreeSection
        title="Active"
        testid="subagents-active"
        roots={pruneTree(roots, activeIds)}
        onSelect={setSelected}
      />
      <TreeSection
        title="Done"
        testid="subagents-done"
        roots={pruneTree(roots, doneIds)}
        onSelect={setSelected}
      />
    </section>
  )
})
