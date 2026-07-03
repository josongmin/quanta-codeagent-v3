/**
 * S3 — `/context` live segmented usage gauge (text form).
 *
 * The slash palette resolves client-side commands to a TEXT system message
 * (the slash channel is text-only — it appends to the transcript, it does not
 * mount JSX). This helper renders the SAME segmented context-usage data the
 * `UsageBreakdownPanel` (`UsageBar` + `usage-adapter`) draws in the pane, but as
 * a compact monospace gauge for the transcript.
 *
 * It reuses the CLI-verbatim `usage-adapter` helpers (`usagePercent`,
 * `formatTokens`) — no new heuristic — so the numbers agree with the pane's bar
 * and the CLI `/context` head line. The reasoning-token segment (the split the
 * daemon carries in `contextUsage`) is surfaced explicitly.
 *
 * `null` (channel OFF / no frame yet) ⇒ returns `null` so the caller falls back
 * to the transcript-count stub (byte-identical when the canvas channel is OFF).
 */

import { formatTokens, usagePercent } from "../adapters/usage-adapter"
import type { ContextUsageMessage } from "../types/protocol"

/** Segment ids that represent the model's reasoning tokens — surfaced as an
 *  explicit split. Matched case-insensitively so `Reasoning` / `reasoning` /
 *  `reasoning_tokens` all count. */
const isReasoningSegment = (id: string): boolean => /reason/i.test(id)

const GAUGE_WIDTH = 24

/** A proportional [====----] bar of `width` cells for `pct` (0–100). */
const asciiBar = (pct: number, width = GAUGE_WIDTH): string => {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`
}

/**
 * Render the live `/context` gauge. Returns `null` when there is no usage frame
 * (caller falls back to the stub). Otherwise a multi-line monospace readout:
 * a header bar (percent full + tokens / window), then one line per segment
 * (share %, tokens), with the reasoning split called out explicitly.
 */
export const renderContextGauge = (usage: ContextUsageMessage | null): string | null => {
  if (usage === null) return null
  const windowKnown = usage.max > 0
  const pct = usagePercent(usage.total, usage.max)
  const header = windowKnown
    ? `Context: ${pct}% full  ·  ${formatTokens(usage.total)} / ${formatTokens(usage.max)} tokens`
    : `Context: ${formatTokens(usage.total)} tokens  ·  (window unknown)`
  const bar = windowKnown ? `  ${asciiBar(pct)}` : `  ${asciiBar(0)} ?`

  // Per-segment share of the SPENT total (categories that sum the used window).
  const spent = usage.segments.reduce(
    (a, s) => a + (Number.isFinite(s.tokens) && s.tokens > 0 ? s.tokens : 0),
    0,
  )
  const share = (v: number): number => (spent > 0 ? Math.round((v / spent) * 100) : 0)

  const segLines = usage.segments.map(
    (s) => `  ${s.id.padEnd(14)} ${String(share(s.tokens)).padStart(3)}%  ${formatTokens(s.tokens)}`,
  )

  // Reasoning split — explicit call-out (RFC: "Show reasoning split"). Sum every
  // reasoning-tagged segment; omit the line when the daemon carries none.
  const reasoningTokens = usage.segments
    .filter((s) => isReasoningSegment(s.id))
    .reduce((a, s) => a + (Number.isFinite(s.tokens) && s.tokens > 0 ? s.tokens : 0), 0)
  const reasoningLine =
    reasoningTokens > 0
      ? `  reasoning:     ${String(share(reasoningTokens)).padStart(3)}%  ${formatTokens(reasoningTokens)}`
      : null

  const modelLine = usage.model !== undefined ? `  model: ${usage.model}` : null

  return [
    header,
    bar,
    ...(segLines.length > 0 ? ["", ...segLines] : []),
    ...(reasoningLine !== null ? ["", reasoningLine] : []),
    ...(modelLine !== null ? [modelLine] : []),
  ].join("\n")
}
