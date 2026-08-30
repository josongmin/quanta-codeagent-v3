import { cx } from "../lib/classnames"
import type { CostSurfaceViewWire } from "../types/protocol.session.generated"
import type { CumulativeTokenUsage } from "../ws/session-hooks"

export interface TokenCounterProps {
  readonly usage: CumulativeTokenUsage
  /** A7 — the server's cumulative cost SNAPSHOT (replace-semantics). When
   *  present it is the source of truth and the additive fold is ignored;
   *  `null` keeps the legacy pill for old daemons; modern daemons send an
   *  explicit `status:"off"` state when accounting is disabled. */
  readonly costView?: CostSurfaceViewWire | null
}

/**
 * Cumulative token / cost pill for the header.
 *
 * Snapshot-aware (A7): with a `costView` the pill renders the authority's
 * numbers — total, an "~est" marker when part of the figure is a stand-in
 * estimate, an "N unpriced" marker when the totals are a floor, and the
 * subagent share in the tooltip. Without one it falls back to the legacy
 * additive fold and renders exactly as before.
 */
export const TokenCounter = ({ usage, costView }: TokenCounterProps): JSX.Element | null => {
  if (costView !== null && costView !== undefined) {
    return renderAccountingView(costView)
  }
  if (usage.turns === 0) return null
  const total = usage.totalTokens
  const cost = usage.costMicroUsd
  return (
    <div
      className={cx(
        "flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5",
        "text-xs text-ink-secondary",
      )}
      title={renderTooltip(usage)}
    >
      <span className="text-ink-tertiary">tok</span>
      <span className="font-mono">{formatTokens(total)}</span>
      {cost > 0 ? (
        <>
          <span className="text-ink-tertiary">·</span>
          <span className="font-mono">{formatCost(cost)}</span>
        </>
      ) : null}
    </div>
  )
}

const renderAccountingView = (view: CostSurfaceViewWire): JSX.Element | null => {
  if (view.status === "off") {
    return (
      <div
        className={cx(
          "flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5",
          "text-xs text-ink-secondary",
        )}
        title="Usage accounting is disabled for this session."
      >
        <span className="text-ink-tertiary">cost</span>
        <span className="font-mono">off</span>
      </div>
    )
  }
  if (view.calls === 0) return null
  const totalTok = view.promptTokens + view.outputTokens
  const costLabel =
    view.unpricedCalls > 0 && view.totalUsd === 0 ? "cost incomplete" : formatUsd(view.totalUsd)
  return (
    <div
      className={cx(
        "flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5",
        "text-xs text-ink-secondary",
      )}
      title={renderViewTooltip(view)}
    >
      <span className="text-ink-tertiary">tok</span>
      <span className="font-mono">{formatTokens(totalTok)}</span>
      <span className="text-ink-tertiary">·</span>
      <span className="font-mono">{costLabel}</span>
      {view.estimatedUsd > 0 ? <span className="text-ink-tertiary">~est</span> : null}
      {view.unpricedCalls > 0 && view.totalUsd > 0 ? (
        <span className="text-ink-tertiary">+{view.unpricedCalls} unpriced</span>
      ) : null}
      {view.continuityLost ? <span className="text-ink-tertiary">partial history</span> : null}
    </div>
  )
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

const formatUsd = (usd: number): string => {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

const formatCost = (microUsd: number): string => formatUsd(microUsd / 1_000_000)

const renderViewTooltip = (v: Extract<CostSurfaceViewWire, { status: "on" }>): string =>
  [
    `calls: ${v.calls}`,
    `prompt: ${v.promptTokens}`,
    `output: ${v.outputTokens}`,
    `cache read: ${v.cacheReadTokens}`,
    v.cacheWriteTokens > 0 ? `cache write: ${v.cacheWriteTokens}` : null,
    `total: ${formatUsd(v.totalUsd)}`,
    v.estimatedUsd > 0 ? `estimated: ${formatUsd(v.estimatedUsd)}` : null,
    v.unpricedCalls > 0 ? `unpriced calls: ${v.unpricedCalls}` : null,
    v.continuityLost ? "continuity: prior totals lost; current total is partial" : null,
    v.subagentUsd > 0
      ? `root ${formatUsd(v.rootUsd)} · subagents ${formatUsd(v.subagentUsd)}`
      : null,
    v.modelSlug !== undefined ? `model: ${v.modelSlug}` : null,
  ]
    .filter((s) => s !== null)
    .join("\n")

const renderTooltip = (u: CumulativeTokenUsage): string =>
  [
    `turns: ${u.turns}`,
    `prompt: ${u.promptTokens}`,
    `completion: ${u.completionTokens}`,
    `total: ${u.totalTokens}`,
    u.costMicroUsd > 0 ? `cost: ${formatCost(u.costMicroUsd)}` : null,
  ]
    .filter((s) => s !== null)
    .join("\n")
