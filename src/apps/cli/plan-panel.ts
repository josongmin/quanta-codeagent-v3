/**
 * Plan-mode TUI panel — Codex/Claude plan-store visualization (R10).
 *
 * Renders the live {@link Plan} (via the {@link PlanStore.current} snapshot)
 * as a compact boxed panel: ordered todo list with status glyphs, current-step
 * pointer, and progress header (`Plan (N of M done)`). 100% READ-ONLY — this
 * module never invokes a `PlanStore` mutator. The slash command (`/plan`)
 * accepts a `() => Plan | null` callback in `SlashContext`; absent ⇒ the
 * command prints "plan-store not wired" and exits 0 (default-OFF parity with
 * `/snooze`, `/skills`).
 *
 * Slice discipline:
 *   - Lives in `src/apps/cli`. Imports `@/agent/plan` types ONLY (no mutators,
 *     no `PlanStore` runtime — only the readonly {@link Plan} shape).
 *     This is one-way: apps/cli is the application entrypoint, it depends on
 *     library slices freely (the biome fence runs the other direction).
 *   - Imports `@/ui/ui-helpers` for `bold`/`cyan`/`dim`/`green`/`yellow`/
 *     `gray`/`renderBox`. Color policy is honored — `setColorPolicy("off")`
 *     ⇒ plain ASCII, byte-identical to a non-TTY render.
 *
 * Ordering contract:
 *   - Plans usually have phases (`Plan.phases[]`, ordered by `order` field).
 *     We iterate phases in their declared order, then `phase.todoIds[]` in
 *     declared order. Todos NOT referenced by any phase are appended in
 *     `createdAt` ascending order (stable secondary sort by `id`).
 *   - Numbering is 1-based across the FLATTENED ordered list. The "current"
 *     step is the first todo with status `in_progress` (or, if none,
 *     the first `pending` whose dependencies are all completed); on
 *     all-terminal plans, no current pointer is drawn.
 *
 * Truncation:
 *   - Very long plans (>20 todos by default) are truncated: the first 5
 *     completed + the current step + the next 10 pending/blocked are shown,
 *     with a "… N more" dim line between. The header still reflects the
 *     FULL plan count.
 */

import type { Plan, TodoItem, TodoStatus } from "@/agent/plan/types"
import { bold, cyan, dim, gray, green, red, renderBox, yellow } from "@/ui/ui-helpers"

/** Sentinel rendered when the slash command is invoked with no live plan. */
export const PLAN_PANEL_NO_PLAN = "(no active plan)"

/** Sentinel rendered when the slash command is invoked but the surface did
 *  not wire a plan snapshot callback (default-OFF parity). */
export const PLAN_PANEL_NOT_WIRED = "/plan: plan-store not wired in this surface"

export interface PlanPanelOptions {
  /** Maximum number of rows to render in the body (excluding the header).
   *  Default 20. Plans larger than this are truncated with a "… N more" line. */
  readonly maxRows?: number
  /** Minimum inner box width. Default 56 (matches `renderBox` default so the
   *  panel sits flush with other CLI boxes). */
  readonly minInner?: number
}

const DEFAULT_MAX_ROWS = 20

/** Glyph + colorizer per {@link TodoStatus}. Switch-based so the compiler
 *  enforces exhaustiveness — adding a new {@link TodoStatus} member without
 *  updating the switch fails with `never` arm mismatch. (We avoid a
 *  `Record<TodoStatus, …>` map because `noUncheckedIndexedAccess` makes
 *  every lookup `T | undefined`, forcing nullish checks at every call.) */
