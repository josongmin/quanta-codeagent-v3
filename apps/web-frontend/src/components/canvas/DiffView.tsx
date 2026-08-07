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

import { Fragment, memo } from "react"
import { cx } from "../../lib/classnames"
import type { DiffAnchorComment, DiffLineData } from "../../types/protocol"
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
  /** RFC-12 (deferred) SURFACE B: anchored review comments to overlay on the
   *  matching diff line (by `lineNumber`). ADDITIVE + OPTIONAL: absent /
   *  undefined ⇒ NO overlay rows are emitted (byte-identical to the pre-RFC-12
   *  inline render). Each comment renders as an inline note row directly beneath
   *  its anchored line, carrying verdict + category + summary. */
  readonly comments?: readonly DiffAnchorComment[] | undefined
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

const DiffViewInner = ({
  lines,
  showLineNumbers = true,
  coloredLineNumbers = true,
  showAccentStrip = true,
  theme = "dark",
  truncated = false,
  moreLines = 0,
  mode = "inline",
  contextLines = 3,
  comments,
  className,
}: DiffViewProps): JSX.Element => {
  // ADR-0448 (RFC-10): split mode delegates to SplitDiffView. The inline path
  // below is unchanged from ADR-0440 (byte-identical for existing callers).
  // SURFACE B overlay is inline-only for now (split delegates unchanged).
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
    comments,
    className,
  })
}

/**
 * ADR-0440 perf (P2): memo comparator for {@link DiffView}. Every prop is
 * either a PRIMITIVE (theme/mode/flags/counts/className) or the `lines` array,
 * which — inside a `tool.diff` frame — is the SAME reference for an unchanged
 * `toolCallId` (latest-wins Map; only the mutated entry gets a fresh object).
 * So a reference check on `lines` plus equality on the primitives is exact: a
 * re-render fires ONLY when the diff content or a display prop actually
 * changed. Exported so the "unchanged panel bails" invariant is testable at the
 * comparator boundary (the test env is `node`, no DOM renderer — mirrors
 * `areMessageBubblePropsEqual`).
 */
export const areDiffViewPropsEqual = (prev: DiffViewProps, next: DiffViewProps): boolean =>
  prev.lines === next.lines &&
  prev.path === next.path &&
  prev.language === next.language &&
  prev.showLineNumbers === next.showLineNumbers &&
  prev.coloredLineNumbers === next.coloredLineNumbers &&
  prev.showAccentStrip === next.showAccentStrip &&
  prev.theme === next.theme &&
  prev.truncated === next.truncated &&
  prev.moreLines === next.moreLines &&
  prev.mode === next.mode &&
  prev.contextLines === next.contextLines &&
  prev.comments === next.comments &&
  prev.className === next.className

export const DiffView = memo(DiffViewInner, areDiffViewPropsEqual)

interface InlineTableProps {
  readonly lines: readonly DiffLineData[]
  readonly showLineNumbers: boolean
  readonly coloredLineNumbers: boolean
  readonly showAccentStrip: boolean
  readonly theme: DiffTheme
  readonly truncated: boolean
  readonly moreLines: number
  readonly comments: readonly DiffAnchorComment[] | undefined
  readonly className: string | undefined
}

/** SURFACE B — verdict → badge hue (reuses tone vocabulary; not color-only —
 *  the verdict text rides alongside). `confirmed` reads as a firm signal. */
const VERDICT_HUE: Record<"confirmed" | "plausible", string> = {
  confirmed: "text-err",
  plausible: "text-warn",
}

/** SURFACE B — group comments by their anchored (1-based) line so the overlay
 *  row for each diff line is a single Map lookup. Pure. */
const groupCommentsByLine = (
  comments: readonly DiffAnchorComment[] | undefined,
): ReadonlyMap<number, readonly DiffAnchorComment[]> => {
  const map = new Map<number, DiffAnchorComment[]>()
  if (comments === undefined) return map
  for (const c of comments) {
    const bucket = map.get(c.line)
    if (bucket === undefined) map.set(c.line, [c])
    else bucket.push(c)
  }
  return map
}

/** SURFACE B — one anchored-comment note row, spanning the full diff width. */
const CommentRow = ({
  comment,
  colSpan,
}: {
  comment: DiffAnchorComment
  colSpan: number
}): JSX.Element => (
  <tr data-testid="diff-anchor-comment" data-line={comment.line}>
    <td
      colSpan={colSpan}
      className="border-line-subtle border-l-2 bg-surface-raised px-3 py-1 text-[11px] text-ink-secondary"
    >
      <span className="flex flex-wrap items-baseline gap-1.5">
        {comment.verdict !== undefined ? (
          <span
            className={cx("font-semibold uppercase tracking-wide", VERDICT_HUE[comment.verdict])}
          >
            {comment.verdict}
          </span>
        ) : null}
        {comment.category !== undefined ? (
          <span className="rounded bg-surface-input px-1 py-0.5 font-mono text-[10px] text-ink-tertiary">
            {comment.category}
          </span>
        ) : null}
        <span className="text-ink">{comment.summary}</span>
      </span>
    </td>
  </tr>
)

const inlineDiffTable = ({
  lines,
  showLineNumbers,
  coloredLineNumbers,
  showAccentStrip,
  theme,
  truncated,
  moreLines,
  comments,
  className,
}: InlineTableProps): JSX.Element => {
  const byLine = groupCommentsByLine(comments)
  // The overlay note spans every column the diff row uses (strip + gutter +
  // content), so the count is derived — never a magic number.
  const colSpan = 1 + (showAccentStrip ? 1 : 0) + (showLineNumbers ? 1 : 0)
  return (
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
          // SURFACE B — anchored comments overlay a line by its `lineNumber`. Only
          // rows on the new/added side (`added`/`unchanged`, which carry the
          // new-side number) can match; a `removed` line's number is old-side. An
          // empty map (no `comments` prop) ⇒ `hits` is always empty ⇒ zero extra
          // rows (byte-identical).
          const hits =
            line.lineNumber !== undefined && line.type !== "removed"
              ? (byLine.get(line.lineNumber) ?? [])
              : []
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
            <Fragment key={idx}>
              <tr
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
                      coloredLineNumbers && line.type === "added" && "text-ok",
                      coloredLineNumbers && line.type === "removed" && "text-err",
                      (!coloredLineNumbers || line.type === "unchanged") && "text-ink-tertiary",
                    )}
                  >
                    {line.lineNumber ?? ""}
                  </td>
                ) : null}
                <td className="whitespace-pre px-2">
                  {PREFIX[line.type]} {line.content}
                </td>
              </tr>
              {hits.map((c, ci) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional overlay
                <CommentRow key={ci} comment={c} colSpan={colSpan} />
              ))}
            </Fragment>
          )
        })}
        {truncated ? (
          <tr>
            <td colSpan={3} className="px-2 py-0.5 text-ink-tertiary italic">
              … ({moreLines} more line{moreLines === 1 ? "" : "s"})
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}
