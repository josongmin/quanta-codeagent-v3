/**
 * Activity tree renderer (jun-15 P0-b) — the `/activity` view.
 *
 * PURE: snapshot + injected `now` ⇒ plain lines (glyphs, no ANSI). Colour is a
 * surface concern layered by `@/ui` (mirrors the `agents-fleet-panel.ts`
 * discipline: no `process.stdout.isTTY`, deterministic age via injected `now`).
 * The L0→L2 zoom is one indented tree: run → phase → agent, with the why-stuck
 * reason rendered inline (the north-star "왜 멈췄나" payload).
 */

import { projectTree } from "./project"
import type { ActivitySnapshot, ActivityStatus, Stuck } from "./types"

/** Status → glyph SSOT (shared vocabulary across surfaces). */
const GLYPH: Readonly<Record<ActivityStatus, string>> = {
  done: "✓",
  running: "⏳",
  stuck: "🛑",
  idle: "💤",
  pending: "◌",
  failed: "✗",
  skipped: "⊘",
  stopped: "■",
}

/** Stuck reason → short action hint. */
const STUCK_HINT: Readonly<Record<Stuck["reason"], string>> = {
  waiting_approval: "waiting approval",
  rate_limited: "rate limited",
  waiting_tool: "waiting tool",
  waiting_subagent: "waiting subagent",
  waiting_input: "waiting input",
  unknown: "blocked",
}

export interface RenderActivityOpts {
  /** Injected wall-clock ms — drives the header age deterministically. */
  readonly now: number
  /** Max body rows before collapsing with a "+N more" footer. Default 40. */
  readonly maxRows?: number
}

/** Compact `12s` / `3m` / `1h` age. Clamps non-finite/negative to `0s`. */
export const formatAge = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h`
}

/** Humanize a token count: `1.2M` / `340k` / `42`. */
const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

const headerLine = (s: ActivitySnapshot): string => {
  const a = s.aggregate
  const parts = [`${a.agents} agent${a.agents === 1 ? "" : "s"}`, `${a.running} running`]
  if (a.stuck > 0) parts.push(`${a.stuck} stuck`)
  parts.push(`${fmtTokens(a.tokens)} tok`)
  if (a.toolCalls > 0) parts.push(`${a.toolCalls} tool call${a.toolCalls === 1 ? "" : "s"}`)
  return `ACTIVITY  ${parts.join(" · ")}`
}

const nodeLine = (snapshot: ActivitySnapshot, id: string, depth: number): string => {
  const n = snapshot.byId.get(id)
  if (n === undefined) return ""
  const indent = "  ".repeat(depth)
  const glyph = GLYPH[n.status] ?? "?"
  let line = `${indent}${glyph} ${n.label}`
  if (n.tokens > 0) line += `  ${fmtTokens(n.tokens)} tok`
  // RFC02-5 — a correlated long-running operation shows its stable operation id
  // inline so a surface can stitch this row's running→done|failed to the run/
  // thread/turn that ordered it. Low-cardinality (an id, never free text). Only
  // correlated nodes carry this, so ordinary rows stay byte-identical.
  if (n.correlation !== undefined) line += `  · op:${n.correlation.operationId}`
  // Only the node that is ITSELF blocked carries the why-stuck annotation; a
  // container shows the 🛑 glyph (the branch is blocked) but not a redundant
  // "blocked" label — the real reason lives on the leaf below it.
  if (n.status === "stuck" && n.stuck !== undefined) {
    const hint = STUCK_HINT[n.stuck.reason]
    line += `  · STUCK: ${hint}${n.stuck.detail !== undefined ? ` → ${n.stuck.detail}` : ""}`
  }
  return line
}

/**
 * Render the activity snapshot into `/activity` body lines (header first).
 * Walks the tree depth-first in the snapshot's deterministic order; collapses
 * past `maxRows` with a "+N more" footer (never silently truncates).
 */
export const renderActivity = (
  snapshot: ActivitySnapshot,
  opts: RenderActivityOpts,
): readonly string[] => {
  const lines: string[] = [headerLine(snapshot)]
  if (snapshot.roots.length === 0) {
    lines.push("  (no active agents)")
    return lines
  }
  const max = opts.maxRows !== undefined && opts.maxRows > 0 ? opts.maxRows : 40
  const body: string[] = []
  const walk = (id: string, depth: number): void => {
    body.push(nodeLine(snapshot, id, depth))
    for (const child of projectTree(snapshot, id)[0]?.children ?? []) {
      walk(child.node.id, depth + 1)
    }
  }
  for (const root of snapshot.roots) walk(root, 0)
  if (body.length > max) {
    lines.push(...body.slice(0, max), `  … +${body.length - max} more`)
  } else {
    lines.push(...body)
  }
  return lines
}
