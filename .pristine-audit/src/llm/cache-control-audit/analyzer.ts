/**
 * Cache-control audit — prefix-stability analyzer (ADR-0319).
 *
 * Given a list of snapshot BATCHES (one batch per turn of the same
 * thread/session), report whether the cache-control breakpoints declared
 * in those batches were byte-stable. Anthropic's prompt cache hits only
 * when the prefix bytes up to (and including) a `cache_control: ephemeral`
 * marker are byte-identical to the previous request that warmed the
 * cache. A single drifting byte — a date in the system prompt, a session
 * id, an extra trailing newline — invalidates the cache for that
 * breakpoint and every cascaded one to its right.
 *
 * The analyzer is intentionally simple: no heuristics, no thresholds, no
 * fuzzy matching. ANY drift is reported; the caller decides whether the
 * drift is acceptable (e.g. tail messages SHOULD drift; cached prefixes
 * MUST NOT).
 *
 * Algorithm (linear in total snapshot count):
 *   1. Index every batch by `position` label.
 *   2. For each position the union of batches has touched:
 *      a. If at least one batch has it and at least one does not, emit
 *         a `missing` finding (the breakpoint vanished between turns).
 *      b. If markers disagree across batches that DO have the position,
 *         emit a `marker` finding (cache_control moved or evaporated).
 *      c. If hashes disagree across batches that DO have the position,
 *         emit a `content` finding (the prefix drifted).
 *   3. Roll up per-position `stable` flags + a top-level `stable` flag
 *      = (no findings of any kind).
 *
 * The analyzer compares the FIRST occurrence of each position against
 * every subsequent batch — drift is reported against the canonical
 * "first seen" snapshot, which is how the cache itself behaves (the
 * first request warms; subsequent requests either hit or miss against
 * that warmed prefix).
 */

import type { CachePrefixSnapshot, DriftFinding, PositionReport, StabilityReport } from "./types"

const SAMPLE_CHARS = 80

/** Truncate a content sample for human-readable diff output. */
const sample = (s: string): string =>
  s.length <= SAMPLE_CHARS ? s : `${s.slice(0, SAMPLE_CHARS)}…`

/** One position's per-batch index entry: which batch saw this position
 *  and what its snapshot was. */
interface PositionAppearance {
  readonly batchIndex: number
  readonly snapshot: CachePrefixSnapshot
}

/** Build a map of position → ordered list of appearances. Preserves
 *  caller order within a batch (a batch with two snapshots at the same
 *  position keeps both, in the order supplied). Such collisions are
 *  unusual but legal — the analyzer treats them as separate observations
 *  of the same position. */
const indexByPosition = (
  batches: ReadonlyArray<readonly CachePrefixSnapshot[]>,
): Map<string, PositionAppearance[]> => {
  const out = new Map<string, PositionAppearance[]>()
  batches.forEach((batch, batchIndex) => {
    for (const snapshot of batch) {
      const list = out.get(snapshot.position) ?? []
      list.push({ batchIndex, snapshot })
      out.set(snapshot.position, list)
    }
  })
  return out
}

/** True when this position appears in EVERY batch (no `missing` drift). */
const isPresentInEveryBatch = (
  appearances: readonly PositionAppearance[],
  totalBatches: number,
): boolean => {
  const seen = new Set<number>()
  for (const a of appearances) seen.add(a.batchIndex)
  return seen.size === totalBatches
}

/** Find the first batch index that does NOT contain this position. */
const firstMissingBatch = (
  appearances: readonly PositionAppearance[],
  totalBatches: number,
): number => {
  const seen = new Set<number>()
  for (const a of appearances) seen.add(a.batchIndex)
  for (let i = 0; i < totalBatches; i++) if (!seen.has(i)) return i
  return -1
}

/** Compare each appearance against the FIRST appearance. Emit a finding
 *  for each kind of drift detected; multiple drifts at the same position
 *  produce multiple findings (one per kind, against the first divergent
 *  batch only — repeated drift across many batches is reported once per
 *  kind to keep the report bounded). */
