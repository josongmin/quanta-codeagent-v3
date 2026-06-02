import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Swatch } from "./Swatch"
import { colorPalette, type PaletteColor } from "./tokens"

describe("Swatch", () => {
  it("renders the background hex straight from the shared palette", () => {
    const html = renderToStaticMarkup(<Swatch color="purple" />)
    expect(html).toContain(`background:${colorPalette.purple}`)
    expect(html).toContain('data-swatch-color="purple"')
  })

  it("uses the SAME hex a UsageBar segment would for the same color (coherence)", () => {
    // swatch.d.ts:22-23 contract: a category's swatch + its UsageBar segment for
    // the same `color` must be the same hue. Both read colorPalette[color].
    const colors: PaletteColor[] = ["gray", "purple", "green", "yellow", "pink", "blue", "orange"]
    for (const c of colors) {
      const html = renderToStaticMarkup(<Swatch color={c} />)
      expect(html).toContain(`background:${colorPalette[c]}`)
    }
  })

  it("is aria-hidden (the category text is the a11y signal, not the color)", () => {
    const html = renderToStaticMarkup(<Swatch color="green" />)
    expect(html).toContain('aria-hidden="true"')
  })

  it("forwards a className and merges an inline style", () => {
    const html = renderToStaticMarkup(
      <Swatch color="blue" className="extra-class" style={{ opacity: 0.5 }} />,
    )
    expect(html).toContain("extra-class")
    expect(html).toContain("opacity:0.5")
  })
})
