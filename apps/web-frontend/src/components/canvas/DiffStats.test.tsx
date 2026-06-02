import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DiffStats } from "./DiffStats"

describe("DiffStats", () => {
  it("renders null when both counts are zero (Cursor contract)", () => {
    expect(renderToStaticMarkup(<DiffStats additions={0} deletions={0} />)).toBe("")
    expect(renderToStaticMarkup(<DiffStats />)).toBe("")
  })

  it("renders +N / -N glyphs with tabular-nums", () => {
    const html = renderToStaticMarkup(<DiffStats additions={5} deletions={2} />)
    expect(html).toContain("+5")
    expect(html).toContain("-2")
    expect(html).toContain("tabular-nums")
    expect(html).toContain('aria-label="5 additions, 2 deletions"')
  })

  it("omits the zero side", () => {
    const onlyAdds = renderToStaticMarkup(<DiffStats additions={3} deletions={0} />)
    expect(onlyAdds).toContain("+3")
    expect(onlyAdds).not.toContain("-0")
  })
})
