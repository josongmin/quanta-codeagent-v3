/**
 * Feature-catalog ratchet — refuses *growth* of known slop.
 *
 * The catalog has a pre-existing backlog of migrated-shell stubs that we won't
 * fix in one batch (each needs careful per-stub investigation). The lint
 * doesn't try to *fix* the backlog — it just prevents it from getting WORSE.
 *
 *   - empty stubs    — HARD cap at baseline; new shells block CI.
 *   - orphan ADRs    — HARD cap at 0 for Accepted ADRs (and at baseline for the
 *                      one-time grandfather list when migration leftovers exist).
 *   - orphan src     — SOFT signal only: count returned, no fail (leaf helpers
 *                      legitimately exist; this number drifts naturally).
 *
 * The baseline lives in `baseline.json` under the `fc` subobject. `bun fc lint`
 * compares the audit's current counts against that baseline and exits non-zero
 * on growth. To consciously raise the cap (e.g. after a refactor adds files
 * faster than fc entries), run `bun fc lint --update-baseline` — that move is
 * explicit and review-visible.
 */
import { readFile, writeFile } from "node:fs/promises"
import type { AuditReport } from "./audit"

export interface FcBaseline {
  /** Max empty stubs allowed. Grows only by explicit --update-baseline. */
  readonly empty_stubs_max: number
  /** Accepted ADRs known to be orphaned at the time of the last ratchet —
   *  grandfather list. New orphans NOT in this list trigger lint failure. */
  readonly orphan_adrs_grandfathered: readonly number[]
  /** When the baseline was last written. */
  readonly updated_at: string
}

export interface LintResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** Pure lint — given current audit + baseline, decide pass/fail. */
export function runLint(report: AuditReport, baseline: FcBaseline): LintResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (report.counts.emptyStubs > baseline.empty_stubs_max) {
    errors.push(
      `empty stubs: ${report.counts.emptyStubs} > baseline ${baseline.empty_stubs_max}. ` +
        `New empty stub(s) added. Either fill them in, or run \`bun fc lint --update-baseline\` if intentional.`,
    )
  }

  const grandfathered = new Set(baseline.orphan_adrs_grandfathered)
  const newOrphans = report.orphanAdrs.filter((n) => !grandfathered.has(n))
  if (newOrphans.length > 0) {
    errors.push(
      `orphan Accepted ADRs not in fc: ${newOrphans
        .map((n) => `ADR-${String(n).padStart(4, "0")}`)
        .join(", ")}. ` +
        `Add an fc entry that references the ADR, or grandfather via --update-baseline.`,
    )
  }

  if (report.counts.emptyStubs < baseline.empty_stubs_max) {
    warnings.push(
      `empty stubs ratchet can tighten: ${report.counts.emptyStubs} < baseline ${baseline.empty_stubs_max}. ` +
        `Run \`bun fc lint --update-baseline\` to lock in the improvement.`,
    )
  }
  const stillGrandfathered = report.orphanAdrs.filter((n) => grandfathered.has(n))
  const removedFromOrphan = baseline.orphan_adrs_grandfathered.filter(
    (n) => !report.orphanAdrs.includes(n),
  )
  if (removedFromOrphan.length > 0) {
    warnings.push(
      `${removedFromOrphan.length} grandfathered orphan ADR(s) now wired up: ` +
        `${removedFromOrphan.map((n) => `ADR-${String(n).padStart(4, "0")}`).join(", ")}. ` +
        `Run --update-baseline to remove them from the grandfather list.`,
    )
  }
  if (stillGrandfathered.length > 0) {
    warnings.push(
      `${stillGrandfathered.length} grandfathered orphan ADR(s) still unwired (informational).`,
    )
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Build a fresh baseline snapshot from a current audit. */
export function snapshotBaseline(
  report: AuditReport,
  now: () => Date = () => new Date(),
): FcBaseline {
  return {
    empty_stubs_max: report.counts.emptyStubs,
    orphan_adrs_grandfathered: report.orphanAdrs.slice().sort((a, b) => a - b),
    updated_at: now().toISOString(),
  }
}

/** On-disk baseline.json shape. We tuck fc state into a sub-object so the
 *  existing `tests`/`tsc`/`biome` keys keep working unchanged. */
interface BaselineFileShape {
  fc?: {
    empty_stubs_max?: number
    orphan_adrs_grandfathered?: readonly number[]
    updated_at?: string
  }
  [k: string]: unknown
}

const DEFAULT_BASELINE: FcBaseline = {
  empty_stubs_max: 0,
  orphan_adrs_grandfathered: [],
  updated_at: "1970-01-01T00:00:00.000Z",
}

/** Read `baseline.json` and pull the `fc` sub-object. Missing file or missing
 *  sub-object → DEFAULT_BASELINE (zero cap — strict). */
export async function loadFcBaseline(
  path = "tools/feature-catalog/baseline.json",
): Promise<FcBaseline> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return DEFAULT_BASELINE
    throw err
  }
  const raw = JSON.parse(text) as BaselineFileShape
  const fc = raw.fc
  if (
    fc === undefined ||
    typeof fc.empty_stubs_max !== "number" ||
    !Array.isArray(fc.orphan_adrs_grandfathered) ||
    typeof fc.updated_at !== "string"
  ) {
    return DEFAULT_BASELINE
  }
  return {
    empty_stubs_max: fc.empty_stubs_max,
    orphan_adrs_grandfathered: fc.orphan_adrs_grandfathered.filter(
      (n): n is number => typeof n === "number",
    ),
    updated_at: fc.updated_at,
  }
}

/** Write the fc subobject back into baseline.json without disturbing the rest.
 *  Atomic: read-modify-write the whole file. */
export async function saveFcBaseline(
  fc: FcBaseline,
  path = "tools/feature-catalog/baseline.json",
): Promise<void> {
  let raw: BaselineFileShape = {}
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as BaselineFileShape
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
  raw.fc = {
    empty_stubs_max: fc.empty_stubs_max,
    orphan_adrs_grandfathered: fc.orphan_adrs_grandfathered.slice(),
    updated_at: fc.updated_at,
  }
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8")
}
