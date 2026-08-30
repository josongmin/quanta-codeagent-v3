/**
 * Snapshot → what a cost SURFACE renders (MR-04).
 *
 * Pure, surface-agnostic, and deliberately outside any app slice so the CLI
 * status line, `/cost`, the stderr dashboard, and the web sidebar all project
 * the SAME authority instead of each folding their own feed. Four
 * self-consistent surfaces that disagreed with each other is the failure this
 * exists to prevent, and the only durable fix is that there is one place where
 * a snapshot becomes numbers.
 */
import { byteCompare } from "@/shared/byte-compare"
import type { UsageAccountingSnapshot, UsageAggregate } from "./port"

/** One model's line in a per-model breakdown, newest-heaviest first. */
export interface ModelCostLine {
  readonly model: string
  readonly totalUsd: number
  readonly estimatedUsd: number
  readonly unpricedCalls: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly calls: number
}

export interface CostSurfaceView {
  readonly totalUsd: number
  /** How much of `totalUsd` came from stand-in rates. `> 0` ⇒ the surface must
   *  mark the figure as containing estimates. */
  readonly estimatedUsd: number
  /**
   * All prompt tokens the session sent, cached and fresh alike.
   *
   * This is a deliberate change in what "input" means on a surface. Providers
   * disagree about whether their reported input already contains cache reads,
   * so the old panel's input number meant different things for different
   * models and could not be summed honestly across a mixed session. The
   * canonical buckets are disjoint, so prompt = fresh + cache-read is
   * well-defined for every provider, and the cached portion stays broken out
   * below for anyone who wants the split.
   */
  readonly promptTokens: number
  readonly freshInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly calls: number
  /** Calls the totals could NOT price (no rate, no fallback). `> 0` ⇒ every
   *  dollar figure in this view is a floor; surfaces must say incomplete. */
  readonly unpricedCalls: number
  readonly byModel: readonly ModelCostLine[]
  /** Root vs. subagent spend, so a surface can show WHERE the money went
   *  instead of only how much. */
  readonly byKind: Readonly<Record<"root" | "subagent", number>>
  /** Durable state could not be restored. Current totals start after the loss
   * boundary and must never be presented as lifetime-complete. */
  readonly continuityLost: boolean
}

const lineOf = (model: string, a: UsageAggregate): ModelCostLine => ({
  model,
  totalUsd: a.totalUsd,
  estimatedUsd: a.estimatedUsd,
  unpricedCalls: a.unpricedCalls,
  promptTokens: a.freshInputTokens + a.cacheReadTokens,
  outputTokens: a.outputTokens,
  cacheReadTokens: a.cacheReadTokens,
  calls: a.calls,
})

/** Project a snapshot into renderable numbers. Per-model lines are ordered by
 *  spend descending, then by model name, so the ordering is stable across
 *  renders and does not jitter as a session progresses.
 *
 *  The name tiebreak is a BYTE compare, not `localeCompare`: locale/ICU
 *  collation varies by machine, which would make the rendered order — and any
 *  replay of it — machine-dependent. */
export const costSurfaceView = (snap: UsageAccountingSnapshot): CostSurfaceView => ({
  totalUsd: snap.totalUsd,
  estimatedUsd: snap.estimatedUsd,
  unpricedCalls: snap.unpricedCalls,
  promptTokens: snap.freshInputTokens + snap.cacheReadTokens,
  freshInputTokens: snap.freshInputTokens,
  cacheReadTokens: snap.cacheReadTokens,
  cacheWriteTokens: snap.cacheWriteTokens,
  outputTokens: snap.outputTokens,
  calls: snap.calls,
  byModel: [...snap.byModel]
    .map(([model, agg]) => lineOf(model, agg))
    .sort((a, b) => b.totalUsd - a.totalUsd || byteCompare(a.model, b.model)),
  byKind: { root: snap.byKind.root.totalUsd, subagent: snap.byKind.subagent.totalUsd },
  continuityLost: snap.continuityLost,
})

/**
 * A7 — the flat wire shape of a cumulative view (structurally identical to the
 * protocol's `CostSurfaceViewWire`, produced HERE so the host adapter and the
 * web daemon share ONE mapping instead of each hand-building the literal).
 */
export interface CostSurfaceOffWireShape {
  readonly status: "off"
}

export interface CostSurfaceOnWireShape {
  readonly status: "on"
  readonly totalUsd: number
  readonly estimatedUsd: number
  readonly unpricedCalls: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly calls: number
  readonly rootUsd: number
  readonly subagentUsd: number
  readonly continuityLost: boolean
  readonly modelSlug?: string
}

export type CostSurfaceViewWireShape = CostSurfaceOffWireShape | CostSurfaceOnWireShape

/** Explicit accounting-off state. Field absence is reserved for old daemons
 * that predate the cumulative cost wire. */
export const costAccountingOffWire = (): CostSurfaceOffWireShape => ({ status: "off" })

/** Project an authority into the flat cumulative wire shape. */
export const costSurfaceViewWire = (port: {
  snapshot(): UsageAccountingSnapshot
  recent(limit?: number): readonly { readonly usage: { readonly model: string } }[]
}): CostSurfaceViewWireShape => {
  const view = costSurfaceView(port.snapshot())
  const modelSlug = port.recent(1)[0]?.usage.model
  return {
    status: "on",
    totalUsd: view.totalUsd,
    estimatedUsd: view.estimatedUsd,
    unpricedCalls: view.unpricedCalls,
    promptTokens: view.promptTokens,
    outputTokens: view.outputTokens,
    cacheReadTokens: view.cacheReadTokens,
    cacheWriteTokens: view.cacheWriteTokens,
    calls: view.calls,
    rootUsd: view.byKind.root,
    subagentUsd: view.byKind.subagent,
    continuityLost: view.continuityLost,
    ...(modelSlug !== undefined ? { modelSlug } : {}),
  }
}
