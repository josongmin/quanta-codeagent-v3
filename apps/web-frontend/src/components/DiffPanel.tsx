/**
 * ADR-0440 — DiffPanel: host card wrapper composing a header (path +
 * `DiffStats`) over a `DiffView` body. Consumes a `ToolDiffMessage` directly
 * (the daemon already converted ops → lines + counted additions/deletions);
 * the panel NEVER recomputes — it reads the message verbatim.
 *
 * Binary frames render a placeholder instead of a diff. Default-OFF: callers
 * only mount this when a `tool.diff` frame has arrived (see `useToolDiffs`).
 */

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

export const DiffPanel = ({
  diff,
  theme = "dark",
  mode = "inline",
  className,
}: DiffPanelProps): JSX.Element => {
  const stats = diffStatsFromMessage(diff)
  return (
    <div
      className={[
        "rounded-md border border-neutral-800 bg-neutral-900/50 overflow-hidden",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="truncate font-mono text-xs text-neutral-300">{diff.path ?? "(diff)"}</span>
        <DiffStats additions={stats.additions} deletions={stats.deletions} />
      </div>
      {diff.binary === true ? (
        <div className="px-3 py-2 font-mono text-xs text-neutral-500 italic">
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
