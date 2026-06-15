/**
 * ADR-0536 P0 — A/B run diff (PURE).
 *
 * Given two normalised `RunVerdicts` (run A = baseline, run B = candidate),
 * compute what moved: instances that B newly resolves, instances B newly
 * breaks (regressions), and the resolved delta as a percentage of the union
 * size. This is the headline signal for "did knob change X help?".
 */

import type { RunVerdicts } from "./verdicts"

export interface RunDiff {
  /** in B resolved, not in A resolved */
  readonly newlyResolved: readonly string[]
  /** in A resolved, not in B resolved (regressions) */
  readonly newlyBroken: readonly string[]
  readonly stillResolved: readonly string[]
  readonly resolvedA: number
  readonly resolvedB: number
  /** (resolvedB - resolvedA) / total * 100, rounded. `total` is the size of the
   *  union of every instance seen in either run, so the percentage is stable
   *  even when the two runs cover slightly different instance sets. */
  readonly deltaPct: number
}

const sorted = (s: Iterable<string>): string[] => [...s].sort()

/** Every instance id observed in a run, across all four verdict buckets. */
const allIds = (v: RunVerdicts): Set<string> =>
  new Set<string>([...v.resolved, ...v.unresolved, ...v.errored, ...v.emptyPatch])

export const diffRuns = (a: RunVerdicts, b: RunVerdicts): RunDiff => {
  const newlyResolved = sorted([...b.resolved].filter((id) => !a.resolved.has(id)))
  const newlyBroken = sorted([...a.resolved].filter((id) => !b.resolved.has(id)))
  const stillResolved = sorted([...a.resolved].filter((id) => b.resolved.has(id)))
  const resolvedA = a.resolved.size
  const resolvedB = b.resolved.size
  const union = new Set<string>([...allIds(a), ...allIds(b)])
  const total = union.size
  const deltaPct = total === 0 ? 0 : Math.round(((resolvedB - resolvedA) / total) * 100)
  return { newlyResolved, newlyBroken, stillResolved, resolvedA, resolvedB, deltaPct }
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)

const list = (label: string, ids: readonly string[]): string => {
  if (ids.length === 0) return `${label}: (none)`
  const lines = ids.map((id) => `  - ${id}`).join("\n")
  return `${label} (${ids.length}):\n${lines}`
}

export const renderDiff = (d: RunDiff): string =>
  [
    "=== Bench A/B diff ===",
    `resolved A: ${d.resolvedA}    resolved B: ${d.resolvedB}    delta: ${signed(
      d.resolvedB - d.resolvedA,
    )} (${signed(d.deltaPct)}%)`,
    "",
    list("newly resolved (B fixed)", d.newlyResolved),
    list("newly broken (B regressed)", d.newlyBroken),
    list("still resolved", d.stillResolved),
  ].join("\n")
