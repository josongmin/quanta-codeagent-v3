/**
 * ADR-0536 P0 — cross-run leaderboard (PURE).
 *
 * Flattens one or more `RunVerdicts` into per-instance rows tagged with the
 * run's preset + model, then renders a markdown report split into resolved /
 * unresolved tables. When the same instance appears in multiple rows (e.g. the
 * same instance graded under two presets, or resolved in one run + unresolved
 * in another) we dedup by instanceId keeping the RESOLVED row — the leaderboard
 * answers "is this instance solvable by us at all", so a single green wins.
 */

import type { RunVerdicts } from "./verdicts"

export interface LeaderRow {
  readonly instanceId: string
  readonly repo: string
  readonly preset: string
  readonly model: string
  readonly resolved: boolean
}

/** repo = the segment before `__` in a swebench instance id
 *  (`django__django-12345` → `django`). Falls back to the whole id when there
 *  is no `__`. */
const repoOf = (instanceId: string): string => {
  const idx = instanceId.indexOf("__")
  return idx === -1 ? instanceId : instanceId.slice(0, idx)
}

export const rowsFromRun = (
  v: RunVerdicts,
  meta: { preset: string; model: string },
): readonly LeaderRow[] => {
  const rows: LeaderRow[] = []
  for (const id of v.resolved) {
    rows.push({ instanceId: id, repo: repoOf(id), preset: meta.preset, model: meta.model, resolved: true })
  }
  // Everything not resolved (unresolved / errored / empty-patch) is "not
  // resolved" for the leaderboard's binary question.
  for (const set of [v.unresolved, v.errored, v.emptyPatch]) {
    for (const id of set) {
      rows.push({
        instanceId: id,
        repo: repoOf(id),
        preset: meta.preset,
        model: meta.model,
        resolved: false,
      })
    }
  }
  return rows
}

/** Dedup by instanceId, keeping resolved > unresolved. Among rows of equal
 *  resolved-ness the first-seen row wins (stable). */
const dedup = (rows: readonly LeaderRow[]): LeaderRow[] => {
  const byId = new Map<string, LeaderRow>()
  for (const row of rows) {
    const existing = byId.get(row.instanceId)
    if (existing === undefined) {
      byId.set(row.instanceId, row)
      continue
    }
    // Upgrade an unresolved entry to a resolved one; never downgrade.
    if (!existing.resolved && row.resolved) byId.set(row.instanceId, row)
  }
  return [...byId.values()]
}

const cell = (s: string): string => s.replace(/\|/g, "\\|")

const table = (rows: readonly LeaderRow[]): string => {
  if (rows.length === 0) return "_(none)_"
  const header = "| instance | repo | preset | model |\n| --- | --- | --- | --- |"
  const body = [...rows]
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    .map((r) => `| ${cell(r.instanceId)} | ${cell(r.repo)} | ${cell(r.preset)} | ${cell(r.model)} |`)
    .join("\n")
  return `${header}\n${body}`
}

export const renderLeaderboardMarkdown = (
  rows: readonly LeaderRow[],
  title = "Bench leaderboard",
): string => {
  const deduped = dedup(rows)
  const resolved = deduped.filter((r) => r.resolved)
  const unresolved = deduped.filter((r) => !r.resolved)
  return [
    `# ${title}`,
    "",
    `Resolved: ${resolved.length} / ${deduped.length}`,
    "",
    `## Resolved (${resolved.length})`,
    "",
    table(resolved),
    "",
    `## Unresolved (${unresolved.length})`,
    "",
    table(unresolved),
    "",
  ].join("\n")
}
