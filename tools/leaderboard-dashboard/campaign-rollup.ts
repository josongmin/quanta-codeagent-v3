/**
 * The CAMPAIGN ROLLUP — many report files → one ranked logical campaign.
 *
 * Extracted out of `server.ts` (which calls `Bun.serve` at import and therefore
 * cannot be imported by anything, tests included) so the surface that RANKS runs
 * is directly testable, and so the shell does not re-grow.
 *
 * ## Why this file has an official-grade branch
 *
 * The per-RUN numbers already came off the artifact's persisted
 * `officialGrade.totals` (see `tallyOf` + the SWE projector's `headline`). The
 * campaign rollup — the ranking surface, the one an operator reads first — did
 * not: it ignored `officialGrade` entirely and re-folded `perInstance` rows,
 * publishing the LOCAL verifier's rate with a shrunken denominator and no
 * coverage beside it. That is the exact rule this repo has: *a smaller valid
 * denominator must never make a run look better without the coverage loss being
 * visible.*
 *
 * So when a campaign's members carry persisted totals, the rollup SUMS those
 * totals and ranks on `resolved / assigned` — the raw rate, whose denominator is
 * everything the campaign was accountable for — and carries the coverage string
 * so every surface that prints the rate can print the loss beside it.
 *
 * Summation is the honest fold for sidecars: chunk receipts partition the
 * campaign, and where they OVERLAP (a relaunch re-graded an instance) the
 * duplicate inflates the DENOMINATOR — the conservative direction. It can only
 * understate, never flatter, and the coverage figure makes the inflation
 * visible. The summed totals are re-validated through the report layer's own
 * covering-partition assertion; a campaign whose members do not sum to a legal
 * partition publishes NO official numbers rather than a plausible-looking one.
 */
import {
  formatOfficialGradeTotals,
  type OfficialGradeTotals,
  sumOfficialGradeTotals,
  uncoveredOfficialGradeTotals,
} from "@/runner/batch/report-official-grade"
import { campaignKeyOf } from "./family-partition"
import type { FailInfo, Run } from "./run-types"

/**
 * `repo__instance-1` → `instance-1`. The dashboard's instance identity, defined
 * HERE because the rollup is what keys on it; the server imports it so there is
 * exactly one spelling of "the same instance".
 */
export const shortId = (full: string): string => {
  if (!full) return ""
  if (!full.includes("__")) return full
  return full.split("__")[1] ?? ""
}

/**
 * A re-runnable measurement HOLE (throttle / infra / env-degraded), which leaves
 * the denominator. A suite whose rows carry no re-runnable channel supplies no
 * `fail`, so this is exactly the SWE rule it is named after.
 */
export const instanceIsUnmeasured = (pi: { passed: boolean; fail?: FailInfo | null }): boolean =>
  !pi.passed && pi.fail?.reRunnable === true

export interface Campaign {
  key: string
  members: string[] // file labels that rolled up into this campaign
  model: string
  preset: string
  /** Dataset family (RFC jun-29 R4) — the SWE axis only. Lets the UI chip/filter
   *  by dataset so a pro resolved-rate is never shown beside (or averaged into)
   *  the verified leaderboard number. Absent on family-less suites. */
  datasetFamily?: string
  /** Top-level view tab this campaign belongs to (see Run.viewId). */
  viewId: string
  mtime: number
  resolved: number
  // Denominator EXCLUDING re-runnable holes (FLAG-B). An instance counts as
  // unmeasured only if EVERY run failed to measure it (a measured/passing run
  // anywhere wins), mirroring verdicts.ts dedup semantics.
  total: number
  unmeasured: number
  /**
   * PMX-05 — the campaign's PERSISTED official-grade totals, summed across the
   * members that carry them. Absent ⇒ this campaign never ran an official
   * grader and `resolved`/`total` are the historical row fold.
   *
   * When present, `resolved`/`total` above are `resolved`/`assigned` off THESE
   * totals: the ranking surface reads the grader's numbers, not a second fold of
   * per-instance rows.
   */
  official?: OfficialGradeTotals
  /**
   * The coverage string (`"38.7% (65/168)"`) every surface must print BESIDE the
   * rate. It exists as a rendered string so the client cannot re-derive it into
   * a different rounding rule — the same reason `officialGrade.display` does.
   */
  coverage?: string
}

// Per-instance rollup state inside one campaign. passed wins over everything;
// among non-passing, a measured failure (real miss) wins over an unmeasured
// hole — so an instance only counts as unmeasured when no run ever measured it.
interface SeenInstance {
  passed: boolean
  measured: boolean // at least one run produced a graded/real outcome (not a hole)
}

// campaignKeyOf moved to ./family-partition (testable — server.ts calls Bun.serve at
// import, so a unit test cannot import it). RFC jun-29 R4 partition lives there.

