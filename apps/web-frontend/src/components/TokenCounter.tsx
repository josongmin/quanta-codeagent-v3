import type { CumulativeTokenUsage } from "../ws/session-hooks"
import { cx } from "../lib/classnames"

export interface TokenCounterProps {
  readonly usage: CumulativeTokenUsage
}

/**
 * Cumulative token / cost pill for the header. Renders nothing until the
 * backend has reported at least one `turn.completed` carrying a
 * `tokenUsage` payload, so adapters that don't surface usage yet stay
 * out of the way.
 */
export const TokenCounter = ({ usage }: TokenCounterProps): JSX.Element | null => {
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

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

const formatCost = (microUsd: number): string => {
  const usd = microUsd / 1_000_000
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

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