const collectDriftFindings = (
  position: string,
  appearances: readonly PositionAppearance[],
): DriftFinding[] => {
  const findings: DriftFinding[] = []
  if (appearances.length < 2) return findings
  const first = appearances[0]
  if (first === undefined) return findings
  let markerEmitted = false
  let contentEmitted = false
  for (let i = 1; i < appearances.length; i++) {
    const cur = appearances[i]
    if (cur === undefined) continue
    if (!markerEmitted && cur.snapshot.cacheControl !== first.snapshot.cacheControl) {
      findings.push({
        position,
        kind: "marker",
        firstIndex: first.batchIndex,
        secondIndex: cur.batchIndex,
      })
      markerEmitted = true
    }
    if (!contentEmitted && cur.snapshot.hash !== first.snapshot.hash) {
      findings.push({
        position,
        kind: "content",
        firstIndex: first.batchIndex,
        secondIndex: cur.batchIndex,
        firstSample: sample(first.snapshot.content),
        secondSample: sample(cur.snapshot.content),
      })
      contentEmitted = true
    }
    if (markerEmitted && contentEmitted) break
  }
  return findings
}

/** Roll up a per-position report. `stable` is true ⇔ all markers and all
 *  hashes agreed AND the position appeared in every batch (or only
 *  appeared once — trivial stable). */
const buildPositionReport = (
  position: string,
  appearances: readonly PositionAppearance[],
  totalBatches: number,
): PositionReport => {
  const anyMarker = appearances.some((a) => a.snapshot.cacheControl !== undefined)
  const missingMarker = appearances.some((a) => a.snapshot.cacheControl === undefined)
  const allPresent = isPresentInEveryBatch(appearances, totalBatches)
  const firstHash = appearances[0]?.snapshot.hash
  const firstCC = appearances[0]?.snapshot.cacheControl
  const allHashesAgree = appearances.every((a) => a.snapshot.hash === firstHash)
  const allMarkersAgree = appearances.every((a) => a.snapshot.cacheControl === firstCC)
  const stable = allPresent && allHashesAgree && allMarkersAgree
  return { position, stable, anyMarker, missingMarker }
}

/**
 * Analyze a series of snapshot batches across one thread/session.
 *
 * Inputs:
 *   - `batches`: ordered list of per-turn snapshot lists. Each inner
 *     list is one turn's set of cache-control-candidate blocks (system
 *     sections + the conversation prefix breakpoint, typically). Empty
 *     `batches` ⇒ trivially stable (`true`, no positions, no findings).
 *     A single batch ⇒ trivially stable (nothing to compare against).
 *
 * Output:
 *   - `StabilityReport` with `stable`, per-position rollup, and findings.
 *
 * Cost: O(B × P + Σ |batch|) where B = batch count, P = unique position
 * count. Memory: O(B × P).
 */
export const analyzePrefixStability = (
  batches: ReadonlyArray<readonly CachePrefixSnapshot[]>,
): StabilityReport => {
  const totalBatches = batches.length
  if (totalBatches <= 1) {
    const positions = totalBatches === 1 ? (batches[0] ?? []) : []
    const perPosition: PositionReport[] = positions.map((s) => ({
      position: s.position,
      stable: true,
      anyMarker: s.cacheControl !== undefined,
      missingMarker: s.cacheControl === undefined,
    }))
    return {
      stable: true,
      totalBatches,
      totalPositions: perPosition.length,
      findings: [],
      perPosition,
    }
  }
  const indexed = indexByPosition(batches)
  const findings: DriftFinding[] = []
  const perPosition: PositionReport[] = []
  for (const [position, appearances] of indexed) {
    if (!isPresentInEveryBatch(appearances, totalBatches)) {
      const missing = firstMissingBatch(appearances, totalBatches)
      const firstSeen = appearances[0]?.batchIndex ?? 0
      findings.push({
        position,
        kind: "missing",
        firstIndex: firstSeen,
        secondIndex: missing,
      })
    }
    findings.push(...collectDriftFindings(position, appearances))
    perPosition.push(buildPositionReport(position, appearances, totalBatches))
  }
  return {
    stable: findings.length === 0,
    totalBatches,
    totalPositions: indexed.size,
    findings,
    perPosition,
  }
}
