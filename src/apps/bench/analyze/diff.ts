/**
 * ADR-0536 P0 — A/B run diff (PURE).
 *
 * Given two normalised `RunVerdicts` (run A = baseline, run B = candidate),
 * compute what moved: instances that B newly resolves, instances B newly
 * breaks (regressions), and the resolved delta as a percentage of the union
 * size. This is the headline signal for "did knob change X help?".
 */

import type { RunReportCount, RunVerdicts } from "./verdicts"

export interface RunDiff {
  /** in B resolved, not in A resolved */
  readonly newlyResolved: readonly string[]
  /** Resolved in A, genuinely unresolved-WITH-a-patch in B (real regression).
   *  Excludes instances B merely failed to measure (errored / empty-patch). */
  readonly newlyBroken: readonly string[]
  /** Resolved in A but NOT genuinely re-graded in B — B errored/throttled or
   *  emitted an empty patch. These are measurement gaps, NOT regressions, and
   *  must never be counted as "knob X broke instance Y". */
  readonly bUnmeasured: readonly string[]
  readonly stillResolved: readonly string[]
  readonly resolvedA: number
  readonly resolvedB: number
  /** (resolvedB - resolvedA) / total * 100, rounded. `total` is the size of the
   *  union of every instance seen in either run, so the percentage is stable
   *  even when the two runs cover slightly different instance sets. */
  readonly deltaPct: number
  /** Bench-report-only aggregate telemetry. Omitted when neither side had the
   *  richer report shape. Keeps v3/v4 authority and packet-coverage differences
   *  explicit in A/B readouts instead of collapsing them to resolved deltas. */
  readonly reportTotals?: RunReportTotalsDiff
}

export interface RunReportTotalsDiff {
  readonly submittedWithProof: CountDiff
  readonly blockedProofMissing: CountDiff
  readonly blockedEnvFailed: CountDiff
  readonly contractOnlyBlocked: CountDiff
  readonly contractOnlySubmitted: CountDiff
  readonly packetizedGenerationCount: CountDiff
  readonly packetizedRepairCount: CountDiff
  readonly packetizedSelectionExplanationCount: CountDiff
}

export interface CountDiff {
  readonly a: RunReportCount
  readonly b: RunReportCount
  readonly delta: number | null
}

const sorted = (s: Iterable<string>): string[] => [...s].sort()
const countDiff = (a: RunReportCount | undefined, b: RunReportCount | undefined): CountDiff => {
  const left = a ?? null
  const right = b ?? null
  return {
    a: left,
    b: right,
    delta: left === null || right === null ? null : right - left,
  }
}

/** Every instance id observed in a run, across all verdict buckets. */
const allIds = (v: RunVerdicts): Set<string> =>
  new Set<string>([
    ...v.resolved,
    ...v.localStructural,
    ...v.researchContaminated,
    ...(v.proofMissing ?? []),
    ...(v.infraBlocked ?? []),
    ...(v.contractOnlyBlocked ?? []),
    ...(v.contractOnlySubmitted ?? []),
    ...v.unresolved,
    ...v.errored,
    ...v.emptyPatch,
  ])