const statusGlyph = (s: TodoStatus): string => {
  switch (s) {
    case "completed":
      return "✓"
    case "in_progress":
      return "▶"
    case "pending":
      return "○"
    case "blocked":
      return "■"
    case "cancelled":
      return "✗"
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}

const statusColor = (s: TodoStatus): ((str: string) => string) => {
  switch (s) {
    case "completed":
      return green
    case "in_progress":
      return cyan
    case "pending":
      return gray
    case "blocked":
      return yellow
    case "cancelled":
      return red
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}

/** Stable ordered todo iteration. Phases first (`order` ascending, then array
 *  index as tiebreaker), then orphan todos (no phaseId or phaseId pointing
 *  outside the phase index) sorted by `createdAt` ascending, then `id`. */
const orderedTodos = (plan: Plan): readonly TodoItem[] => {
  const seen = new Set<string>()
  const out: TodoItem[] = []
  const phases = [...plan.phases].sort((a, b) => a.order - b.order)
  for (const ph of phases) {
    for (const id of ph.todoIds) {
      const t = plan.todos[id]
      if (t === undefined) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(t)
    }
  }
  const orphans: TodoItem[] = []
  for (const id of Object.keys(plan.todos)) {
    if (seen.has(id)) continue
    const t = plan.todos[id]
    if (t === undefined) continue
    orphans.push(t)
  }
  orphans.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return [...out, ...orphans]
}

/** Count terminal-success todos (status === completed). Cancelled is NOT
 *  counted as "done" — it is an explicit abandonment in the 5-state lifecycle. */
const countCompleted = (todos: readonly TodoItem[]): number =>
  todos.reduce((n, t) => n + (t.status === "completed" ? 1 : 0), 0)

/** Find the index of the current step. Preference order:
 *   1. First todo with status `in_progress`.
 *   2. First todo with status `pending` (used when no `in_progress` exists,
 *      e.g. the operator has paused work).
 *  Returns -1 when every todo is terminal (completed / cancelled) — caller
 *  then omits the current-step pointer (and the header celebrates). */
const findCurrentIndex = (todos: readonly TodoItem[]): number => {
  for (let i = 0; i < todos.length; i++) {
    if (todos[i]?.status === "in_progress") return i
  }
  for (let i = 0; i < todos.length; i++) {
    if (todos[i]?.status === "pending") return i
  }
  return -1
}

/** Truncate `content` to `max` graphemes (approximated as code units for
 *  the BMP-only fast path). Multi-byte combiners are rare in todo content;
 *  we accept the approximation. */
const truncateContent = (s: string, max: number): string => {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/** Render a single todo row. `currentMarker` is true ⇒ append the "(current)"
 *  suffix in dim color. Number column is right-padded to `numWidth`. */
const renderRow = (
  t: TodoItem,
  index1Based: number,
  numWidth: number,
  contentMax: number,
  currentMarker: boolean,
): string => {
  const glyph = statusGlyph(t.status)
  const colored = statusColor(t.status)(glyph)
  const num = `${index1Based}.`.padEnd(numWidth)
  const content = truncateContent(t.content, contentMax)
  const suffix = currentMarker ? ` ${dim("(current)")}` : ""
  return `${colored} ${num} ${content}${suffix}`
}

/**
 * Compute the visible slice when truncation is needed.
 *
 * Strategy: keep the first 5 completed (so context is preserved), keep the
 * current step (if any), keep the next 10 non-terminal todos after it, and
 * collapse the gap between them with a `… N more` dim line. When the plan
 * fits in `maxRows`, returns the original todos verbatim with no marker.
 *
 * The returned shape is a sparse array of "row spec" entries: either a real
 * todo (`{ kind: "todo", item, index1Based, isCurrent }`) or a gap marker
 * (`{ kind: "gap", count }`). The renderer paints them in order.
 */
type RowSpec =
  | {
      readonly kind: "todo"
      readonly item: TodoItem
      readonly index1Based: number
      readonly isCurrent: boolean
    }
  | { readonly kind: "gap"; readonly count: number }

const planRowSpecs = (
  todos: readonly TodoItem[],
  currentIdx: number,
  maxRows: number,
): readonly RowSpec[] => {
  if (todos.length <= maxRows) {
    return todos.map(
      (item, i): RowSpec => ({
        kind: "todo",
        item,
        index1Based: i + 1,
        isCurrent: i === currentIdx,
      }),
    )
  }
  const headKeep = 5 // first N completed (or whatever is at the head)
  const tailKeep = Math.max(1, maxRows - headKeep - 2) // -2 for gap + current spacing
  const out: RowSpec[] = []
  for (let i = 0; i < Math.min(headKeep, todos.length); i++) {
    const item = todos[i] as TodoItem
    out.push({ kind: "todo", item, index1Based: i + 1, isCurrent: i === currentIdx })
  }
  // Decide where to resume — around the current step if it's beyond headKeep,
  // otherwise simply continue from after head with the tail window.
  let resumeFrom: number
  if (currentIdx >= 0 && currentIdx > headKeep) {
    // Start one before current so the user sees "what just finished".
    resumeFrom = Math.max(headKeep, currentIdx - 1)
  } else {
    resumeFrom = todos.length - tailKeep
  }
  if (resumeFrom > headKeep) {
    out.push({ kind: "gap", count: resumeFrom - headKeep })
  }
  const tailEnd = Math.min(todos.length, resumeFrom + tailKeep)
  for (let i = resumeFrom; i < tailEnd; i++) {
    const item = todos[i] as TodoItem
    out.push({ kind: "todo", item, index1Based: i + 1, isCurrent: i === currentIdx })
  }
  if (tailEnd < todos.length) {
    out.push({ kind: "gap", count: todos.length - tailEnd })
  }
  return out
}

/** Header line: `Plan (3 of 7 done)` — used as box title. Counts COMPLETED
 *  todos against TOTAL (including cancelled / blocked / pending). */
export const renderPlanHeader = (plan: Plan): string => {
  const todos = orderedTodos(plan)
  const total = todos.length
  const done = countCompleted(todos)
  const name = plan.name.trim().length > 0 ? plan.name.trim() : "Plan"
  return total === 0 ? `${name} (empty)` : `${name} (${done} of ${total} done)`
}

/**
 * Render the boxed plan panel. Returns a multi-line string suitable for
 * `process.stdout.write`. `plan === null` ⇒ returns the no-plan placeholder
 * (`PLAN_PANEL_NO_PLAN` inside a small box) — callers MAY skip rendering
 * entirely in that case, but the function never throws.
 */
export const renderPlanPanel = (plan: Plan | null, opts: PlanPanelOptions = {}): string => {
  if (plan === null) {
    return renderBox([dim(PLAN_PANEL_NO_PLAN)], {
      title: "Plan",
      titleStyle: bold,
      ...(opts.minInner !== undefined ? { minInner: opts.minInner } : {}),
    })
  }
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS
  const todos = orderedTodos(plan)
  if (todos.length === 0) {
    return renderBox([dim("(no steps)")], {
      title: bold(renderPlanHeader(plan)),
      ...(opts.minInner !== undefined ? { minInner: opts.minInner } : {}),
    })
  }
  const currentIdx = findCurrentIndex(todos)
  const numWidth = `${todos.length}.`.length
  // Reserve ~16 chars for the leading "{glyph} {num.}  " + suffix; the rest
  // of the inner width is content room. We don't measure box width here
  // (renderBox auto-expands to fit) — instead cap content at 80 chars so a
  // narrow terminal doesn't get a giant box. Multi-line wrap is intentionally
  // NOT done: the panel is meant to be scannable at-a-glance.
  const contentMax = 80
  const specs = planRowSpecs(todos, currentIdx, maxRows)
  const lines: string[] = []
  for (const spec of specs) {
    if (spec.kind === "gap") {
      lines.push(dim(`  … ${spec.count} more`))
    } else {
      lines.push(renderRow(spec.item, spec.index1Based, numWidth, contentMax, spec.isCurrent))
    }
  }
  const overview = plan.overview.trim()
  const boxOpts: Parameters<typeof renderBox>[1] = {
    title: bold(renderPlanHeader(plan)),
    ...(overview.length > 0 ? { footer: truncateContent(overview, 100) } : {}),
    ...(opts.minInner !== undefined ? { minInner: opts.minInner } : {}),
  }
  return renderBox(lines, boxOpts)
}

/** Convenience: write the panel to `out` followed by a trailing newline.
 *  Used by the `/plan` slash command. Idempotent / pure — caller controls
 *  stream + flush semantics. */
export const writePlanPanel = (
  plan: Plan | null,
  out: (s: string) => void,
  opts: PlanPanelOptions = {},
): void => {
  out(`${renderPlanPanel(plan, opts)}\n`)
}