const addRunToCampaign = (
  groups: Map<string, Campaign & { seen: Map<string, SeenInstance> }>,
  run: Run,
): void => {
  const key = campaignKeyOf(run)
  let group = groups.get(key)
  if (!group) {
    group = {
      key,
      members: [],
      model: run.model,
      preset: run.preset,
      ...(run.datasetFamily !== undefined ? { datasetFamily: run.datasetFamily } : {}),
      viewId: run.viewId,
      mtime: 0,
      resolved: 0,
      total: 0,
      unmeasured: 0,
      seen: new Map(),
    }
    groups.set(key, group)
  }
  group.members.push(run.label)
  group.mtime = Math.max(group.mtime, run.mtime)
  for (const perInstance of run.perInstance) {
    const sid = shortId(perInstance.id)
    if (!sid) continue
    const prev = group.seen.get(sid)
    const measured = perInstance.passed || !instanceIsUnmeasured(perInstance)
    group.seen.set(sid, {
      passed: (prev?.passed ?? false) || perInstance.passed,
      measured: (prev?.measured ?? false) || measured,
    })
  }
}

/**
 * One campaign's published row.
 *
 * The row fold (`resolved`/`total` from the per-instance union) is computed
 * FIRST and always — it is the historical behavior and the fallback. Then, when
 * the members carry persisted official totals, THOSE replace the headline pair
 * and the coverage string ships beside it. The rate is `resolved / assigned`,
 * deliberately not `resolved / grading_valid`: the flattering valid denominator
 * is never the quotable one (same choice the SWE projector's `headline` makes).
 */
const campaignRow = (
  group: Campaign & { seen: Map<string, SeenInstance> },
  members: readonly Run[],
): Campaign => {
  const seen = [...group.seen.values()]
  // FLAG-B: unmeasured = instances NO run ever measured (all-throttle/infra).
  // They leave the denominator; surfaced separately as `unmeasured`.
  const unmeasured = seen.filter((s) => !s.passed && !s.measured).length
  const official = rollUpOfficialGrade(members)
  const display = official === undefined ? undefined : formatOfficialGradeTotals(official)
  return {
    key: group.key,
    members: group.members,
    model: group.model,
    preset: group.preset,
    mtime: group.mtime,
    resolved: official?.resolved ?? seen.filter((s) => s.passed).length,
    total: official?.assigned ?? group.seen.size - unmeasured,
    unmeasured,
    ...(official !== undefined ? { official } : {}),
    ...(display !== undefined ? { coverage: display.coverage } : {}),
    ...(group.datasetFamily !== undefined ? { datasetFamily: group.datasetFamily } : {}),
    viewId: group.viewId,
  }
}

// Roll many report files into logical campaigns:
//   - shards (`clean-shard3`)         → one run (SOTA-clean = 16/36)
//   - full-remote `report-i-*` sidecars → one campaign per (dir, model)
//   - `local-*` single targets         → one bucket
// resolved/total dedupe by instance (union) so overlapping sidecars don't
// double-count.
export function groupRuns(runs: Run[]): Campaign[] {
  const groups = new Map<string, Campaign & { seen: Map<string, SeenInstance> }>()
  const membersByKey = new Map<string, Run[]>()
  for (const run of runs) {
    addRunToCampaign(groups, run)
    const key = campaignKeyOf(run)
    const bucket = membersByKey.get(key)
    if (bucket === undefined) membersByKey.set(key, [run])
    else bucket.push(run)
  }
  const out: Campaign[] = []
  for (const group of groups.values()) {
    out.push(campaignRow(group, membersByKey.get(group.key) ?? []))
  }
  // Rank on the REAL solve-rate (resolved / measured-total), so throttle noise
  // can no longer reorder the leaderboard. Ties broken by larger measured set.
  return out.sort(
    (a, b) =>
      b.resolved / Math.max(1, b.total) - a.resolved / Math.max(1, a.total) || b.total - a.total,
  )
}

// ---------------------------------------------------------------------------
// official-grade fold
// ---------------------------------------------------------------------------

/**
 * Sum the persisted totals of every member that has them, or `undefined` when
 * none does (⇒ the row-counting fold stays byte-identical for every campaign
 * that never ran an official grader).
 *
 * The ARITHMETIC is deliberately not here: `sumOfficialGradeTotals` belongs to
 * the report aggregator, the one official-grade scoring authority. This function
 * only decides WHICH members contribute. A campaign whose members do not sum to
 * a legal covering partition publishes NO official numbers — the owner throws
 * and the campaign falls back to the historical row fold rather than shipping a
 * number that does not add up.
 */
export const rollUpOfficialGrade = (members: readonly Run[]): OfficialGradeTotals | undefined => {
  const graded = members.filter(
    (run) => run.instanceRowKind === "swe-grade" && run.officialGrade !== undefined,
  )
  // A campaign that never ran an official grader keeps the historical row fold —
  // it must not acquire a fabricated all-missing official section.
  if (graded.length === 0) return undefined
  const sections = members.map((run) =>
    run.instanceRowKind === "swe-grade" && run.officialGrade !== undefined
      ? run.officialGrade.totals
      : // C-C: an UNCOVERED member. Excluding it published the rate — and the
        // coverage string — over the graded FRACTION of a campaign whose own
        // `members` list named every file. Its instances are what the campaign
        // was accountable for and did not get graded, so they enter the
        // denominator as `missing`, which is what makes the loss visible.
        uncoveredOfficialGradeTotals(run.perInstance.length),
  )
  try {
    return sumOfficialGradeTotals(sections)
  } catch {
    return undefined
  }
}
