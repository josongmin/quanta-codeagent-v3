/**
 * ADR-0448 (RFC-10) — Swatch (render-side). Mirrors Cursor `cursor/canvas`
 * `swatch.d.ts:11-15` 1:1 (`{ color: Color; style? }`), with `className`
 * additionally accepted per the web-frontend Tailwind/cx convention (the
 * Cursor `style` prop is also forwarded).
 *
 * A small filled rounded box used as a category badge — the leading visual on
 * category rows / list items / the `leading` slot of `CollapsibleSection`.
 * Colors come ONLY from `tokens.ts#colorPalette` (the same 7-hue palette the
 * `UsageBar` segments draw from) so a category's swatch and its bar segment for
 * the same `color` stay visually coherent (swatch.d.ts:5-8, :22-23 contract).
 *
 * This is the rich-layer primitive that ADR-0440 (RFC-06) explicitly deferred
 * (06 NG3). It adds no data port — props-in / JSX-out.
 */

import type { CSSProperties } from "react"
import { cx } from "../../lib/classnames"
import { colorPalette, type PaletteColor } from "./tokens"

export interface SwatchProps {
  /** One of the 7 shared category hues. Matches `UsageBar` segment colors. */
  readonly color: PaletteColor
  readonly style?: CSSProperties
  readonly className?: string
}

/** Filled, rounded category swatch (16px square × rounded). The hue is read
 *  from the shared palette so it matches the same-`color` UsageBar segment. */
export const Swatch = ({ color, style, className }: SwatchProps): JSX.Element => (
  <span
    // Decorative: the category name always accompanies the swatch (a11y — the
    // swatch is never the only signal). Hidden from the a11y tree.
    aria-hidden="true"
    data-swatch-color={color}
    className={cx("inline-block h-4 w-4 shrink-0 rounded", className)}
    style={{ background: colorPalette[color], ...style }}
  />
)
