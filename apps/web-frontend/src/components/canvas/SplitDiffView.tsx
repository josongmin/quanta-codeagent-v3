/**
 * ADR-0448 (RFC-10) — SplitDiffView: the rich diff layout RFC-06 deferred.
 *
 * RFC-06's `DiffView` is inline-only (a single flat column). This adds the two
 * pieces 06 explicitly excluded (06 NG3):
 *   (A) **side-by-side / split** — del/unchanged on the LEFT (old side),
 *       add/unchanged on the RIGHT (new side); changed lines are zipped del↔add
 *       in op order (LCS already emits del→add, so no new alignment algorithm —
 *       RFC-10 §4.1.3); the unpaired side renders an empty cell.
 *   (B) **collapsible hunks** — long unchanged runs fold into a
 *       `CollapsibleSection` (closed-default) so only changed context shows.
 *
 * Consumes the SAME `DiffLineData[]` RFC-06 ships — re-runs NO diff math. Pure
 * re-segmentation via `groupHunks`. Colors come ONLY from `tokens.ts`.
 */

import { cx } from "../../lib/classnames"
import type { DiffLineData } from "../../types/protocol"
import { CollapsibleSection } from "./CollapsibleSection"
import { type DiffHunk, groupHunks } from "./diff-hunks"
import { type DiffTheme, diffTokens } from "./tokens"

export interface SplitDiffViewProps {
  readonly lines: readonly DiffLineData[]
  readonly theme?: DiffTheme
  readonly showLineNumbers?: boolean
  readonly coloredLineNumbers?: boolean
  /** Unchanged context kept around changes before folding. Default 3 (git). */
  readonly contextLines?: number
  readonly truncated?: boolean
  readonly moreLines?: number
  readonly className?: string
}

/** A single side-by-side row: a left (old) cell and a right (new) cell, either
 *  of which may be absent (unpaired change ⇒ empty cell). */
interface SplitRow {
  readonly left?: DiffLineData
  readonly right?: DiffLineData
}

/** Build the rows for one contiguous changed run (no unchanged lines): removed
 *  go LEFT, added go RIGHT, paired index-by-index; the longer side spills into
 *  rows with one empty cell. */
const zipChangedRun = (run: readonly DiffLineData[]): SplitRow[] => {
  const removed = run.filter((l) => l.type === "removed")
  const added = run.filter((l) => l.type === "added")
  const pairs = Math.max(removed.length, added.length)
  const rows: SplitRow[] = []
  for (let p = 0; p < pairs; p++) {
    const left = removed[p]
    const right = added[p]
    rows.push({
      ...(left !== undefined ? { left } : {}),
      ...(right !== undefined ? { right } : {}),
    })
  }
  return rows
}

/**
 * Zip a hunk's lines into split rows. Unchanged lines occupy BOTH sides;
 * changed runs are paired del↔add by `zipChangedRun` (op order — LCS already
 * orders del before add, so no new alignment algorithm).
 */
export const hunkToSplitRows = (hunk: DiffHunk): readonly SplitRow[] => {
  const rows: SplitRow[] = []
  let run: DiffLineData[] = []
  const flush = (): void => {
    if (run.length > 0) {
      rows.push(...zipChangedRun(run))
      run = []
    }
  }
  for (const line of hunk.lines) {
    if (line.type === "unchanged") {
      flush()
      rows.push({ left: line, right: line })
    } else {
      run.push(line)
    }
  }
  flush()
  return rows
}

const cellBackground = (
  type: DiffLineData["type"] | undefined,
  theme: DiffTheme,
): string | undefined => {
  if (type === undefined) return undefined
  const t = diffTokens[theme]
  if (type === "added") return t.insertedLine
  if (type === "removed") return t.removedLine
  return undefined
}

const ARIA: Record<DiffLineData["type"], string> = {
  added: "added line",
  removed: "removed line",
  unchanged: "unchanged line",
}

const PREFIX: Record<DiffLineData["type"], string> = {
  added: "+",
  removed: "-",
  unchanged: " ",
}

const linePrefix = (line: DiffLineData | undefined): string =>
  line === undefined ? "" : PREFIX[line.type]

