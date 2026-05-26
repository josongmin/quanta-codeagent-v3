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
        "flex items-center gap-1.5 rounded border border-neutral-800 px-1.5 py-0.5",
        "font-mono text-[10px] uppercase tracking-wider text-neutral-400",
      )}
      title={renderTooltip(usage)}
    >
      <span className="text-neutral-500">tok</span>
      <span>{formatTokens(total)}</span>
      {cost > 0 ? (
        <>
          <span className="text-neutral-700">·</span>
          <span>{formatCost(cost)}</span>
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
