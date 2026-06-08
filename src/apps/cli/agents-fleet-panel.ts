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
}

export interface RenderAgentFleetOpts {
  readonly format: "table" | "json" | "tree"
  /** Injected wall-clock ms — drives the age column deterministically. */
  readonly now: number
  /** When true, do NOT collapse settled rows. HONEST note: `--all` only
   *  changes presentation; it cannot resurrect LRU-evicted records (those are
   *  already gone from the registry Map before they ever reach this renderer). */
  readonly all?: boolean
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
 *  head so log lines remain greppable while staying narrow. */
const shortId = (id: string): string =>
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

const UNTYPED = "untyped"

const renderTree = (rows: readonly AgentFleetRow[], opts: RenderAgentFleetOpts): string => {
  const sorted = ordered(rows)
  const groups = new Map<string, AgentFleetRow[]>()
  for (const r of sorted) {
    const key = r.agentType ?? UNTYPED
    const bucket = groups.get(key) ?? []
    bucket.push(r)
    groups.set(key, bucket)
  }
  const lines: string[] = []
  // Deterministic group order: byte-sorted type names, UNTYPED last.
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === UNTYPED) return 1
    if (b === UNTYPED) return -1
    return a < b ? -1 : a > b ? 1 : 0
  })
  for (const key of keys) {
    const bucket = groups.get(key) ?? []
    lines.push(`${bold(key)} ${dim(`(${bucket.length})`)}`)
    for (const r of bucket) {
      lines.push(`  ${statusCell(r.status)}  ${shortId(r.id)}  ${dim(rowAge(r, opts.now))}`)
    }
  }
  return renderBox(lines, {
    title: "Agent fleet",
    titleStyle: bold,
    footer: footerLine(countFleet(rows)),
  })
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