/** Gutter tint class for a cell's line-number column. */
const gutterTint = (line: DiffLineData | undefined, colored: boolean): string => {
  if (colored && line?.type === "added") return "text-emerald-400"
  if (colored && line?.type === "removed") return "text-rose-400"
  return "text-neutral-500"
}

/** One side (old/new) of a split row, rendered as a real <td> so the layout is
 *  native-semantic (matches the ADR-0440 inline DiffView's real <table>). */
const SplitCell = ({
  line,
  theme,
  side,
  showLineNumbers,
  coloredLineNumbers,
}: {
  readonly line: DiffLineData | undefined
  readonly theme: DiffTheme
  readonly side: "old" | "new"
  readonly showLineNumbers: boolean
  readonly coloredLineNumbers: boolean
}): JSX.Element => {
  const bg = cellBackground(line?.type, theme)
  return (
    <td
      // Empty cells are the unpaired side of a change. The aria-label carries
      // per-line meaning so the diff is not conveyed by color alone.
      aria-label={line !== undefined ? `${side} ${ARIA[line.type]}` : undefined}
      className={cx("w-1/2 align-top", line === undefined && "bg-neutral-900/40")}
      style={bg !== undefined ? { background: bg } : undefined}
    >
      <span className="flex gap-1 px-2">
        {showLineNumbers ? (
          <span
            aria-hidden="true"
            className={cx(
              "w-8 shrink-0 select-none text-right tabular-nums",
              gutterTint(line, coloredLineNumbers),
            )}
          >
            {line?.lineNumber ?? ""}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 whitespace-pre">
          {linePrefix(line)} {line?.content ?? ""}
        </span>
      </span>
    </td>
  )
}

/** A self-contained <table> for one hunk's side-by-side rows (each hunk is its
 *  own table so a collapsed hunk can sit between two visible ones without
 *  breaking table structure). */
const SplitHunkRows = ({
  hunk,
  theme,
  showLineNumbers,
  coloredLineNumbers,
}: {
  readonly hunk: DiffHunk
  readonly theme: DiffTheme
  readonly showLineNumbers: boolean
  readonly coloredLineNumbers: boolean
}): JSX.Element => (
  <table className="w-full table-fixed border-collapse">
    <tbody>
      {hunkToSplitRows(hunk).map((row, idx) => (
        <tr
          // Positional + immutable per frame.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
          key={idx}
        >
          <SplitCell
            line={row.left}
            theme={theme}
            side="old"
            showLineNumbers={showLineNumbers}
            coloredLineNumbers={coloredLineNumbers}
          />
          <SplitCell
            line={row.right}
            theme={theme}
            side="new"
            showLineNumbers={showLineNumbers}
            coloredLineNumbers={coloredLineNumbers}
          />
        </tr>
      ))}
    </tbody>
  </table>
)

export const SplitDiffView = ({
  lines,
  theme = "dark",
  showLineNumbers = true,
  coloredLineNumbers = true,
  contextLines = 3,
  truncated = false,
  moreLines = 0,
  className,
}: SplitDiffViewProps): JSX.Element => {
  const hunks = groupHunks(lines, contextLines)
  return (
    <section
      aria-label="file diff (split)"
      className={cx("w-full font-mono text-xs leading-5", className)}
    >
      {hunks.map((hunk, idx) =>
        hunk.collapsed ? (
          <CollapsibleSection
            // Hunks are positional per frame.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff hunks
            key={idx}
            title={`… ${hunk.lines.length} unchanged line${hunk.lines.length === 1 ? "" : "s"}`}
            count={hunk.lines.length}
          >
            <SplitHunkRows
              hunk={hunk}
              theme={theme}
              showLineNumbers={showLineNumbers}
              coloredLineNumbers={coloredLineNumbers}
            />
          </CollapsibleSection>
        ) : (
          <SplitHunkRows
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff hunks
            key={idx}
            hunk={hunk}
            theme={theme}
            showLineNumbers={showLineNumbers}
            coloredLineNumbers={coloredLineNumbers}
          />
        ),
      )}
      {truncated ? (
        <div className="px-2 py-0.5 text-neutral-500 italic">
          … ({moreLines} more line{moreLines === 1 ? "" : "s"})
        </div>
      ) : null}
    </section>
  )
}
