/**
 * ADR-0440 — DiffView (render-side). Mirrors Cursor `cursor/canvas`
 * `DiffViewProps` 1:1 (prop names + meaning), with `className` substituted for
 * `style` per the web-frontend Tailwind/cx convention.
 *
 * Renders `DiffLineData[]` (produced daemon-side from the CLI diff math — the
 * web bundle never runs diff math) as colored line rows + an optional
 * line-number gutter + an optional 3px accent strip. Colors come ONLY from
 * `tokens.ts` (no hardcoded hex). Accessibility: a `role="table"` of
 * `role="row"` rows, each with an `aria-label` so meaning is not color-only.
 *
 * Default-OFF: empty `lines` ⇒ an empty (non-throwing) container.
 *
 * ADR-0448 (RFC-10) ADDS the deferred `mode?: "inline" | "split"` prop. It
 * defaults to `"inline"`, whose render path is BYTE-IDENTICAL to the original
 * (every existing caller + test is unchanged). `mode="split"` delegates to the
 * new `SplitDiffView` (side-by-side 2-column + collapsible hunks).
 */

import { cx } from "../../lib/classnames"
import type { DiffLineData } from "../../types/protocol"
import { SplitDiffView } from "./SplitDiffView"
import { type DiffTheme, diffTokens } from "./tokens"

/** Layout for the rich DiffView (ADR-0448 / RFC-10). */
export type DiffViewMode = "inline" | "split"

export interface DiffViewProps {
  readonly lines: readonly DiffLineData[]
  /** Language inference source (v2 highlight). Currently render-inert. */
  readonly path?: string
  /** Language override (wins over `path`). Currently render-inert. */
  readonly language?: string
  /** Show the line-number gutter. Default true. */
  readonly showLineNumbers?: boolean
  /** Tint the gutter number by line type. Default true. */
  readonly coloredLineNumbers?: boolean
  /** Render the 3px left accent strip. Default true. */
  readonly showAccentStrip?: boolean
  /** Theme palette to apply. Default "dark" (web-frontend is dark-by-default). */
  readonly theme?: DiffTheme
  /** When `truncated`, show a trailing "… (N more lines)" affordance. */
  readonly truncated?: boolean
  readonly moreLines?: number
  /** ADR-0448 (RFC-10): `"inline"` (default; original render) or `"split"`
   *  (side-by-side 2-column + collapsible hunks via `SplitDiffView`). */
  readonly mode?: DiffViewMode
  /** ADR-0448 (RFC-10): unchanged-context lines kept around each change in
   *  split mode before the rest folds. Forwarded to `SplitDiffView`. Inert in
   *  inline mode. Default 3 (git default). */
  readonly contextLines?: number
  readonly className?: string
}

const PREFIX: Record<DiffLineData["type"], string> = {
  added: "+",
  removed: "-",
  unchanged: " ",
}

const ARIA: Record<DiffLineData["type"], string> = {
  added: "added line",
  removed: "removed line",
  unchanged: "unchanged line",
}

const lineBackground = (type: DiffLineData["type"], theme: DiffTheme): string | undefined => {
  const t = diffTokens[theme]
  if (type === "added") return t.insertedLine
  if (type === "removed") return t.removedLine
  return undefined
}

const stripColor = (type: DiffLineData["type"], theme: DiffTheme): string => {
  const t = diffTokens[theme]
  if (type === "added") return t.stripAdded
  if (type === "removed") return t.stripRemoved
  return "transparent"
}

export const DiffView = ({
  lines,
  showLineNumbers = true,
  coloredLineNumbers = true,
  showAccentStrip = true,
  theme = "dark",
  truncated = false,
  moreLines = 0,
  mode = "inline",
  contextLines = 3,
  className,
}: DiffViewProps): JSX.Element => {
  // ADR-0448 (RFC-10): split mode delegates to SplitDiffView. The inline path
  // below is unchanged from ADR-0440 (byte-identical for existing callers).
  if (mode === "split") {
    return (
      <SplitDiffView
        lines={lines}
        theme={theme}
        showLineNumbers={showLineNumbers}
        coloredLineNumbers={coloredLineNumbers}
        contextLines={contextLines}
        {...(truncated ? { truncated, moreLines } : {})}
        {...(className !== undefined ? { className } : {})}
      />
    )
  }
  return inlineDiffTable({
    lines,
    showLineNumbers,
    coloredLineNumbers,
    showAccentStrip,
    theme,
    truncated,
    moreLines,
    className,
  })
}

interface InlineTableProps {
  readonly lines: readonly DiffLineData[]
  readonly showLineNumbers: boolean
  readonly coloredLineNumbers: boolean
  readonly showAccentStrip: boolean
  readonly theme: DiffTheme
  readonly truncated: boolean
  readonly moreLines: number
  readonly className: string | undefined
}

const inlineDiffTable = ({
  lines,
  showLineNumbers,
  coloredLineNumbers,
  showAccentStrip,
  theme,
  truncated,
  moreLines,
  className,
}: InlineTableProps): JSX.Element => (
  // A real <table> (not role="table") so the semantics are native + biome-clean.
  // The accent strip + colored gutter are aria-hidden; per-line meaning rides
  // each row's aria-label so the diff is not conveyed by color alone (RFC §3.7).
  <table
    aria-label="file diff"
    className={cx("w-full border-collapse font-mono text-xs leading-5", className)}
  >
    <tbody>
      {lines.map((line, idx) => {
        const bg = lineBackground(line.type, theme)
        return (
          <tr
            // Diff lines are positional + immutable per frame; index key is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
            key={idx}
            aria-label={ARIA[line.type]}
            style={bg !== undefined ? { background: bg } : undefined}
          >
            {showAccentStrip ? (
              <td
                aria-hidden="true"
                className="w-[3px] p-0"
                style={{ background: stripColor(line.type, theme) }}
              />
            ) : null}
            {showLineNumbers ? (
              <td
                aria-hidden="true"
                className={cx(
                  "w-10 select-none px-1 text-right align-top tabular-nums",
                  coloredLineNumbers && line.type === "added" && "text-emerald-400",
                  coloredLineNumbers && line.type === "removed" && "text-rose-400",
                  (!coloredLineNumbers || line.type === "unchanged") && "text-neutral-500",
                )}
              >
                {line.lineNumber ?? ""}
              </td>
            ) : null}
            <td className="whitespace-pre px-2">
              {PREFIX[line.type]} {line.content}
            </td>
          </tr>
        )
      })}
      {truncated ? (
        <tr>
          <td colSpan={3} className="px-2 py-0.5 text-neutral-500 italic">
            … ({moreLines} more line{moreLines === 1 ? "" : "s"})
          </td>
        </tr>
      ) : null}
    </tbody>
  </table>
)
