/**
 * A2 (rich inline) — gate-OFF byte-identity + SSR-safety guards.
 *
 * The rich layer added a default `fetchText` port + async inline viewers. These
 * guards pin the two invariants that must survive that change:
 *
 *   1. GATE-OFF byte-identity — a null / empty artifact map renders EXACTLY the
 *      empty string (the Canvas channel is OFF ⇒ the pane is byte-unchanged),
 *      even though the strip now carries a default fetch port.
 *   2. SSR never fetches — `renderToStaticMarkup` runs no effects, so the daemon-
 *      served initial HTML never triggers an artifact byte fetch; the card +
 *      download affordance still render (the client hydrates + fetches).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { ArtifactStrip } from "./ArtifactStrip"

const art = (id: string, kind: string, mime: string): ArtifactReadyMessage => ({
  kind: "artifact.ready",
  artifactId: id,
  artifactKind: kind,
  mimeType: mime,
  locator: `quanta-artifact://${id}`,
  emittedAt: 0,
})
const mapOf = (...i: ArtifactReadyMessage[]): ReadonlyMap<string, ArtifactReadyMessage> =>
  new Map(i.map((x) => [x.artifactId, x]))

describe("A2 ArtifactStrip — gate-OFF byte-identity (rich layer)", () => {
  it("renders exactly the empty string for a null map (even with the default fetch port)", () => {
    expect(renderToStaticMarkup(<ArtifactStrip artifacts={null} />)).toBe("")
  })

  it("renders exactly the empty string for an empty map", () => {
    expect(renderToStaticMarkup(<ArtifactStrip artifacts={new Map()} />)).toBe("")
  })
})

describe("A2 ArtifactStrip — SSR never fetches / never crashes", () => {
  it("does NOT invoke the fetch port during SSR of a CSV card (effects don't run)", () => {
    const fetchText = vi.fn(async () => "a,b\n1,2")
    const html = renderToStaticMarkup(
      <ArtifactStrip
        artifacts={mapOf(art("d", "spreadsheet", "text/csv"))}
        fetchText={fetchText}
      />,
    )
    expect(fetchText).not.toHaveBeenCalled()
    // the card + download affordance still render server-side.
    expect(html).toContain('data-kind="spreadsheet"')
    expect(html.toLowerCase()).toContain("download")
  })

  it("keeps the image thumbnail path and mounts no rich viewer for an image", () => {
    const html = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("i", "image", "image/png"))} />,
    )
    expect(html).toContain("<img")
    expect(html).not.toContain("artifact-csv-grid")
    expect(html).not.toContain("artifact-notebook")
  })

  it("SSR-renders the mermaid + pdf cards (lazy chunk unresolved) without crashing", () => {
    const hm = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("m", "mermaid", "text/vnd.mermaid"))} />,
    )
    const hp = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("p", "pdf", "application/pdf"))} />,
    )
    expect(hm).toContain('data-kind="mermaid"')
    expect(hp).toContain('data-kind="pdf"')
  })
})
