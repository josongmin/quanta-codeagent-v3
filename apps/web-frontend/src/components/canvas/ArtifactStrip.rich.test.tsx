/**
 * A2 (rich inline) — per-kind INLINE renderer tests (node env, static markup —
 * same idiom as `ArtifactStrip.test.tsx` / `UsageBar.test.tsx`).
 *
 * The suite runs in the `node` env (no DOM, no `fetch`, no canvas). So the rich
 * layer is split into pure, synchronously-renderable pieces:
 *
 *   - `pickInlineRenderer(msg)` — the DECISION (kind → which inline renderer, or
 *     `null` for the plain card). Pure, unit-tested directly.
 *   - `CsvGrid({ table })` / `NotebookView({ cells })` — DATA-in components
 *     (already-parsed model → markup). Rendered via `renderToStaticMarkup`, so
 *     the render SHAPE (grid rows, cells, escaping, bounding) is asserted with
 *     no network and no effect.
 *
 * The fetch+parse ORCHESTRATION (the injected `fetchText` port feeding the
 * parser) is covered by the parser tests (`artifact-parse.test.ts`) plus the
 * port default test (`artifact-fetch.test.ts`); here we pin the decision + the
 * DOM-free render shape.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { CsvGrid, NotebookView, pickInlineRenderer } from "./ArtifactStrip"
import { parseCsv, parseNotebook } from "./artifact-parse"

const art = (id: string, kind: string, mime: string): ArtifactReadyMessage => ({
  kind: "artifact.ready",
  artifactId: id,
  artifactKind: kind,
  mimeType: mime,
  locator: `quanta-artifact://${id}`,
  emittedAt: 0,
})

describe("pickInlineRenderer — the per-kind DECISION", () => {
  it("routes spreadsheet/csv to the csv grid", () => {
    expect(pickInlineRenderer(art("d", "spreadsheet", "text/csv"))).toBe("csv")
    expect(pickInlineRenderer(art("d", "document", "text/csv"))).toBe("csv")
    expect(pickInlineRenderer(art("d", "unknown", "application/csv"))).toBe("csv")
  })

  it("routes notebook / .ipynb to the notebook view", () => {
    expect(pickInlineRenderer(art("n", "notebook", "application/x-ipynb+json"))).toBe("notebook")
    expect(pickInlineRenderer(art("n", "unknown", "application/json+ipynb"))).toBe("notebook")
  })

  it("routes mermaid to the (lazy) mermaid renderer", () => {
    expect(pickInlineRenderer(art("m", "mermaid", "text/vnd.mermaid"))).toBe("mermaid")
  })

  it("routes pdf to the (lazy) pdf renderer", () => {
    expect(pickInlineRenderer(art("p", "pdf", "application/pdf"))).toBe("pdf")
  })

  it("returns null (plain card) for an image or an unknown/other kind", () => {
    expect(pickInlineRenderer(art("i", "image", "image/png"))).toBeNull()
    expect(pickInlineRenderer(art("z", "hologram", "application/x-weird"))).toBeNull()
    expect(pickInlineRenderer(art("z", "presentation", "application/vnd.ms-powerpoint"))).toBeNull()
  })
})

describe("CsvGrid — render shape", () => {
  it("renders a table with a header row and one body row per data row", () => {
    const table = parseCsv("a,b,c\n1,2,3\n4,5,6")!
    const html = renderToStaticMarkup(<CsvGrid table={table} />)
    expect(html).toContain('data-testid="artifact-csv-grid"')
    expect(html).toContain("<thead")
    // three header cells + two body rows. `<th[ >]` avoids matching `<thead`.
    expect((html.match(/<th[ >]/g) ?? []).length).toBe(3)
    expect((html.match(/<tr[ >]/g) ?? []).length).toBe(3) // 1 header + 2 body
    expect(html).toContain("<td")
  })

  it("caps rows and shows a '+N more rows' footer for a huge table", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [String(i), "x"])
    const table = { header: ["n", "v"], rows }
    const html = renderToStaticMarkup(<CsvGrid table={table} />)
    // far fewer than 5000 body rows in the markup (bounded).
    expect((html.match(/<tr/g) ?? []).length).toBeLessThan(500)
    expect(html).toMatch(/more row/i)
  })

  it("ESCAPES cell content (no live <img>/<script> from a hostile cell)", () => {
    const table = {
      header: ["col"],
      rows: [["<img src=x onerror=alert(1)>"], ["<script>bad()</script>"]],
    }
    const html = renderToStaticMarkup(<CsvGrid table={table} />)
    // React escapes text nodes: the raw tags appear as entities, not live nodes
    // inside a <td>.
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<script>bad()")
    expect(html).toContain("&lt;img src=x")
  })
})

describe("NotebookView — render shape", () => {
  const nb = JSON.stringify({
    nbformat: 4,
    cells: [
      { cell_type: "markdown", source: "# Title" },
      {
        cell_type: "code",
        execution_count: 1,
        source: "print('hello')",
        outputs: [{ output_type: "stream", name: "stdout", text: "hello\n" }],
      },
    ],
  })

  it("renders one block per cell (code source + its output)", () => {
    const cells = parseNotebook(nb)!
    const html = renderToStaticMarkup(<NotebookView cells={cells} />)
    expect(html).toContain('data-testid="artifact-notebook"')
    expect((html.match(/data-cell/g) ?? []).length).toBe(2)
    expect(html).toContain("print(&#x27;hello&#x27;)")
    expect(html).toContain("hello")
  })

  it("ESCAPES output text (hostile notebook output does not execute)", () => {
    const cells = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "x",
            outputs: [{ output_type: "stream", name: "stdout", text: "<script>alert(1)</script>" }],
          },
        ],
      }),
    )!
    const html = renderToStaticMarkup(<NotebookView cells={cells} />)
    expect(html).not.toContain("<script>alert(1)")
    expect(html).toContain("&lt;script&gt;")
  })

  it("renders an image output as an <img data-uri>, not raw base64 text", () => {
    const cells = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "",
            outputs: [{ output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } }],
          },
        ],
      }),
    )!
    const html = renderToStaticMarkup(<NotebookView cells={cells} />)
    expect(html).toContain("data:image/png;base64,iVBORw0KGgo=")
    expect(html).toContain("<img")
  })
})
