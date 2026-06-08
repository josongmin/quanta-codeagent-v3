/**
 * ADR-0440 — UsageBar (render-side). Mirrors Cursor `cursor/canvas`
 * `UsageBarProps` 1:1, with `className` substituted for `style`.
 *
 * Renders proportional segments + a remainder span + top-left / top-right
 * labels. Each segment width = `value / total` (clamped). Remainder =
 * `max(0, total - Σvalue)`. Colors come from `tokens.ts`
 * (`usageColorSequence` auto-rotation when a segment omits its color) — no
 * hardcoded hex. Accessibility: `role="img"` with a summary `aria-label`;
 * each segment carries a `title` (id + tokens + %).
 *
 * Edge cases: `total <= 0` ⇒ no NaN (remainder fills 100%); non-finite /
 * negative segment values ⇒ 0.
 */

import type { ReactNode } from "react"
import { cx } from "../../lib/classnames"
import { usageColorSequence, usageRemainderColor } from "./tokens"

export interface UsageBarSegment {
  readonly id: string
  readonly value: number
  readonly color?: string
}

export interface UsageBarProps {
  readonly segments: readonly UsageBarSegment[]
  readonly total: number
  readonly topLeftLabel?: ReactNode
  readonly topRightLabel?: ReactNode
  readonly className?: string
}

const clampValue = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

const pctOf = (value: number, total: number): number => {
  if (!(total > 0)) return 0
  return Math.min(100, (value / total) * 100)
}

export const UsageBar = ({
  segments,
  total,
  topLeftLabel,
  topRightLabel,
  className,
}: UsageBarProps): JSX.Element => {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0
  const values = segments.map((s) => clampValue(s.value))
  const used = values.reduce((a, b) => a + b, 0)
  const remainder = Math.max(0, safeTotal - used)
  const ariaSummary =
    typeof topLeftLabel === "string" && typeof topRightLabel === "string"
      ? `context usage: ${topLeftLabel}, ${topRightLabel}`
      : "context usage"

  return (
    <div className={cx("w-full", className)}>
      {(topLeftLabel !== undefined || topRightLabel !== undefined) && (
        <div className="mb-1 flex items-center justify-between text-xs text-ink-secondary">
          <span>{topLeftLabel}</span>
          <span className="tabular-nums">{topRightLabel}</span>
        </div>
      )}
      <div
        role="img"
        aria-label={ariaSummary}
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-raised"
      >
        {segments.map((seg, idx) => {
          const value = values[idx] ?? 0
          if (value <= 0) return null
          const color = seg.color ?? usageColorSequence[idx % usageColorSequence.length]
          const pct = pctOf(value, safeTotal)
          return (
            <span
              key={seg.id}
              title={`${seg.id}: ${value} (${Math.round(pct)}%)`}
              className="h-full"
              style={{ width: `${pct}%`, background: color }}
            />
          )
        })}
        {remainder > 0 ? (
          <span
            aria-hidden="true"
            title={`unused: ${remainder}`}
            className="h-full"
            style={{ width: `${pctOf(remainder, safeTotal)}%`, background: usageRemainderColor }}
          />
        ) : null}
      </div>
    </div>
  )
}
