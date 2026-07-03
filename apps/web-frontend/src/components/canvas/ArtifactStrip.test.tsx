/**
 * A2 — ArtifactStrip render + gate-OFF parity tests (node env, static markup —
 * mirrors `UsageBar.test.tsx` `renderToStaticMarkup` approach).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ArtifactReadyMessage } from "../../types/protocol"
import { colorPalette } from "./tokens"
import { ArtifactStrip, artifactKindHue } from "./ArtifactStrip"

const art = (
  id: string,
  kind: string,
  mime: string,
  name?: string,
): ArtifactReadyMessage => ({
  kind: "artifact.ready",
  artifactId: id,
  artifactKind: kind,
  mimeType: mime,
  locator: `quanta-artifact://${id}`,
  ...(name !== undefined ? { name } : {}),
  emittedAt: 0,
})

const mapOf = (...items: ArtifactReadyMessage[]): ReadonlyMap<string, ArtifactReadyMessage> =>
  new Map(items.map((i) => [i.artifactId, i]))

describe("A2 ArtifactStrip (gate-OFF parity)", () => {
  it("renders nothing for a null map (channel OFF ⇒ byte-identical)", () => {
    expect(renderToStaticMarkup(<ArtifactStrip artifacts={null} />)).toBe("")
  })

  it("renders nothing for an empty map (no artifact registered yet)", () => {
    expect(renderToStaticMarkup(<ArtifactStrip artifacts={new Map()} />)).toBe("")
  })
})

describe("A2 ArtifactStrip render", () => {
  it("renders an inline thumbnail + preview href for an image artifact", () => {
    const html = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("a1", "image", "image/png", "shot.png"))} />,
    )
    expect(html).toContain("artifact-strip")
    expect(html).toContain("<img")
    // preview URL routed to the daemon /artifact/<id> route.
    expect(html).toContain("/artifact/a1")
    expect(html).toContain("shot.png")
    // download affordance present.
    expect(html.toLowerCase()).toContain("download")
  })

  it("renders a labeled card + kind badge (no <img>) for a document artifact", () => {
    const html = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("d1", "spreadsheet", "text/csv", "data.csv"))} />,
    )
    expect(html).toContain('data-kind="spreadsheet"')
    expect(html).toContain("spreadsheet") // badge label
    expect(html).not.toContain("<img")
    expect(html).toContain("/artifact/d1") // download link
  })

  it("degrades an UNKNOWN kind to the base card (never renders nothing)", () => {
    const html = renderToStaticMarkup(
      <ArtifactStrip artifacts={mapOf(art("u1", "hologram", "application/x-weird"))} />,
    )
    expect(html).toContain('data-kind="hologram"')
    expect(html).toContain("artifact-card")
    // unknown ⇒ gray badge hue (from the shared palette).
    expect(html).toContain(colorPalette.gray)
  })

  it("shows an 'unavailable' marker + no fetch when the locator is malformed", () => {
    const bad = { ...art("x", "image", "image/png"), locator: "file:///etc/passwd" }
    const html = renderToStaticMarkup(<ArtifactStrip artifacts={mapOf(bad)} />)
    expect(html).toContain("unavailable")
    expect(html).not.toContain("/etc/passwd")
  })

  it("maps every declared kind to a distinct palette hue (badge coherence)", () => {
    expect(artifactKindHue("image")).toBe("blue")
    expect(artifactKindHue("pdf")).toBe("pink")
    expect(artifactKindHue("presentation")).toBe("orange")
    expect(artifactKindHue("anything-else")).toBe("gray")
  })
})
