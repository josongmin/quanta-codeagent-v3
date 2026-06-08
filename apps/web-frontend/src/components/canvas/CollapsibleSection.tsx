/**
 * ADR-0448 (RFC-10) — CollapsibleSection (render-side). Mirrors Cursor
 * `cursor/canvas` `collapsible-section.d.ts:10-31` 1:1 (title / leading / count
 * / trailing / children / style), with `className` additionally accepted per
 * the web-frontend Tailwind/cx convention.
 *
 * A borderless disclosure row: a chevron + a structured header (title, optional
 * leading swatch, optional count, optional trailing readout) over a body that
 * toggles open. Body content is indented so nested `CollapsibleSection`s read
 * as a tree (collapsible-section.d.ts:38-39).
 *
 * Contract (collapsible-section.d.ts:33): **always starts closed**
 * (uncontrolled, no `defaultOpen`). This is the rich-layer primitive RFC-06
 * deferred (06 NG3) — the building block for both (A) diff-hunk folding and
 * (B) usage-category drilldown. No data port — props-in / JSX-out.
 */

import { type CSSProperties, type ReactNode, useId, useState } from "react"
import { cx } from "../../lib/classnames"

export interface CollapsibleSectionProps {
  /** Plain-text title rendered next to the disclosure chevron. */
  readonly title: string
  /** Optional leading visual (e.g. `<Swatch>`) between chevron and title. */
  readonly leading?: ReactNode
  /** Optional small count rendered after the title (e.g. number of children). */
  readonly count?: number
  /** Optional trailing node, right-aligned (e.g. token readout / badge). */
  readonly trailing?: ReactNode
  /** Body shown when expanded. */
  readonly children?: ReactNode
  readonly style?: CSSProperties
  readonly className?: string
}

export const CollapsibleSection = ({
  title,
  leading,
  count,
  trailing,
  children,
  style,
  className,
}: CollapsibleSectionProps): JSX.Element => {
  // Uncontrolled, closed-default (collapsible-section.d.ts:33). CSR-only surface
  // (Vite SPA) so no SSR/hydration concern for the initial closed state.
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <div className={cx("w-full", className)} style={style}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-white/5"
      >
        <span
          aria-hidden="true"
          className={cx(
            "inline-block w-3 shrink-0 select-none text-ink-tertiary transition-transform",
            open && "rotate-90",
          )}
        >
          ▶
        </span>
        {leading !== undefined ? leading : null}
        <span className="truncate text-ink">{title}</span>
        {count !== undefined ? (
          <span className="shrink-0 text-ink-tertiary tabular-nums">{count}</span>
        ) : null}
        {trailing !== undefined ? (
          <span className="ml-auto shrink-0 text-ink-secondary">{trailing}</span>
        ) : null}
      </button>
      {open ? (
        // Indented body so nested sections read as a tree.
        <div id={bodyId} className="ml-4 border-l border-line pl-2">
          {children}
        </div>
      ) : null}
    </div>
  )
}
