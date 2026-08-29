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
import type { UsageAccountingSnapshot, UsageAggregate } from "./port"

/** One model's line in a per-model breakdown, newest-heaviest first. */
export interface ModelCostLine {
  readonly model: string
  readonly totalUsd: number
  readonly estimatedUsd: number
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
  readonly byModel: readonly ModelCostLine[]
  /** Root vs. subagent spend, so a surface can show WHERE the money went
   *  instead of only how much. */
  readonly byKind: Readonly<Record<"root" | "subagent", number>>
}

const lineOf = (model: string, a: UsageAggregate): ModelCostLine => ({
  model,
  totalUsd: a.totalUsd,
  estimatedUsd: a.estimatedUsd,
  promptTokens: a.freshInputTokens + a.cacheReadTokens,
  outputTokens: a.outputTokens,
  cacheReadTokens: a.cacheReadTokens,
  calls: a.calls,
})

/** Project a snapshot into renderable numbers. Per-model lines are ordered by
 *  spend descending, then by model name, so the ordering is stable across
 *  renders and does not jitter as a session progresses. */
export const costSurfaceView = (snap: UsageAccountingSnapshot): CostSurfaceView => ({
  totalUsd: snap.totalUsd,
  estimatedUsd: snap.estimatedUsd,
  promptTokens: snap.freshInputTokens + snap.cacheReadTokens,
  freshInputTokens: snap.freshInputTokens,
  cacheReadTokens: snap.cacheReadTokens,
  cacheWriteTokens: snap.cacheWriteTokens,
  outputTokens: snap.outputTokens,
  calls: snap.calls,
  byModel: [...snap.byModel]
    .map(([model, agg]) => lineOf(model, agg))
    .sort((a, b) => b.totalUsd - a.totalUsd || a.model.localeCompare(b.model)),
  byKind: { root: snap.byKind.root.totalUsd, subagent: snap.byKind.subagent.totalUsd },
})
