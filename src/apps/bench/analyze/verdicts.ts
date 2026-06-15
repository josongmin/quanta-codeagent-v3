/**
 * ADR-0536 P0 — bench ANALYSIS layer (PURE).
 *
 * Normalises the two report shapes the bench world produces into one
 * `RunVerdicts` value (four disjoint-ish sets of instance ids):
 *
 *   1. OUR bench `report.json` (built by `@/runner/batch/report` →
 *      `src/apps/bench/index.ts writeArtifacts`):
 *        { perInstance:[{ id, passed, patchBytes?, failure?:{termination,signals} }] }
 *
 *   2. The official swebench HARNESS report json (remote grading):
 *        { resolved_ids:[], unresolved_ids:[], error_ids:[], empty_patch_ids:[] }
 *
 * Detection is structural (presence of `perInstance` vs `resolved_ids`), never
 * by a version field — both shapes are produced by tools we don't control the
 * versioning of.
 *
 * No I/O beyond reading the file in `loadVerdictsFromFile`; the core
 * `loadVerdicts` is a pure unknown→value transform.
 */

import { readFileSync } from "node:fs"

export interface RunVerdicts {
  readonly resolved: ReadonlySet<string>
  readonly unresolved: ReadonlySet<string>
  readonly errored: ReadonlySet<string>
  readonly emptyPatch: ReadonlySet<string>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Best-effort string-array coercion. Accepts a real array of strings OR a
 *  JSON-encoded string array (some swebench exports double-encode the id
 *  arrays). Anything else → []. */
const strArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0)
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      }
    } catch {
      // not JSON — fall through
    }
  }
  return []
}

/** A `perInstance` row carries an empty patch when the report explicitly says
 *  `patchBytes === 0` OR the structured failure classifier tagged an
 *  `empty_patch` signal (covers the case where patchBytes is absent/legacy). */
const rowIsEmptyPatch = (row: Record<string, unknown>): boolean => {
  if (typeof row.patchBytes === "number" && row.patchBytes === 0) return true
  const failure = row.failure
  if (isRecord(failure)) {
    const signals = failure.signals
    if (Array.isArray(signals) && signals.includes("empty_patch")) return true
  }
  return false
}

const rowIsErrored = (row: Record<string, unknown>): boolean => {
  const failure = row.failure
  if (isRecord(failure) && failure.termination === "harness_error") return true
  return false
}

const fromOurReport = (perInstance: readonly unknown[]): RunVerdicts => {
  const resolved = new Set<string>()
  const unresolved = new Set<string>()
  const errored = new Set<string>()
  const emptyPatch = new Set<string>()
  for (const raw of perInstance) {
    if (!isRecord(raw)) continue
    const id = raw.id
    if (typeof id !== "string" || id.length === 0) continue
    if (raw.passed === true) {
      resolved.add(id)
      continue
    }
    // A failed instance can be BOTH errored and empty-patch-ish; classify it
    // into the most specific failure bucket first (errored > emptyPatch >
    // unresolved) so each id lands in exactly one set.
    if (rowIsErrored(raw)) {
      errored.add(id)
    } else if (rowIsEmptyPatch(raw)) {
      emptyPatch.add(id)
    } else {
      unresolved.add(id)
    }
  }
  return { resolved, unresolved, errored, emptyPatch }
}

const fromHarnessReport = (r: Record<string, unknown>): RunVerdicts => ({
  resolved: new Set(strArray(r.resolved_ids)),
  unresolved: new Set(strArray(r.unresolved_ids)),
  errored: new Set(strArray(r.error_ids)),
  emptyPatch: new Set(strArray(r.empty_patch_ids)),
})

export const loadVerdicts = (reportJson: unknown): RunVerdicts => {
  if (!isRecord(reportJson)) {
    throw new Error("loadVerdicts: report is not an object")
  }
  if (Array.isArray(reportJson.perInstance)) {
    return fromOurReport(reportJson.perInstance)
  }
  if (
    "resolved_ids" in reportJson ||
    "unresolved_ids" in reportJson ||
    "error_ids" in reportJson ||
    "empty_patch_ids" in reportJson
  ) {
    return fromHarnessReport(reportJson)
  }
  throw new Error(
    "loadVerdicts: unrecognised report shape (no `perInstance` and no `*_ids` fields)",
  )
}

export const loadVerdictsFromFile = (path: string): RunVerdicts =>
  loadVerdicts(JSON.parse(readFileSync(path, "utf8")))
