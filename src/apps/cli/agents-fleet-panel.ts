/**
 * `/agents` live fleet view — PURE renderer (ticket 17).
 *
 * Renders a snapshot of the in-process subagent {@link TaskRegistry} as a
 * table / json / tree. PURE: no clock, no I/O, no TTY detection. The caller
 * injects `now` (so age columns are deterministic and testable) and colour is
 * decided entirely by the `@/ui/ui-helpers` layer (which strips ANSI when the
 * resolved policy is "off") — this module never reads `process.stdout.isTTY`.
 *
 * The row type is a LOCAL structural mirror of `TaskRecord` + the subset of
 * `SubagentResult` we surface. It deliberately does NOT import `@/subagent`
 * VALUES: `registry-surface.ts` lives behind a slice fence that forbids
 * `@/agent`/`@/llm`/`@/runner`/`@/host` value imports, and we keep the same
 * discipline here so the renderer is portable and the wire stays type-only.
 */

import { sliceWholeChars } from "@/shared"
import { bold, cyan, dim, green, red, renderBox, visibleWidth, yellow } from "@/ui/ui-helpers"
import {
  type AgentTreeNode,
  directChildrenOf,
  flattenTree,
  pruneTreeToDepth,
  rowsToTree,
} from "./agents-fleet-tree"

/** Structural mirror of `@/subagent`'s `TaskRecord` + the surfaced slice of
 *  `SubagentResult`. Kept local on purpose (no `@/subagent` value import). */
export interface AgentFleetRow {
  readonly id: string
  readonly description: string
  readonly agentType?: string
  readonly status: "running" | "completed" | "failed" | "stopped"
  readonly startedAt: number
  readonly endedAt?: number
  readonly result?: { readonly ok: boolean; readonly finalText: string; readonly turns: number }
  readonly error?: string
  /** SUBSTRATE lineage (multi-agent panel). Registry task id of the agent that
   *  spawned THIS task; `undefined` ⇒ root-level (spawned by the root session
   *  agent). Consumed READ-ONLY by the `--tree` spawn-tree reconstruction. */
  readonly parentTaskId?: string
  /** SUBSTRATE — the child's spawn depth (root's direct child = 1). Surfaced in
   *  the tree/inspect views. */
  readonly depth?: number
  /** SUBSTRATE — the deterministic mailbox label (`parentLabel/ordinal`), when
   *  the runner minted one. Surfaced as a node's stable address in `inspect`. */
  readonly mailboxLabel?: string
}

export interface RenderAgentFleetOpts {
  readonly format: "table" | "json" | "tree"
  /** Injected wall-clock ms — drives the age column deterministically. */
  readonly now: number
  /** When true, do NOT collapse settled rows. HONEST note: `--all` only
   *  changes presentation; it cannot resurrect LRU-evicted records (those are
   *  already gone from the registry Map before they ever reach this renderer). */
  readonly all?: boolean
  /** `--depth N` — when `format === "tree"`, prune the spawn tree to render
   *  depth ≤ this value (0 = roots only). Absent ⇒ no depth cap. Ignored by the
   *  table/json paths (byte-identical). */
  readonly maxDepth?: number
}

const FINAL_TEXT_MAX = 50
/** Without `--all`, cap the number of settled rows shown so a long session's
 *  fleet view stays scannable. Running rows are NEVER collapsed. */
const DEFAULT_SETTLED_SHOWN = 8

/** Humanize an elapsed-ms span into a compact `12s` / `3m` / `1h`. Clamps
 *  negative / NaN to `0s` — never throws, never emits a negative age. */
