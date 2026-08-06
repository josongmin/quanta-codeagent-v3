/**
 * RFC-12 (deferred) SURFACE C — LAZY chart artifact renderer.
 *
 * This module + `ChartPrimitives` are pulled in by `ArtifactStrip` via
 * `lazy(() => import("./ChartArtifact"))`, so the chart SVG code stays BEHIND
 * the async boundary and is fetched only when a `chart` artifact actually
 * renders — never on first paint (same lazy pattern as `MermaidDiagram` /
 * `PdfPreview`).
 *
 * The chart spec arrives as JSON text via the injected `fetchText` port; it is
 * parsed by the pure `parseChart` (artifact-parse.ts) into a discriminated
 * `ChartSpec` and dispatched to the matching primitive. A fetch failure or a
 * malformed / unknown spec degrades to `null` (⇒ the parent `ArtifactCard`
 * keeps its base download link) — never a crash, never nothing.
 */

import { memo, useEffect, useReducer } from "react"
import type { FetchText } from "./artifact-fetch"
import { type ChartSpec, parseChart } from "./artifact-parse"
import { BarChart, LineChart, PieChart } from "./ChartPrimitives"

export interface ChartArtifactProps {
  readonly url: string
  readonly fetchText: FetchText
}

type State = { status: "loading" } | { status: "ready"; text: string } | { status: "failed" }

type Action = { type: "ready"; text: string } | { type: "fail" }

const reducer = (_s: State, a: Action): State =>
  a.type === "ready" ? { status: "ready", text: a.text } : { status: "failed" }

/** Dispatch a parsed spec to its primitive. Pure — exported so the render SHAPE
 *  is unit-testable without a fetch (data-in → SVG-out). */
export const ChartFromSpec = memo(({ spec }: { spec: ChartSpec }): JSX.Element => {
  switch (spec.type) {
    case "bar":
      return (
        <BarChart
          categories={spec.categories}
          series={spec.series}
          {...(spec.stacked !== undefined ? { stacked: spec.stacked } : {})}
          {...(spec.valueSuffix !== undefined ? { valueSuffix: spec.valueSuffix } : {})}
        />
      )
    case "line":
      return (
        <LineChart
          categories={spec.categories}
          series={spec.series}
          {...(spec.fill !== undefined ? { fill: spec.fill } : {})}
          {...(spec.valueSuffix !== undefined ? { valueSuffix: spec.valueSuffix } : {})}
        />
      )
    case "pie":
      return (
        <PieChart data={spec.data} {...(spec.donut !== undefined ? { donut: spec.donut } : {})} />
      )
  }
})

const ChartArtifactInner = ({ url, fetchText }: ChartArtifactProps): JSX.Element | null => {
  const [state, dispatch] = useReducer(reducer, { status: "loading" })
  useEffect(() => {
    let alive = true
    fetchText(url)
      .then((text) => {
        if (alive) dispatch({ type: "ready", text })
      })
      .catch(() => {
        if (alive) dispatch({ type: "fail" })
      })
    return () => {
      alive = false
    }
  }, [url, fetchText])

  if (state.status === "loading") {
    return <p className="mt-2 text-[11px] text-ink-tertiary italic">Loading chart…</p>
  }
  if (state.status === "failed") return null
  const spec = parseChart(state.text)
  if (spec === null) return null
  return <ChartFromSpec spec={spec} />
}

export const ChartArtifact = memo(ChartArtifactInner)
export default ChartArtifact
