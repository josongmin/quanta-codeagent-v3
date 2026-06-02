/**
 * ADR-0440 — lossless usage adapter (frontend side).
 *
 * Converts the daemon's `ContextUsageMessage` (a verbatim serialization of the
 * CLI `SegmentedUsageView`) into Cursor `UsageBarProps`. The percent / token
 * formatting helpers are COPIED VERBATIM from the CLI `status-line.ts`
 * (`viewPercent`, `formatTokens`) — no new heuristic is introduced; the bar the
 * web renders is the same math the CLI `/context` head line renders.
 *
 * Mirrors Cursor `UsageBarProps`:
 *   { segments: { id, value, color? }[], total, topLeftLabel, topRightLabel }
 *
 * `total` is the FULL window (`max`) so the bar's remainder span = the unused
 * window — exactly how the CLI segmented bar allocates cells against `max`.
 */

import type { ContextUsageMessage } from "../types/protocol"

/** Cursor `UsageBarSegment`. `value` non-finite/<=0 ⇒ 0 (clamped here). */
export interface UsageBarSegment {
  readonly id: string
  readonly value: number
  readonly color?: string
}

export interface UsageBarProps {
  readonly segments: readonly UsageBarSegment[]
  readonly total: number
  readonly topLeftLabel?: string
  readonly topRightLabel?: string
  readonly className?: string
}

/* --- CLI-verbatim helpers (status-line.ts) ---------------------------- */

/**
 * Format a token count: `523`, `50.0k`, `200k`. COPIED from
 * `status-line.ts#formatTokens` (single source of truth — DO NOT diverge).
 */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(Math.max(0, Math.trunc(n)))
  const k = n / 1000
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
}

/**
 * Percentage (0–100, rounded) of the window consumed. COPIED from
 * `status-line.ts#viewPercent` — never NaN, clamps to 100, `max<=0 ⇒ 0`.
 */
export const usagePercent = (total: number, max: number): number => {
  if (!(max > 0)) return 0
  return Math.min(100, Math.round((total / max) * 100))
}

/** Clamp a segment value: non-finite / negative ⇒ 0 (Cursor contract). */
const clampValue = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

/* --- Adapter ---------------------------------------------------------- */

/**
 * Convert a `ContextUsageMessage` → `UsageBarProps`. Lossless: segment ids +
 * values are preserved (values clamped per Cursor contract); labels reproduce
 * the CLI `formatSegmentedUsage` head-line meaning (`64% Full`,
 * `76.8k / 120k Tokens`). Colors are left unset so the UsageBar auto-rotates
 * the `usageColorSequence` (keeps web/CLI category order consistent).
 */
export const usageMessageToBarProps = (msg: ContextUsageMessage): UsageBarProps => {
  // The bar fills against the FULL window; `total` here = the window size so the
  // remainder span renders the unused budget (matches the CLI bar).
  const windowSize = msg.max > 0 ? msg.max : msg.total
  const pct = usagePercent(msg.total, msg.max)
  return {
    segments: msg.segments.map((s) => ({ id: s.id, value: clampValue(s.tokens) })),
    total: windowSize,
    topLeftLabel: `${pct}% Full`,
    topRightLabel: `${formatTokens(msg.total)} / ${formatTokens(msg.max)} Tokens`,
  }
}
