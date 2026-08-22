/**
 * ADR-0536 P0 — cross-run leaderboard (PURE).
 *
 * Flattens one or more `RunVerdicts` into per-instance rows tagged with the
 * run's preset + model, then renders a markdown report split by score
 * authority. When the same instance appears in multiple rows we keep the
 * STRONGEST status:
 *
 *   official_harness > local_structural > research_contaminated > unresolved > unmeasured
 *
 * Only `official_harness` counts as leaderboard-resolved.
 *
 * Measurement integrity: re-runnable holes (throttle/429, harness/grader infra,
 * env-degraded) are NOT capability misses. They are tagged `unmeasured`, kept
 * out of the solve-rate DENOMINATOR, and surfaced on a separate line — so a 429
 * no longer deflates the headline rate. Genuine misses (wrong-fix, empty-patch,
 * timeout/generation_error) stay `unresolved` and ARE counted. This mirrors the
 * already-correct `diff.ts` `bUnmeasured` treatment.
 */

import { byteCompare } from "@/shared/byte-compare"
import type { RunVerdicts } from "./verdicts"

export interface LeaderRow {
  readonly instanceId: string
  readonly repo: string
  readonly preset: string
  readonly model: string
  readonly status:
    | "official_harness"
    | "local_structural"
    | "research_contaminated"
    | "unresolved"
    | "unmeasured"
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
    rows.push({
      instanceId: id,
      repo: repoOf(id),
      preset: meta.preset,
      model: meta.model,
      status: "official_harness",
    })
  }
  for (const id of v.localStructural) {
    rows.push({
      instanceId: id,
      repo: repoOf(id),
      preset: meta.preset,
      model: meta.model,
      status: "local_structural",
    })
  }
  for (const id of v.researchContaminated) {
    rows.push({
      instanceId: id,
      repo: repoOf(id),
      preset: meta.preset,
      model: meta.model,
      status: "research_contaminated",
    })
  }
  // Re-runnable measurement-holes (throttle/429, harness/grader infra,
  // env-degraded) — tagged `unmeasured`, excluded from the solve-rate
  // denominator. `reRunnable` is a subset of `errored`; `infraBlocked` is
  // env/degraded (proofState/envPrepFailed) tracked separately by verdicts.ts.
  const reRunnable = new Set<string>([...(v.reRunnable ?? []), ...(v.infraBlocked ?? [])])
  for (const id of reRunnable) {
    rows.push({
      instanceId: id,
      repo: repoOf(id),
      preset: meta.preset,
      model: meta.model,
      status: "unmeasured",
    })
  }
  // Genuine misses that STAY in the denominator: wrong-fix (`unresolved`),
  // empty-patch (model produced nothing), and the non-re-runnable errored
  // terminations (timeout / hung_stream / generation_error). We explicitly
  // EXCLUDE the re-runnable ids from `errored` so they are not double-tagged.
  for (const set of [v.unresolved, v.errored, v.emptyPatch]) {
    for (const id of set) {
      if (reRunnable.has(id)) continue
      rows.push({
        instanceId: id,
        repo: repoOf(id),
        preset: meta.preset,
        model: meta.model,
        status: "unresolved",
      })
    }
  }
  return rows
}

// `unmeasured` ranks BELOW `unresolved`: if an instance was a re-runnable hole
// in one run but a genuine miss (or better) in another, the measured verdict
// wins — we only treat it as unmeasured when EVERY run failed to measure it.
const RANK: Record<LeaderRow["status"], number> = {
  unmeasured: 0,
  unresolved: 1,
  research_contaminated: 2,
  local_structural: 3,
  official_harness: 4,
}

/** Dedup by instanceId, keeping the strongest status. Among equally-strong
 *  rows the first-seen row wins (stable). */
const dedup = (rows: readonly LeaderRow[]): LeaderRow[] => {
  const byId = new Map<string, LeaderRow>()
  for (const row of rows) {
    const existing = byId.get(row.instanceId)
    if (existing === undefined) {
      byId.set(row.instanceId, row)
      continue
    }
    if (RANK[row.status] > RANK[existing.status]) byId.set(row.instanceId, row)
  }
  return [...byId.values()]
}

const cell = (s: string): string => s.replace(/\|/g, "\\|")

const table = (rows: readonly LeaderRow[]): string => {
  if (rows.length === 0) return "_(none)_"
  const header = "| instance | repo | preset | model |\n| --- | --- | --- | --- |"
  const body = [...rows]
    .sort((a, b) => byteCompare(a.instanceId, b.instanceId))
    .map(
      (r) => `| ${cell(r.instanceId)} | ${cell(r.repo)} | ${cell(r.preset)} | ${cell(r.model)} |`,
    )
    .join("\n")
  return `${header}\n${body}`
}

export const renderLeaderboardMarkdown = (
  rows: readonly LeaderRow[],
  title = "Bench leaderboard",
): string => {
  const deduped = dedup(rows)
  const official = deduped.filter((r) => r.status === "official_harness")
  const localStructural = deduped.filter((r) => r.status === "local_structural")
  const researchContaminated = deduped.filter((r) => r.status === "research_contaminated")
  const unresolved = deduped.filter((r) => r.status === "unresolved")
  const unmeasured = deduped.filter((r) => r.status === "unmeasured")
  // Real attempts = everything that was actually measured. Re-runnable holes
  // (throttle/infra/env) are EXCLUDED from the denominator so they can't deflate
  // the headline rate; they are surfaced explicitly on their own line.
  const realAttempts = deduped.length - unmeasured.length
  return [
    `# ${title}`,
    "",
    `Official harness resolved: ${official.length} / ${realAttempts}`,
    `Local structural only: ${localStructural.length}`,
    `Research contaminated: ${researchContaminated.length}`,
    `Unresolved: ${unresolved.length}`,
    `Unmeasured (re-runnable: ${unmeasured.length} throttled/infra): excluded from rate`,
    "",
    `## Official Harness (${official.length})`,
    "",
    table(official),
    "",
    `## Local Structural (${localStructural.length})`,
    "",
    table(localStructural),
    "",
    `## Research Contaminated (${researchContaminated.length})`,
    "",
    table(researchContaminated),
    "",
    `## Unresolved (${unresolved.length})`,
    "",
    table(unresolved),
    "",
    `## Unmeasured — re-runnable (${unmeasured.length})`,
    "",
    table(unmeasured),
    "",
  ].join("\n")
}
