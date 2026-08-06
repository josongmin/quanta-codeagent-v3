/**
 * RFC-12 (deferred) SURFACE C — chart primitives for the canvas.
 *
 * `BarChart` / `LineChart` / `PieChart` rendered as PURE inline SVG with ZERO
 * external dependencies (no Highcharts / recharts / d3). Mirrors the Cursor
 * `cursor/canvas` `chart-primitives.d.ts` prop contract 1:1 (`ChartSeries`,
 * `ChartDataPoint`, `ChartTone`, `categories`, `stacked`/`horizontal`/…), with
 * `className` substituted for `style` per the web-frontend Tailwind/cx convention
 * — the same substitution `DiffView` made for the Cursor `style` prop.
 *
 * Colors come ONLY from `tokens.ts` (no hardcoded hex): a `tone` maps to a
 * semantic palette hue; an un-toned series/slice rotates through the shared
 * `usageColorSequence` (same auto-assignment rule the UsageBar uses).
 *
 * PURE data-in → SVG-out (no fetch, no effect), so the render SHAPE is unit-
 * testable via `renderToStaticMarkup` in the node env — mirrors `CsvGrid` /
 * `NotebookView`. The heavy artifact-bytes fetch (JSON → props) lives in the
 * lazy `ChartArtifact` wrapper wired into `ArtifactStrip`, NOT here.
 */

import { memo } from "react"
import { cx } from "../../lib/classnames"
import { colorPalette, type PaletteColor, usageColorSequence } from "./tokens"

/** Semantic tone for a series / slice (Cursor `ChartTone`). */
export type ChartTone = "success" | "danger" | "warning" | "info" | "neutral"

/** A single labeled value, used by `PieChart` (Cursor `ChartDataPoint`). */
export interface ChartDataPoint {
  readonly label: string
  /** Non-negative numeric value. */
  readonly value: number
}

/** A named data series for `BarChart` / `LineChart` (Cursor `ChartSeries`). The
 *  `data` array aligns by index with the parent's `categories`. */
export interface ChartSeries {
  readonly name: string
  readonly data: readonly number[]
  readonly tone?: ChartTone
}

export interface BarChartProps {
  readonly categories: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly height?: number
  /** Stack series instead of grouping side-by-side. */
  readonly stacked?: boolean
  readonly valueSuffix?: string
  readonly className?: string
}

export interface LineChartProps {
  readonly categories: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly height?: number
  /** Fill the area under each line with a soft tint. */
  readonly fill?: boolean
  readonly valueSuffix?: string
  readonly className?: string
}

export interface PieChartProps {
  readonly data: readonly (ChartDataPoint & { readonly tone?: ChartTone })[]
  readonly size?: number
  readonly donut?: boolean
  readonly className?: string
}

/** Tone → shared palette hue (tokens.ts). Keeps chart colors coherent with the
 *  usage legend + swatches (same tone vocabulary the SDK primitives use). */
const TONE_HUE: Record<ChartTone, PaletteColor> = {
  success: "green",
  danger: "pink",
  warning: "yellow",
  info: "blue",
  neutral: "gray",
}

/** Resolve a color for a series/slice at `index`: an explicit `tone` wins;
 *  otherwise rotate through the shared sequence (Cursor auto-assignment). */
const colorFor = (tone: ChartTone | undefined, index: number): string => {
  if (tone !== undefined) return colorPalette[TONE_HUE[tone]]
  const seq = usageColorSequence
  return seq[index % seq.length] ?? colorPalette.gray
}

/** Clamp to a finite non-negative number (a NaN/neg value ⇒ 0, so a hostile
 *  payload never produces a NaN geometry). */
const clamp = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

const DEFAULT_H = 160
const CHART_W = 320
const PAD = 24

/** Largest per-category stacked column sum. */
const maxStacked = (series: readonly ChartSeries[], catCount: number): number => {
  let max = 0
  for (let c = 0; c < catCount; c++) {
    let sum = 0
    for (const s of series) sum += clamp(s.data[c] ?? 0)
    if (sum > max) max = sum
  }
  return max
}

/** Largest single grouped bar. */
const maxGrouped = (series: readonly ChartSeries[]): number => {
  let max = 0
  for (const s of series) for (const v of s.data) max = Math.max(max, clamp(v))
  return max
}

/** Max value across all series (for the y-axis scale). `>= 1` so a flat/empty
 *  chart still has a valid scale (no divide-by-zero). */
const maxValue = (series: readonly ChartSeries[], stacked: boolean, catCount: number): number => {
  const max = stacked ? maxStacked(series, catCount) : maxGrouped(series)
  return max > 0 ? max : 1
}

/* ----------------------------- BarChart ------------------------------ */