export const diffRuns = (a: RunVerdicts, b: RunVerdicts): RunDiff => {
  // B "did not measure" an instance when it errored (throttle/harness/timeout)
  // or emitted an empty patch — that is a measurement gap, not a regression.
  const bUnmeasuredSet = new Set<string>([...b.errored, ...b.emptyPatch])
  const newlyResolved = sorted([...b.resolved].filter((id) => !a.resolved.has(id)))
  const droppedFromResolved = [...a.resolved].filter((id) => !b.resolved.has(id))
  const newlyBroken = sorted(droppedFromResolved.filter((id) => !bUnmeasuredSet.has(id)))
  const bUnmeasured = sorted(droppedFromResolved.filter((id) => bUnmeasuredSet.has(id)))
  const stillResolved = sorted([...a.resolved].filter((id) => b.resolved.has(id)))
  const resolvedA = a.resolved.size
  const resolvedB = b.resolved.size
  const union = new Set<string>([...allIds(a), ...allIds(b)])
  const total = union.size
  const deltaPct = total === 0 ? 0 : Math.round(((resolvedB - resolvedA) / total) * 100)
  const reportTotals =
    a.reportTotals === undefined && b.reportTotals === undefined
      ? undefined
      : {
          submittedWithProof: countDiff(
            a.reportTotals?.submittedWithProof,
            b.reportTotals?.submittedWithProof,
          ),
          blockedProofMissing: countDiff(
            a.reportTotals?.blockedProofMissing,
            b.reportTotals?.blockedProofMissing,
          ),
          blockedEnvFailed: countDiff(
            a.reportTotals?.blockedEnvFailed,
            b.reportTotals?.blockedEnvFailed,
          ),
          contractOnlyBlocked: countDiff(
            a.reportTotals?.contractOnlyBlocked,
            b.reportTotals?.contractOnlyBlocked,
          ),
          contractOnlySubmitted: countDiff(
            a.reportTotals?.contractOnlySubmitted,
            b.reportTotals?.contractOnlySubmitted,
          ),
          packetizedGenerationCount: countDiff(
            a.reportTotals?.packetizedGenerationCount,
            b.reportTotals?.packetizedGenerationCount,
          ),
          packetizedRepairCount: countDiff(
            a.reportTotals?.packetizedRepairCount,
            b.reportTotals?.packetizedRepairCount,
          ),
          packetizedSelectionExplanationCount: countDiff(
            a.reportTotals?.packetizedSelectionExplanationCount,
            b.reportTotals?.packetizedSelectionExplanationCount,
          ),
        }
  return {
    newlyResolved,
    newlyBroken,
    bUnmeasured,
    stillResolved,
    resolvedA,
    resolvedB,
    deltaPct,
    ...(reportTotals !== undefined ? { reportTotals } : {}),
  }
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)

const list = (label: string, ids: readonly string[]): string => {
  if (ids.length === 0) return `${label}: (none)`
  const lines = ids.map((id) => `  - ${id}`).join("\n")
  return `${label} (${ids.length}):\n${lines}`
}

const countText = (n: RunReportCount): string => (n === null ? "unknown" : `${n}`)
const telemetryLine = (label: string, diff: CountDiff): string =>
  `  ${label}: A=${countText(diff.a)}  B=${countText(diff.b)}  delta=${
    diff.delta === null ? "unknown" : signed(diff.delta)
  }`

export const renderDiff = (d: RunDiff): string =>
  [
    "=== Bench A/B diff ===",
    `resolved A: ${d.resolvedA}    resolved B: ${d.resolvedB}    delta: ${signed(
      d.resolvedB - d.resolvedA,
    )} (${signed(d.deltaPct)}%)`,
    "",
    list("newly resolved (B fixed)", d.newlyResolved),
    list("newly broken (B regressed)", d.newlyBroken),
    list("unmeasured in B (errored/empty-patch — NOT a regression)", d.bUnmeasured),
    list("still resolved", d.stillResolved),
    ...(d.reportTotals === undefined
      ? []
      : [
          "",
          "authority/proof telemetry:",
          telemetryLine("submittedWithProof", d.reportTotals.submittedWithProof),
          telemetryLine("blockedProofMissing", d.reportTotals.blockedProofMissing),
          telemetryLine("blockedEnvFailed", d.reportTotals.blockedEnvFailed),
          telemetryLine("contractOnlyBlocked", d.reportTotals.contractOnlyBlocked),
          telemetryLine("contractOnlySubmitted", d.reportTotals.contractOnlySubmitted),
          "",
          "packet coverage:",
          telemetryLine("packetizedGenerationCount", d.reportTotals.packetizedGenerationCount),
          telemetryLine("packetizedRepairCount", d.reportTotals.packetizedRepairCount),
          telemetryLine(
            "packetizedSelectionExplanationCount",
            d.reportTotals.packetizedSelectionExplanationCount,
          ),
        ]),
  ].join("\n")
