/**
 * ADR-0440 — DiffStats (render-side). Mirrors Cursor `cursor/canvas`
 * `DiffStats` props `{ additions?, deletions? }`. Renders a `+N` / `-N` glyph
 * pair with tabular-nums. Both zero ⇒ `null` (Cursor contract).
 */

import { cx } from "../../lib/classnames"

export interface DiffStatsProps {
  readonly additions?: number
  readonly deletions?: number
  readonly className?: string
}

export const DiffStats = ({
  additions = 0,
  deletions = 0,
  className,
}: DiffStatsProps): JSX.Element | null => {
  if (additions === 0 && deletions === 0) return null
  return (
    <span
      // role="img" so the summary aria-label is a supported prop (the visible
      // +N/-N glyphs are decorative; the label conveys the same meaning).
      role="img"
      className={cx("inline-flex items-center gap-2 font-mono text-xs tabular-nums", className)}
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      {additions > 0 ? <span className="text-ok">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-err">-{deletions}</span> : null}
    </span>
  )
}
