/**
 * ADR-0448 (RFC-10) — category → hue mapping + breakdown → UsageBar adapter.
 *
 * Pure (no React, no WS). Maps each `ContextCategory` (System/Tools/Rules/
 * Skills/MCP/Subagents/Conversation) to one of the 7 shared `tokens.ts`
 * palette hues. The mapping is NOT invented — it is the canonical example
 * baked into Cursor `usage-bar.d.ts:44-50` (System=gray, Tools=purple,
 * Rules=green, Skills=yellow, MCP=pink, Subagents=blue, Conversation=orange).
 * Our `CATEGORY_ORDER` (usage-breakdown.ts:51) uses the same category names, so
 * the mapping is 1:1 ([[no-heuristics-only-validated]]).
 *
 * `breakdownToUsageBarProps` converts the daemon's `ContextUsageMessage`
 * (RFC-06's data port) into RFC-06's `UsageBar` props — re-using the verbatim
 * CLI percent/format helpers from the RFC-06 `usage-adapter.ts` (no new
 * heuristic). The difference from RFC-06's own adapter: this one assigns each
 * segment its CATEGORY hue (so the Swatch legend stays color-coherent) instead
 * of leaving color unset for index rotation.
 */

import { formatTokens, usagePercent } from "../../adapters/usage-adapter"
import type { ContextUsageMessage } from "../../types/protocol"
import { colorPalette, type PaletteColor, usageColorSequence } from "./tokens"
import type { UsageBarProps, UsageBarSegment } from "./UsageBar"

/** Canonical category → palette-hue map (Cursor `usage-bar.d.ts:44-50`). */
export const CATEGORY_TO_HUE: Readonly<Record<string, PaletteColor>> = {
  System: "gray",
  Tools: "purple",
  Rules: "green",
  Skills: "yellow",
  MCP: "pink",
  Subagents: "blue",
  Conversation: "orange",
}

/**
 * Resolve a segment id to its palette hue. Known categories ⇒ canonical hue;
 * unknown ids ⇒ rotate through `usageColorSequence` by index (RFC-06's own
 * fallback, so a stray category never crashes and stays visually distinct).
 */
export const hueForCategory = (id: string, index: number): string => {
  const named = CATEGORY_TO_HUE[id]
  if (named !== undefined) return colorPalette[named]
  const seq = usageColorSequence
  return seq[index % seq.length] ?? colorPalette.gray
}

/** Clamp a token count: non-finite / negative ⇒ 0 (Cursor contract, mirrors
 *  RFC-06 `usage-adapter.ts#clampValue`). */
const clampTokens = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Convert a `ContextUsageMessage` → RFC-06 `UsageBarProps`, assigning each
 * segment its category hue. Labels reproduce the CLI `formatSegmentedUsage`
 * head-line meaning verbatim (`64% Full`, `76.8k / 120k Tokens`) via the
 * RFC-06 helpers.
 *
 * `max <= 0` (unknown window) ⇒ INDETERMINATE (UUX-4-25): the bar means "how
 * full is the window" and that ratio is unknowable, so it renders NO fill (an
 * empty track — the pre-fix shape filled against `total`, i.e. a 100%-full
 * bar + "? Full": a false context-exhausted alarm). Labels degrade honestly
 * to "Window unknown" + the used-token count — the same posture as the
 * `/context` text gauge (`asciiBar(0)` + "(window unknown)"). The per-category
 * legend beneath the bar still shows the breakdown (it keys off
 * `usage.segments`, not these bar props).
 */
export const breakdownToUsageBarProps = (msg: ContextUsageMessage): UsageBarProps => {
  const windowKnown = msg.max > 0
  if (!windowKnown) {
    return {
      // No fill at all; total=1 keeps the UsageBar remainder painting the
      // empty track (total<=0 would render a zero-width nothing).
      segments: [],
      total: 1,
      topLeftLabel: "Window unknown",
      topRightLabel: `${formatTokens(msg.total)} Tokens used`,
    }
  }
  const segments: UsageBarSegment[] = msg.segments.map((s, idx) => ({
    id: s.id,
    value: clampTokens(s.tokens),
    color: hueForCategory(s.id, idx),
  }))
  return {
    segments,
    total: msg.max,
    topLeftLabel: `${usagePercent(msg.total, msg.max)}% Full`,
    topRightLabel: `${formatTokens(msg.total)} / ${formatTokens(msg.max)} Tokens`,
  }
}
