/**
 * RFC-09 (B) — pre-compaction / context-window warning. A pure, read-only
 * predicate that surfaces a ONE-LINE warning near the prompt BEFORE auto-
 * compaction silently fires.
 *
 * CRITICAL invariant: B introduces NO new token heuristic. It consumes the
 * SAME per-turn token count the status-line / `/context` already compute — the
 * `ContextUsageHolder.view()` snapshot, whose `.total`/`.max` come from the
 * agent loop's OWN `estimateTokens` (via `buildUsageBreakdownDefault`). The
 * `compactThreshold` is supplied by the composition root from the SAME source
 * compaction uses (`runtimeConfig().compactTokens ?? 120_000`). This module only
 * does arithmetic + string formatting on those given numbers.
 *
 * Why NOT reuse the existing pre-compact hooks (`preCompactHook` /
 * `onPreCompact`): those fire AFTER the threshold is crossed and compaction has
 * already been decided — too late for B, whose entire purpose is to warn BEFORE
 * compaction so the user can choose (`/summarize-now`, `/rewind`, or continue).
 * So B computes a forward-looking ratio at prompt time from the retained count
 * and leaves both hooks untouched (orthogonal).
 *
 * Slice fence: surface-only — consumes the structural {@link ContextWarningView}
 * (plain numbers), no `@/agent` import. The holder already did the conversion.
 */

import { slashRef } from "./slash-ref"
import type { SegmentedUsageView } from "./status-line"

/** The numbers B reads — all from the SAME source the agent loop uses. */
export interface ContextWarningView {
  /** `holder.view().total` (agent-loop `estimateTokens`). */
  readonly usedTokens: number
  /** `holder.view().max` (model context window). */
  readonly max: number
  /** `resolveThreshold` equivalent = `runtimeConfig().compactTokens ?? 120_000`,
   *  supplied by the composition root (NOT recomputed here). */
  readonly compactThreshold: number
}

export interface ContextWarningOpts {
  /** Warn ratio against the CONTEXT WINDOW (`usedTokens/max`). Default 0.8. */
  readonly windowWarnRatio?: number
  /** Warn ratio against the COMPACTION THRESHOLD (`usedTokens/compactThreshold`).
   *  Default 0.9 (compaction is imminent ⇒ a tighter, more urgent ratio). */
  readonly compactWarnRatio?: number
}

const DEFAULT_WINDOW_WARN_RATIO = 0.8
const DEFAULT_COMPACT_WARN_RATIO = 0.9

/** Map a retained {@link SegmentedUsageView} (`holder.view()`) + the resolved
 *  compaction threshold into a {@link ContextWarningView}. `undefined` in ⇒
 *  `undefined` out (no snapshot yet ⇒ no warning). Pure. */
export const toWarningView = (
  view: SegmentedUsageView | undefined,
  compactThreshold: number,
): ContextWarningView | undefined => {
  if (view === undefined) return undefined
  return { usedTokens: view.total, max: view.max, compactThreshold }
}

/**
 * Render the one-line warning, or `""` when no warning is due. Pure. Never
 * throws, never returns NaN/Infinity text:
 *   - `v === undefined` (no snapshot yet) ⇒ `""`.
 *   - `max <= 0` (unknown window) ⇒ `""` (no division).
 *   - below BOTH ratios ⇒ `""`.
 *   - at/over the compaction ratio ⇒ compaction-first message ("곧 자동 요약").
 *   - else at/over the window ratio ⇒ window-fullness message.
 *
 * Both branches advise `/summarize-now` (manual mid-turn summarization — the
 * command that actually EXISTS; UUX-5-01 shipped a `/compact` ghost here) AND
 * `esc esc(/rewind)` — the Claude "Press esc twice" affordance mapped to
 * quanta's `/rewind`. Command names render via `slashRef` so a ghost
 * reference is structurally RED (slash-ref hellgate).
 */
export const renderContextWarning = (
  v: ContextWarningView | undefined,
  opts: ContextWarningOpts = {},
): string => {
  if (v === undefined || !(v.max > 0)) return ""
  const winPct = Math.round((v.usedTokens / v.max) * 100)
  const compactPct =
    v.compactThreshold > 0 ? Math.round((v.usedTokens / v.compactThreshold) * 100) : 0
  const winWarn = winPct >= (opts.windowWarnRatio ?? DEFAULT_WINDOW_WARN_RATIO) * 100
  const compactWarn = compactPct >= (opts.compactWarnRatio ?? DEFAULT_COMPACT_WARN_RATIO) * 100
  if (!winWarn && !compactWarn) return ""
  const head = compactWarn
    ? `context ${compactPct}% of compaction limit — 곧 자동 요약됩니다`
    : `context ${winPct}% — 윈도우가 차고 있습니다`
  return `⚠ ${head} · ${slashRef("summarize-now")} 로 지금 요약 또는 esc esc(${slashRef("rewind")})로 메시지 줄이기`
}