export const formatAge = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h`
}

/** Age of a row against the injected `now`: settled rows freeze at `endedAt`,
 *  running rows tick from `startedAt`. */
const rowAge = (r: AgentFleetRow, now: number): string => {
  const end = r.status === "running" ? now : (r.endedAt ?? now)
  return formatAge(end - r.startedAt)
}

const GLYPH: Record<AgentFleetRow["status"], string> = {
  running: "●",
  completed: "✓",
  failed: "✗",
  stopped: "⊘",
}

/** Status → colour. Delegated to `@/ui` so the renderer never TTY-detects;
 *  when the resolved policy is "off" these are byte-identity no-ops. */
const colourFor = (status: AgentFleetRow["status"]): ((s: string) => string) => {
  switch (status) {
    case "running":
      return cyan
    case "completed":
      return green
    case "failed":
      return red
    case "stopped":
      return yellow
  }
}

const statusCell = (status: AgentFleetRow["status"]): string =>
  colourFor(status)(`${GLYPH[status]} ${status}`)

/** First line of the agent's final text, truncated to {@link FINAL_TEXT_MAX}
 *  visible chars with an ellipsis, plus a `(Nt)` turns badge. */
const resultCell = (r: AgentFleetRow): string => {
  const raw = r.result?.finalText ?? r.error ?? ""
  const firstLine = raw.split("\n")[0] ?? ""
  const truncated =
    firstLine.length > FINAL_TEXT_MAX ? `${sliceWholeChars(firstLine, FINAL_TEXT_MAX)}…` : firstLine
  const badge = r.result !== undefined ? ` ${dim(`(${r.result.turns}t)`)}` : ""
  return truncated.length === 0 ? badge.trimStart() : `${truncated}${badge}`
}

/** Short id for the table — keep the `task_` prefix dropped, show a stable
 *  head so log lines remain greppable while staying narrow. Exported so sibling
 *  surfaces (e.g. `/attention` list) render the SAME short-id vocabulary as the
 *  `/agents` inspect drill instead of dumping raw opaque ids. */
export const shortId = (id: string): string =>
  id.startsWith("task_") ? id.slice(5, 5 + 12) : id.slice(0, 12)

/** Stable ordering: running first, then settled by `endedAt` descending
 *  (most-recently-finished nearest the top of the settled block). Pure
 *  comparator over a copied array — never mutates the caller's input. */
const ordered = (rows: readonly AgentFleetRow[]): AgentFleetRow[] => {
  const running = rows.filter((r) => r.status === "running")
  const settled = rows
    .filter((r) => r.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...settled]
}

interface FleetCounts {
  readonly running: number
  readonly done: number
  readonly failed: number
}

const countFleet = (rows: readonly AgentFleetRow[]): FleetCounts => {
  let running = 0
  let done = 0
  let failed = 0
  for (const r of rows) {
    if (r.status === "running") running++
    else if (r.status === "completed" || r.status === "stopped") done++
    else failed++
  }
  return { running, done, failed }
}

const footerLine = (c: FleetCounts): string =>
  `${c.running} running · ${c.done} done · ${c.failed} failed`

const padEndVis = (s: string, w: number): string => {
  const gap = w - visibleWidth(s)
  return gap > 0 ? s + " ".repeat(gap) : s
}

const padStartVis = (s: string, w: number): string => {
  const gap = w - visibleWidth(s)
  return gap > 0 ? " ".repeat(gap) + s : s
}

const EMPTY_PANEL = (): string =>
  renderBox(["(no agents)", dim("spawn one via the Agent tool, then re-run /agents")], {
    title: "Agent fleet",
    titleStyle: bold,
  })

/** Render the aligned table body (header + rows) as box content lines. */
const tableLines = (rows: readonly AgentFleetRow[], now: number): string[] => {
  const idW = Math.max(2, ...rows.map((r) => visibleWidth(shortId(r.id))))
  const statusW = Math.max(6, ...rows.map((r) => visibleWidth(statusCell(r.status))))
  const typeW = Math.max(4, ...rows.map((r) => visibleWidth(r.agentType ?? "-")))
  const ageW = Math.max(3, ...rows.map((r) => visibleWidth(rowAge(r, now))))
  const header = [
    padEndVis(dim("ID"), idW),
    padEndVis(dim("STATUS"), statusW),
    padEndVis(dim("TYPE"), typeW),
    padStartVis(dim("AGE"), ageW),
    dim("RESULT"),
  ].join("  ")
  const body = rows.map((r) =>
    [
      padEndVis(shortId(r.id), idW),
      padEndVis(statusCell(r.status), statusW),
      padEndVis(r.agentType ?? "-", typeW),
      padStartVis(rowAge(r, now), ageW),
      resultCell(r),
    ].join("  "),
  )
  return [header, ...body]
}

const renderTable = (rows: readonly AgentFleetRow[], opts: RenderAgentFleetOpts): string => {
  const sorted = ordered(rows)
  const shown = opts.all === true ? sorted : collapseSettled(sorted)
  const counts = countFleet(rows)
  const collapsedNote =
    opts.all !== true && shown.length < sorted.length
      ? [dim(`… ${sorted.length - shown.length} more settled (use --all)`)]
      : []
  return renderBox([...tableLines(shown, opts.now), ...collapsedNote], {
    title: "Agent fleet",
    titleStyle: bold,
    footer: footerLine(counts),
  })
}

/** Keep ALL running rows; cap the settled block at {@link DEFAULT_SETTLED_SHOWN}. */
const collapseSettled = (sorted: readonly AgentFleetRow[]): AgentFleetRow[] => {
  const out: AgentFleetRow[] = []
  let settledSeen = 0
  for (const r of sorted) {
    if (r.status === "running") {
      out.push(r)
      continue
    }
    if (settledSeen < DEFAULT_SETTLED_SHOWN) {
      out.push(r)
      settledSeen++
    }
  }
  return out
}

const renderJson = (rows: readonly AgentFleetRow[], now: number): string =>
  JSON.stringify(
    ordered(rows).map((r) => ({
      id: r.id,
      description: r.description,
      agentType: r.agentType ?? null,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      age: rowAge(r, now),
      turns: r.result?.turns ?? null,
      finalText: r.result?.finalText ?? null,
      error: r.error ?? null,
    })),
    null,
    2,
  )

/** Bound a description to a 1-line preview capped at {@link TREE_DESC_MAX}
 *  visible chars (first line only, ellipsised). Defends the tree/inspect rows
 *  against a giant multi-line delegated-task string. */
const descPreview = (description: string): string => {
  const firstLine = description.split("\n")[0] ?? ""
  return firstLine.length > TREE_DESC_MAX
    ? `${sliceWholeChars(firstLine, TREE_DESC_MAX)}…`
    : firstLine
}

const TREE_DESC_MAX = 44

/** Node label for a tree/inspect row: nickname (`mailboxLabel`) or agentType,
 *  falling back to the short id when neither is present. */
const nodeLabel = (r: AgentFleetRow): string => r.mailboxLabel ?? r.agentType ?? shortId(r.id)

/** One indented spawn-tree row: `<indent><status> <label> d<depth> — <preview>`.
 *  The indent is 2 spaces per render level; an orphan is flagged so a re-rooted
 *  (LRU-evicted parent) node is visibly distinct. */
const treeRow = (node: AgentTreeNode): string => {
  const r = node.row
  const indent = "  ".repeat(node.renderDepth)
  const orphanMark = node.orphan ? dim(" ⚠ orphan") : ""
  const depthBadge = dim(`d${r.depth ?? node.renderDepth}`)
  const preview = descPreview(r.description)
  const previewCell = preview.length > 0 ? ` ${dim("—")} ${preview}` : ""
  return `${indent}${statusCell(r.status)} ${bold(nodeLabel(r))} ${depthBadge}${orphanMark}${previewCell}`
}

/** `--tree` — render the reconstructed parent→child SPAWN tree (via
 *  `parentTaskId`/`depth`), NOT a type-grouping. Root-level tasks at the top,
 *  children indented under their parent; orphans (evicted parent) re-rooted with
 *  a marker; cycles broken (each node emitted at most once). `--depth N` prunes
 *  to render depth ≤ N. */
const renderTree = (rows: readonly AgentFleetRow[], opts: RenderAgentFleetOpts): string => {
  const built = rowsToTree(rows)
  const tree = opts.maxDepth !== undefined ? pruneTreeToDepth(built, opts.maxDepth) : built
  const nodes = flattenTree(tree)
  const lines = nodes.length === 0 ? [dim("(no agents at this depth)")] : nodes.map(treeRow)
  return renderBox(lines, {
    title: "Sub-agents",
    titleStyle: bold,
    footer: footerLine(countFleet(rows)),
  })
}

/**
 * Drill-in `/agents inspect <id>` — one task's detail: delegated description,
 * status, depth, parent (id + nickname when resolvable), mailbox label, a
 * bounded final-response preview (from `result`/`error`), and its DIRECT
 * children. PURE. Returns a "not found" box when the id is unknown/evicted.
 */
export const renderAgentInspect = (
  rows: readonly AgentFleetRow[],
  id: string,
  opts: { readonly now: number },
): string => {
  const self = rows.find((r) => r.id === id)
  if (self === undefined) {
    return renderBox(
      [`${red("✗")} task not found: ${id}`, dim("(unknown id, or evicted from the registry LRU)")],
      { title: "Sub-agent detail", titleStyle: bold },
    )
  }
  const parent =
    self.parentTaskId !== undefined ? rows.find((r) => r.id === self.parentTaskId) : undefined
  const parentCell =
    self.parentTaskId === undefined
      ? dim("root (spawned by session agent)")
      : parent !== undefined
        ? `${shortId(parent.id)} ${dim(`(${nodeLabel(parent)})`)}`
        : `${shortId(self.parentTaskId)} ${dim("(evicted)")}`
  const finalRaw = self.result?.finalText ?? self.error ?? ""
  const finalPreview = finalRaw.length > 0 ? descPreview(finalRaw) : dim("(none yet)")
  const kids = directChildrenOf(rows, id)
  const kidLines =
    kids.length === 0
      ? [dim("  (no direct children)")]
      : kids.map((k) => `  ${statusCell(k.status)} ${bold(nodeLabel(k))} ${dim(shortId(k.id))}`)
  const lines = [
    `${statusCell(self.status)}  ${bold(nodeLabel(self))}  ${dim(shortId(self.id))}`,
    `${dim("age")}      ${rowAge(self, opts.now)}`,
    `${dim("depth")}    ${self.depth ?? 0}`,
    `${dim("parent")}   ${parentCell}`,
    ...(self.mailboxLabel !== undefined ? [`${dim("mailbox")}  ${self.mailboxLabel}`] : []),
    `${dim("task")}     ${descPreview(self.description)}`,
    `${dim("result")}   ${finalPreview}`,
    dim(`children (${kids.length}):`),
    ...kidLines,
  ]
  return renderBox(lines, { title: "Sub-agent detail", titleStyle: bold })
}

/**
 * Render the fleet snapshot. PURE — deterministic given `rows` + `opts.now`.
 * `json` is always machine-clean (no ANSI regardless of colour policy because
 * it carries no `@/ui` wrappers).
 */
export const renderAgentFleet = (
  rows: readonly AgentFleetRow[],
  opts: RenderAgentFleetOpts,
): string => {
  if (opts.format === "json") return renderJson(rows, opts.now)
  if (rows.length === 0) return EMPTY_PANEL()
  if (opts.format === "tree") return renderTree(rows, opts)
  return renderTable(rows, opts)
}
