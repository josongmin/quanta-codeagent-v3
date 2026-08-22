/**
 * Live progress UX + cost accumulator for `tools/swebench-matrix.ts`.
 *
 * All functions here are PURE — they take the running totals and produce
 * a render string. The runner owns the side effect (writing to stderr,
 * persisting `.cost.json`). This split keeps the unit tests trivial: we
 * call the formatter with a fixed input and assert the exact output.
 *
 * No heuristic ETAs: the only signal we use is the arithmetic mean of
 * already-observed instance wall times. We surface "n/a" until at least
 * ONE instance has finished — never invent an estimate from nothing.
 */
import type { MatrixRow } from "../swebench-matrix"

/**
 * One-line instance verdict — printed AFTER each pick finishes.
 *
 * Example:
 *   [3/10] sympy__sympy-13480 PASS (turns=11, 12.3s)
 *
 * Verdict markers (ASCII only — we keep this safe for grep / `tee` pipes
 * and never depend on a TTY):
 *   - pass     ⇒ "PASS"
 *   - fail     ⇒ "FAIL"
 *   - degraded ⇒ "SKIP"
 *   - error    ⇒ "ERR "
 */
export const formatInstanceLine = (
  index: number,
  total: number,
  row: Pick<MatrixRow, "pickId" | "verdict" | "turns" | "wallMs">,
): string => {
  const tag = verdictTag(row.verdict)
  const wallS = (row.wallMs / 1000).toFixed(1)
  return `[${index}/${total}] ${row.pickId} ${tag} (turns=${row.turns}, ${wallS}s)`
}

const verdictTag = (v: MatrixRow["verdict"]): string => {
  if (v === "pass") return "PASS"
  if (v === "fail") return "FAIL"
  if (v === "degraded") return "SKIP"
  return "ERR "
}

/**
 * Render the per-condition progress bar. The bar is fixed-width (10 cells)
 * and ASCII (`#` filled, `-` empty). This avoids ANSI / Unicode width
 * surprises in operator terminals.
 *
 * Example output:
 *   [2/4 conditions] [#####-----] 50% | $1.2000 / ~$3.0000 est | ETA ~1h 12m
 *
 * When `spentUsd` / `estUsd` / `etaMs` are unknown we render `n/a` for
 * that segment instead of fabricating a value.
 */
export const formatProgressBar = (input: {
  readonly completed: number
  readonly total: number
  readonly spentUsd?: number
  readonly estUsd?: number
  readonly etaMs?: number
}): string => {
  const pct = input.total === 0 ? 0 : Math.round((input.completed / input.total) * 100)
  const cells = 10
  const filled = input.total === 0 ? 0 : Math.round((input.completed / input.total) * cells)
  const bar = `[${"#".repeat(filled)}${"-".repeat(cells - filled)}]`
  const cost = formatCostSegment(input.spentUsd, input.estUsd)
  const eta = `ETA ${formatEta(input.etaMs)}`
  return `[${input.completed}/${input.total} conditions] ${bar} ${pct}% | ${cost} | ${eta}`
}

const formatCostSegment = (spent: number | undefined, est: number | undefined): string => {
  const spentStr = spent === undefined ? "n/a" : `$${spent.toFixed(4)}`
  const estStr = est === undefined ? "n/a" : `~$${est.toFixed(4)} est`
  return `${spentStr} / ${estStr}`
}

/** Render an ETA in compact `Hh MMm` form. Falls back to `n/a` when the
 *  estimator returns undefined (no instances observed yet). */
export const formatEta = (ms: number | undefined): string => {
  if (ms === undefined) return "n/a"
  if (!Number.isFinite(ms) || ms < 0) return "n/a"
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `~${m}m`
  return `~${h}h ${m.toString().padStart(2, "0")}m`
}

/**
 * Estimate remaining wall time = mean(observed) × remaining count.
 *
 *  - `observedWallMs` — wall time for EVERY instance that has finished.
 *    We use the arithmetic mean; no decay / EWMA (those are heuristics
 *    that would require tuning under our own no-heuristics policy).
 *  - `remainingCount` — number of instances still to run.
 *  - Returns `undefined` when there is no observation yet — the operator
 *    sees "n/a" until the FIRST instance finishes.
 */
export const estimateEtaMs = (
  observedWallMs: readonly number[],
  remainingCount: number,
): number | undefined => {
  if (observedWallMs.length === 0) return undefined
  if (remainingCount <= 0) return 0
  let sum = 0
  for (const m of observedWallMs) sum += m
  const mean = sum / observedWallMs.length
  return Math.round(mean * remainingCount)
}

/**
 * Accumulator state. Pass through a sequence of `recordInstance` calls
 * (after each pick finishes) and read `spentUsd` / `observed` at any time.
 *
 * Note: we treat `degraded` rows as 0-wall observations (they did not
 * actually run an LLM turn worth measuring) and `error` rows as
 * observations too (the cost was paid even on error). This matches the
 * "fail-to-deliver counts in denominator" rule used by `aggregate`.
 */
export interface CostAccumulator {
  readonly observedWallMs: readonly number[]
  readonly spentUsd: number
  readonly instanceCount: number
}

export const emptyCostAccumulator = (): CostAccumulator => ({
  observedWallMs: [],
  spentUsd: 0,
  instanceCount: 0,
})

export const recordInstance = (
  acc: CostAccumulator,
  row: Pick<MatrixRow, "verdict" | "wallMs" | "costUsd">,
): CostAccumulator => {
  // `degraded` rows are not real observations — skip the wall sample but
  // still attribute their cost (which is 0 from the bench's POV).
  const isObs = row.verdict !== "degraded"
  const nextWalls: number[] = isObs ? [...acc.observedWallMs, row.wallMs] : [...acc.observedWallMs]
  return {
    observedWallMs: nextWalls,
    spentUsd: round4(acc.spentUsd + (row.costUsd ?? 0)),
    instanceCount: acc.instanceCount + 1,
  }
}

/** Bulk record — when resuming we replay every persisted row through the
 *  accumulator so subsequent ETA estimates remain accurate. Pure. */
export const recordRows = (
  acc: CostAccumulator,
  rows: readonly Pick<MatrixRow, "verdict" | "wallMs" | "costUsd">[],
): CostAccumulator => {
  let cur = acc
  for (const r of rows) cur = recordInstance(cur, r)
  return cur
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/**
 * Cost-tracker payload persisted to `<outDir>/.cost.json` after each
 * condition completes. The runner is the writer; this module just shapes
 * the value. Forward-compat: a `version` field so future fields can be
 * added without breaking older readers.
 */
export interface CostFile {
  readonly version: 1
  readonly spentUsd: number
  readonly estUsd?: number
  readonly model: string
  readonly updatedAt: number
  readonly instancesObserved: number
}

export const buildCostFile = (input: {
  readonly acc: CostAccumulator
  readonly model: string
  readonly estUsd?: number
  readonly now?: () => number
}): CostFile => {
  const base: CostFile = {
    version: 1,
    spentUsd: input.acc.spentUsd,
    model: input.model,
    updatedAt: input.now?.() ?? Date.now(),
    instancesObserved: input.acc.instanceCount,
  }
  return input.estUsd !== undefined ? { ...base, estUsd: input.estUsd } : base
}
