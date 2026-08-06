/**
 * RFC-12 (deferred) SURFACE C — chart primitives + artifact routing.
 *
 * `node` env, static markup (same idiom as CsvGrid/NotebookView). Covers:
 *   - the three primitives' render SHAPE (SVG element + bars/polyline/slices,
 *     tokens.ts colors, tone mapping);
 *   - `parseChart` (JSON → discriminated ChartSpec, degrade to null);
 *   - `ChartFromSpec` dispatch (bar/line/pie);
 *   - the ArtifactStrip gate: `pickInlineRenderer` routes a `chart` artifact to
 *     "chart" ONLY when the gate flag is on (default-OFF ⇒ null = base card).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { ArtifactStrip, pickInlineRenderer } from "./ArtifactStrip"
import { parseChart } from "./artifact-parse"
import { ChartFromSpec } from "./ChartArtifact"
import { BarChart, LineChart, PieChart } from "./ChartPrimitives"
import { colorPalette } from "./tokens"

describe("ChartPrimitives — BarChart render shape", () => {
  it("renders an SVG with one <rect> per (category × series) bar", () => {
    const html = renderToStaticMarkup(
      <BarChart
        categories={["Mon", "Tue", "Wed"]}
        series={[{ name: "Requests", data: [120, 90, 150] }]}
      />,
    )
    expect(html).toContain('data-testid="chart-bar"')
    expect(html).toContain("<svg")
    // 3 categories × 1 series = 3 bars
    expect(html.split("<rect").length - 1).toBe(3)
    expect(html).toContain('data-category="Mon"')
  })

  it("maps a tone to the shared palette hue (success ⇒ green)", () => {
    const html = renderToStaticMarkup(
      <BarChart categories={["a"]} series={[{ name: "ok", data: [10], tone: "success" }]} />,
    )
    expect(html).toContain(colorPalette.green)
  })

  it("stacks series when stacked", () => {
    const html = renderToStaticMarkup(
      <BarChart
        categories={["a", "b"]}
        series={[
          { name: "x", data: [10, 20] },
          { name: "y", data: [5, 5] },
        ]}
        stacked
      />,
    )
    // 2 categories × 2 series = 4 rects, both stacked columns present
    expect(html.split("<rect").length - 1).toBe(4)
  })
})

describe("ChartPrimitives — LineChart render shape", () => {
  it("renders a polyline per series with dot markers", () => {
    const html = renderToStaticMarkup(
      <LineChart categories={["Jan", "Feb", "Mar"]} series={[{ name: "rev", data: [1, 2, 3] }]} />,
    )
    expect(html).toContain('data-testid="chart-line"')
    expect(html).toContain("<polyline")
    // 3 points ⇒ 3 circles
    expect(html.split("<circle").length - 1).toBe(3)
  })

  it("adds an area polygon when fill", () => {
    const noFill = renderToStaticMarkup(
      <LineChart categories={["a", "b"]} series={[{ name: "s", data: [1, 2] }]} />,
    )
    const withFill = renderToStaticMarkup(
      <LineChart categories={["a", "b"]} series={[{ name: "s", data: [1, 2] }]} fill />,
    )
    expect(noFill).not.toContain("<polygon")
    expect(withFill).toContain("<polygon")
  })
})

describe("ChartPrimitives — PieChart render shape", () => {
  it("renders one <path> slice per data point", () => {
    const html = renderToStaticMarkup(
      <PieChart
        data={[
          { label: "IDE", value: 120 },
          { label: "CLI", value: 30 },
          { label: "Cloud", value: 50 },
        ]}
      />,
    )
    expect(html).toContain('data-testid="chart-pie"')
    expect(html.split("<path").length - 1).toBe(3)
    expect(html).toContain('data-slice="IDE"')
  })

  it("renders a full circle for a single 100% slice (no degenerate arc)", () => {
    const html = renderToStaticMarkup(<PieChart data={[{ label: "only", value: 1 }]} />)
    // single slice ⇒ a plain circle, not a path
    expect(html).toContain('data-slice="only"')
    expect(html).not.toContain("NaN")
  })
})

describe("parseChart — JSON → ChartSpec", () => {
  it("parses a bar spec", () => {
    const spec = parseChart(
      JSON.stringify({ type: "bar", categories: ["a"], series: [{ name: "s", data: [1] }] }),
    )
    expect(spec?.type).toBe("bar")
  })

  it("parses a pie spec", () => {
    const spec = parseChart(JSON.stringify({ type: "pie", data: [{ label: "x", value: 5 }] }))
    expect(spec?.type).toBe("pie")
  })

  it("returns null for non-JSON / unknown type / missing arrays", () => {
    expect(parseChart("{not json")).toBeNull()
    expect(parseChart(JSON.stringify({ type: "scatter" }))).toBeNull()
    expect(parseChart(JSON.stringify({ type: "bar", categories: ["a"] }))).toBeNull()
    expect(parseChart(JSON.stringify({ type: "pie", data: [] }))).toBeNull()
  })
})

describe("ChartFromSpec — dispatch by spec.type", () => {
  it("dispatches bar/line/pie to the right primitive", () => {
    const bar = renderToStaticMarkup(
      <ChartFromSpec
        spec={{ type: "bar", categories: ["a"], series: [{ name: "s", data: [1] }] }}
      />,
    )
    const line = renderToStaticMarkup(
      <ChartFromSpec
        spec={{ type: "line", categories: ["a"], series: [{ name: "s", data: [1] }] }}
      />,
    )
    const pie = renderToStaticMarkup(
      <ChartFromSpec spec={{ type: "pie", data: [{ label: "x", value: 5 }] }} />,
    )
    expect(bar).toContain('data-testid="chart-bar"')
    expect(line).toContain('data-testid="chart-line"')
    expect(pie).toContain('data-testid="chart-pie"')
  })
})

const chartArt: ArtifactReadyMessage = {
  kind: "artifact.ready",
  artifactId: "c1",
  artifactKind: "chart",
  mimeType: "application/vnd.quanta.chart+json",
  locator: "quanta-artifact://c1",
  emittedAt: 0,
}

describe("pickInlineRenderer — SURFACE C gate (default-OFF)", () => {
  it("routes a chart artifact to null when the gate is OFF (base card)", () => {
    expect(pickInlineRenderer(chartArt)).toBeNull()
    expect(pickInlineRenderer(chartArt, false)).toBeNull()
  })

  it("routes a chart artifact to 'chart' when the gate is ON", () => {
    expect(pickInlineRenderer(chartArt, true)).toBe("chart")
    // mime-based match also works when kind is generic
    expect(pickInlineRenderer({ ...chartArt, artifactKind: "unknown" }, true)).toBe("chart")
  })

  it("never affects the existing non-chart routes", () => {
    const csv: ArtifactReadyMessage = {
      ...chartArt,
      artifactKind: "spreadsheet",
      mimeType: "text/csv",
    }
    expect(pickInlineRenderer(csv, true)).toBe("csv")
    expect(pickInlineRenderer(csv, false)).toBe("csv")
  })
})

describe("ArtifactStrip — SURFACE C gate-OFF byte-identity (SSR)", () => {
  const mapOf = (m: ArtifactReadyMessage): ReadonlyMap<string, ArtifactReadyMessage> =>
    new Map([[m.artifactId, m]])

  it("renders the base chart card with a download link and NO chart SVG (gate default-OFF)", () => {
    // VITE_QUANTA_CHART is unset in the test env ⇒ gate OFF ⇒ base card only.
    const html = renderToStaticMarkup(<ArtifactStrip artifacts={mapOf(chartArt)} />)
    expect(html).toContain('data-kind="chart"')
    expect(html.toLowerCase()).toContain("download")
    // No inline chart is mounted when the gate is OFF.
    expect(html).not.toContain('data-testid="chart-bar"')
    expect(html).not.toContain('data-testid="chart-line"')
    expect(html).not.toContain('data-testid="chart-pie"')
    expect(html).not.toContain("Loading chart")
  })
})
