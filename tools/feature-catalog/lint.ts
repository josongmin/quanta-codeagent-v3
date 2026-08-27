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
import { BASELINE_PATH } from "./paths"

export interface FcBaseline {
  /** Max empty stubs allowed. Grows only by explicit --update-baseline. */
  readonly empty_stubs_max: number
  /** Accepted ADRs known to be orphaned at the time of the last ratchet —
   *  grandfather list. New orphans NOT in this list trigger lint failure. */
  /**
   * Orphan Accepted ADRs forgiven as pre-existing debt, keyed by repo-relative
   * PATH.
   *
   * Keyed by path and not by number because ADR numbers COLLIDE here — 25 numbers
   * are used by more than one file, four of them by ADR-0159. A number-keyed
   * ledger forgave any brand-new ADR that happened to reuse a listed number, which
   * is a ratchet that admits new violations silently. Verified against the live
   * tool before the change: adding `0159-<new>.md` took the orphan count 32 -> 33
   * and `lint` still printed `ok`.
   */
  readonly orphan_adr_paths_grandfathered: readonly string[]
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

  const grandfathered = new Set(baseline.orphan_adr_paths_grandfathered)
  // An ADR with no path cannot be matched against a path ledger, so it is never
  // forgiven — the safe direction: an unidentifiable orphan fails loudly rather
  // than being absorbed by a number that happens to be listed.
  const newOrphans = report.orphanAdrs.filter((adr) => !grandfathered.has(adr.path ?? ""))
  if (newOrphans.length > 0) {
    errors.push(
      `orphan Accepted ADRs not in fc: ${newOrphans.map((adr) => formatAdr(adr)).join(", ")}. ` +
        `Add an fc entry that references the ADR, or grandfather via --update-baseline.`,
    )
  }

  if (report.counts.emptyStubs < baseline.empty_stubs_max) {
    warnings.push(
      `empty stubs ratchet can tighten: ${report.counts.emptyStubs} < baseline ${baseline.empty_stubs_max}. ` +
        `Run \`bun fc lint --update-baseline\` to lock in the improvement.`,
    )
  }
  const stillGrandfathered = report.orphanAdrs.filter((adr) => grandfathered.has(adr.path ?? ""))
  const removedFromOrphan = baseline.orphan_adr_paths_grandfathered.filter(
    (p) => !report.orphanAdrs.some((adr) => (adr.path ?? "") === p),
  )
  if (removedFromOrphan.length > 0) {
    warnings.push(
      `${removedFromOrphan.length} grandfathered orphan ADR(s) now wired up: ` +
        `${removedFromOrphan.join(", ")}. ` +
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
    orphan_adr_paths_grandfathered: [
      ...new Set(report.orphanAdrs.map((adr) => adr.path ?? "")),
      // localeCompare, not `a - b`: the ledger holds PATHS now, and subtracting
      // two strings yields NaN, which leaves `sort` order-dependent on input.
    ].sort((a, b) => a.localeCompare(b)),
    updated_at: now().toISOString(),
  }
}

function formatAdr(adr: { readonly number: number; readonly path?: string }): string {
  const label = `ADR-${String(adr.number).padStart(4, "0")}`
  return adr.path ? `${label} (${adr.path})` : label
}

/** On-disk baseline.json shape. We tuck fc state into a sub-object so the
 *  existing `tests`/`tsc`/`biome` keys keep working unchanged. */
interface BaselineFileShape {
  fc?: {
    empty_stubs_max?: number
    orphan_adr_paths_grandfathered?: readonly string[]
    updated_at?: string
  }
  [k: string]: unknown
}

const DEFAULT_BASELINE: FcBaseline = {
  empty_stubs_max: 0,
  orphan_adr_paths_grandfathered: [],
  updated_at: "1970-01-01T00:00:00.000Z",
}

/** Read `baseline.json` and pull the `fc` sub-object. Missing file or missing
 *  sub-object → DEFAULT_BASELINE (zero cap — strict). */
export async function loadFcBaseline(path: string = BASELINE_PATH): Promise<FcBaseline> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT → the EMPTY baseline, which forgives nothing. That is the correct
    // direction (a missing ledger must not grandfather anything), and it is why
    // the cwd-relative default was so quiet: from a foreign working directory the
    // read failed, the ledger read as empty, and `lint` reported all 19
    // grandfathered orphans as NEW errors — the same command disagreeing with
    // itself over the same tree. Anchored on the module.
    if (code === "ENOENT") return DEFAULT_BASELINE
    throw err
  }
  const raw = JSON.parse(text) as BaselineFileShape
  const fc = raw.fc
  if (
    fc === undefined ||
    typeof fc.empty_stubs_max !== "number" ||
    !Array.isArray(fc.orphan_adr_paths_grandfathered) ||
    typeof fc.updated_at !== "string"
  ) {
    return DEFAULT_BASELINE
  }
  return {
    empty_stubs_max: fc.empty_stubs_max,
    orphan_adr_paths_grandfathered: fc.orphan_adr_paths_grandfathered.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
    updated_at: fc.updated_at,
  }
}

/** Write the fc subobject back into baseline.json without disturbing the rest.
 *  Atomic: read-modify-write the whole file. */
export async function saveFcBaseline(
  fc: FcBaseline,
  // Anchored for the same reason as the loader, and it matters more here: a
  // cwd-relative default WRITES the ledger into whatever tree the caller happens
  // to be standing in.
  path: string = BASELINE_PATH,
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
    orphan_adr_paths_grandfathered: fc.orphan_adr_paths_grandfathered.slice(),
    updated_at: fc.updated_at,
  }
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8")
}