const BarChartInner = ({
  categories,
  series,
  height = DEFAULT_H,
  stacked = false,
  valueSuffix = "",
  className,
}: BarChartProps): JSX.Element => {
  const w = CHART_W
  const h = height
  const plotH = h - PAD * 2
  const plotW = w - PAD * 2
  const n = categories.length
  const max = maxValue(series, stacked, n)
  const groupW = n > 0 ? plotW / n : plotW
  const barGap = 4

  return (
    <svg
      data-testid="chart-bar"
      role="img"
      aria-label="bar chart"
      viewBox={`0 0 ${w} ${h}`}
      className={cx("mt-2 w-full", className)}
    >
      {categories.map((cat, ci) => {
        const x0 = PAD + ci * groupW
        if (stacked) {
          let acc = 0
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional categories
            <g key={ci} data-category={cat}>
              {series.map((s, si) => {
                const val = clamp(s.data[ci] ?? 0)
                const segH = (val / max) * plotH
                const y = PAD + plotH - acc - segH
                acc += segH
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional series
                    key={si}
                    x={x0 + barGap}
                    y={y}
                    width={groupW - barGap * 2}
                    height={segH}
                    fill={colorFor(s.tone, si)}
                  />
                )
              })}
            </g>
          )
        }
        const each = (groupW - barGap * 2) / Math.max(series.length, 1)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional categories
          <g key={ci} data-category={cat}>
            {series.map((s, si) => {
              const val = clamp(s.data[ci] ?? 0)
              const barH = (val / max) * plotH
              return (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional series
                  key={si}
                  x={x0 + barGap + si * each}
                  y={PAD + plotH - barH}
                  width={each}
                  height={barH}
                  fill={colorFor(s.tone, si)}
                />
              )
            })}
          </g>
        )
      })}
      <text x={PAD} y={PAD - 8} className="fill-ink-tertiary text-[9px]">
        {max}
        {valueSuffix}
      </text>
    </svg>
  )
}
export const BarChart = memo(BarChartInner)

/* ----------------------------- LineChart ----------------------------- */

const LineChartInner = ({
  categories,
  series,
  height = DEFAULT_H,
  fill = false,
  valueSuffix = "",
  className,
}: LineChartProps): JSX.Element => {
  const w = CHART_W
  const h = height
  const plotH = h - PAD * 2
  const plotW = w - PAD * 2
  const n = categories.length
  const max = maxValue(series, false, n)
  const step = n > 1 ? plotW / (n - 1) : 0

  const pointsFor = (s: ChartSeries): { x: number; y: number }[] =>
    categories.map((_, ci) => {
      const val = clamp(s.data[ci] ?? 0)
      return { x: PAD + ci * step, y: PAD + plotH - (val / max) * plotH }
    })

  return (
    <svg
      data-testid="chart-line"
      role="img"
      aria-label="line chart"
      viewBox={`0 0 ${w} ${h}`}
      className={cx("mt-2 w-full", className)}
    >
      {series.map((s, si) => {
        const pts = pointsFor(s)
        const color = colorFor(s.tone, si)
        const poly = pts.map((p) => `${p.x},${p.y}`).join(" ")
        const area =
          pts.length > 0
            ? `${PAD},${PAD + plotH} ${poly} ${PAD + (n - 1) * step},${PAD + plotH}`
            : ""
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional series
          <g key={si} data-series={s.name}>
            {fill && pts.length > 0 ? (
              <polygon points={area} fill={color} fillOpacity={0.15} />
            ) : null}
            <polyline points={poly} fill="none" stroke={color} strokeWidth={2} />
            {pts.map((p, pi) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional points
              <circle key={pi} cx={p.x} cy={p.y} r={2.5} fill={color} />
            ))}
          </g>
        )
      })}
      <text x={PAD} y={PAD - 8} className="fill-ink-tertiary text-[9px]">
        {max}
        {valueSuffix}
      </text>
    </svg>
  )
}
export const LineChart = memo(LineChartInner)

/* ------------------------------ PieChart ----------------------------- */

/** Point on the circle at `angle` radians (0 = 12 o'clock, clockwise). */
const polar = (cx: number, cy: number, r: number, angle: number): [number, number] => [
  cx + r * Math.sin(angle),
  cy - r * Math.cos(angle),
]

const PieChartInner = ({
  data,
  size = 160,
  donut = false,
  className,
}: PieChartProps): JSX.Element => {
  const cx0 = size / 2
  const cy0 = size / 2
  const r = size / 2 - 4
  const total = data.reduce((acc, d) => acc + clamp(d.value), 0)
  const innerR = donut ? r * 0.55 : 0

  let angle = 0
  return (
    <svg
      data-testid="chart-pie"
      role="img"
      aria-label="pie chart"
      viewBox={`0 0 ${size} ${size}`}
      className={cx("mt-2", className)}
      width={size}
      height={size}
    >
      {total <= 0 ? (
        <circle cx={cx0} cy={cy0} r={r} fill={colorPalette.gray} fillOpacity={0.2} />
      ) : (
        data.map((d, di) => {
          const frac = clamp(d.value) / total
          const start = angle
          const end = angle + frac * Math.PI * 2
          angle = end
          const [x1, y1] = polar(cx0, cy0, r, start)
          const [x2, y2] = polar(cx0, cy0, r, end)
          const large = end - start > Math.PI ? 1 : 0
          const color = colorFor(d.tone, di)
          // A full circle (single 100% slice) cannot be drawn as an arc path
          // (start == end) — render a plain circle instead.
          if (frac >= 1) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional slices
              <circle key={di} cx={cx0} cy={cy0} r={r} fill={color} data-slice={d.label} />
            )
          }
          const outer = `M ${cx0} ${cy0} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional slices
            <path key={di} d={outer} fill={color} data-slice={d.label} />
          )
        })
      )}
      {donut && total > 0 ? <circle cx={cx0} cy={cy0} r={innerR} className="fill-surface" /> : null}
    </svg>
  )
}
export const PieChart = memo(PieChartInner)
