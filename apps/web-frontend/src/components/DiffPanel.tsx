/**
 * ADR-0440 — DiffPanel: host card wrapper composing a header (path +
 * `DiffStats`) over a `DiffView` body. Consumes a `ToolDiffMessage` directly
 * (the daemon already converted ops → lines + counted additions/deletions);
 * the panel NEVER recomputes — it reads the message verbatim.
 *
 * Binary frames render a placeholder instead of a diff. Default-OFF: callers
 * only mount this when a `tool.diff` frame has arrived (see `useToolDiffs`).
 */

import { memo } from "react"
import { diffStatsFromMessage } from "../adapters/diff-adapter"
import type { ToolDiffMessage } from "../types/protocol"
import { DiffStats } from "./canvas/DiffStats"
import { DiffView, type DiffViewMode } from "./canvas/DiffView"
import type { DiffTheme } from "./canvas/tokens"

export interface DiffPanelProps {
  readonly diff: ToolDiffMessage
  readonly theme?: DiffTheme
  /** ADR-0448 (RFC-10): opt into the rich side-by-side layout. Default
   *  `"inline"` ⇒ identical to ADR-0440 render (existing callers unchanged). */
  readonly mode?: DiffViewMode
  readonly className?: string
}

const DiffPanelInner = ({
  diff,
  theme = "dark",
  mode = "inline",
  className,
}: DiffPanelProps): JSX.Element => {
  const stats = diffStatsFromMessage(diff)
  return (
    <div
      className={[
        "rounded-lg border border-line-subtle bg-surface-raised overflow-hidden",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-3 py-1.5">
        <span className="truncate font-mono text-xs text-ink-secondary">
          {diff.path ?? "(diff)"}
        </span>
        <DiffStats additions={stats.additions} deletions={stats.deletions} />
      </div>
      {diff.binary === true ? (
        <div className="px-3 py-2 font-mono text-xs text-ink-tertiary italic">
          [binary file; preview skipped]
        </div>
      ) : (
        <DiffView
          lines={diff.lines}
          theme={theme}
          mode={mode}
          {...(diff.path !== undefined ? { path: diff.path } : {})}
          {...(diff.language !== undefined ? { language: diff.language } : {})}
          {...(diff.truncated === true ? { truncated: true, moreLines: diff.moreLines ?? 0 } : {})}
          className="px-1 py-1"
        />
      )}
    </div>
  )
}

/**
 * ADR-0440 perf (P2): memo comparator for {@link DiffPanel}. `DiffsSection`
 * renders one panel per `toolCallId` and passes each the STABLE per-id
 * `ToolDiffMessage` from the latest-wins Map — so on any single `tool.diff`
 * frame, only the ONE mutated entry gets a fresh object; the other N-1 panels
 * receive the IDENTICAL `diff` reference. A reference check on `diff` (plus
 * equality on the primitive theme/mode/className) is therefore EXACT: unchanged
 * panels bail (no `<tr>`-per-line table rebuild), and the changed panel — whose
 * `diff` object is genuinely new — re-renders. No stale risk: the daemon builds
 * a fresh `ToolDiffMessage` for every emission, so a content change ALWAYS
 * yields a new reference (never in-place mutation). Exported so the "unchanged
 * panel bails" invariant is testable at the comparator boundary (the test env
 * is `node`, no DOM renderer — mirrors `areMessageBubblePropsEqual`).
 */
export const areDiffPanelPropsEqual = (prev: DiffPanelProps, next: DiffPanelProps): boolean =>
  prev.diff === next.diff &&
  prev.theme === next.theme &&
  prev.mode === next.mode &&
  prev.className === next.className

export const DiffPanel = memo(DiffPanelInner, areDiffPanelPropsEqual)
