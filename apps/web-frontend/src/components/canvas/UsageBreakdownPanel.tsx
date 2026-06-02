/**
 * ADR-0448 (RFC-10) — UsageBreakdownPanel: the rich usage chrome RFC-06
 * deferred.
 *
 * RFC-06 ships the `UsageBar` PRIMITIVE only (segments + remainder + labels),
 * dropping each category's color + char count. This panel consumes the same
 * `ContextUsageMessage` data port and adds the deferred rich layer:
 *   - the RFC-06 `UsageBar` on top, with each segment painted its CATEGORY hue
 *     (via `breakdownToUsageBarProps`) so the bar and the legend agree;
 *   - a per-category legend, each row a `CollapsibleSection` whose `leading` is
 *     a `Swatch` of the same hue (swatch.d.ts:22-23 coherence) and whose
 *     `trailing` is the token / char / % readout (the `chars` RFC-06 drops —
 *     RFC-10 §4.2.3 — surfaced here when the optional wire field is present).
 *
 * Default-OFF: a null message ⇒ renders `null` (chat UI unchanged when the
 * RFC-06 data channel / gate is OFF). Empty segments ⇒ header + bar only.
 * No data port of its own — it reads RFC-06's `context.usage` frame.
 */

import type { ContextUsageMessage } from "../../types/protocol"
import { CollapsibleSection } from "./CollapsibleSection"
import { breakdownToUsageBarProps, CATEGORY_TO_HUE } from "./category-hues"
import { Swatch } from "./Swatch"
import { type PaletteColor, usageColorSequence } from "./tokens"
import { UsageBar } from "./UsageBar"

export interface UsageBreakdownPanelProps {
  /** RFC-06's `context.usage` frame (the data port). `null` ⇒ render nothing. */
  readonly usage: ContextUsageMessage | null
  readonly className?: string
}

const fmt = (n: number): string => {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  if (v < 1000) return String(Math.trunc(v))
  const k = v / 1000
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
}

const sharePercent = (value: number, total: number): number => {
  if (!(total > 0)) return 0
  return Math.round((value / total) * 100)
}

/** Resolve a segment id to a named palette hue for the Swatch (known category
 *  ⇒ canonical hue; unknown ⇒ a deterministic palette key by index). */
const FALLBACK_HUES: readonly PaletteColor[] = [
  "blue",
  "green",
  "purple",
  "yellow",
  "pink",
  "orange",
  "gray",
]
const swatchHue = (id: string, index: number): PaletteColor => {
  const named = CATEGORY_TO_HUE[id]
  if (named !== undefined) return named
  return FALLBACK_HUES[index % FALLBACK_HUES.length] ?? "gray"
}

export const UsageBreakdownPanel = ({
  usage,
  className,
}: UsageBreakdownPanelProps): JSX.Element | null => {
  if (usage === null) return null
  const bar = breakdownToUsageBarProps(usage)
  // Total spent across categories (for per-category share). Falls back to the
  // window when categories sum to 0 so share never divides by 0.
  const spent = usage.segments.reduce(
    (a, s) => a + (Number.isFinite(s.tokens) && s.tokens > 0 ? s.tokens : 0),
    0,
  )
  // Keep usageColorSequence referenced so the palette stays the single source.
  void usageColorSequence
  return (
    <section
      data-testid="usage-breakdown-panel"
      aria-label="context usage breakdown"
      className={["rounded-md border border-neutral-800 bg-neutral-900 p-3", className ?? ""]
        .join(" ")
        .trim()}
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Context usage
      </h3>
      <UsageBar
        segments={bar.segments}
        total={bar.total}
        {...(bar.topLeftLabel !== undefined ? { topLeftLabel: bar.topLeftLabel } : {})}
        {...(bar.topRightLabel !== undefined ? { topRightLabel: bar.topRightLabel } : {})}
      />
      {usage.segments.length > 0 ? (
        <div className="mt-2">
          {usage.segments.map((seg, idx) => {
            const hue = swatchHue(seg.id, idx)
            const share = sharePercent(seg.tokens, spent)
            const charsPart = seg.chars !== undefined ? ` · ${fmt(seg.chars)}ch` : ""
            return (
              <CollapsibleSection
                key={seg.id}
                title={seg.id}
                leading={<Swatch color={hue} />}
                trailing={
                  <span className="tabular-nums">
                    {fmt(seg.tokens)}
                    {charsPart} · {share}%
                  </span>
                }
              >
                <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 py-1 text-[11px] text-neutral-400">
                  <dt>tokens</dt>
                  <dd className="tabular-nums text-neutral-200">{seg.tokens}</dd>
                  {seg.chars !== undefined ? (
                    <>
                      <dt>chars</dt>
                      <dd className="tabular-nums text-neutral-200">{seg.chars}</dd>
                    </>
                  ) : null}
                  <dt>share</dt>
                  <dd className="tabular-nums text-neutral-200">{share}%</dd>
                </dl>
              </CollapsibleSection>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
