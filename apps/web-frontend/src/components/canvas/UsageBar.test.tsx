import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { usageColorSequence, usageRemainderColor } from "./tokens"
import { UsageBar } from "./UsageBar"

describe("UsageBar", () => {
  it("renders proportional segment widths that match value/total", () => {
    const html = renderToStaticMarkup(
      <UsageBar
        segments={[
          { id: "System", value: 25 },
          { id: "Conversation", value: 25 },
        ]}
        total={100}
      />,
    )
    // each segment = 25/100 = 25%; remainder = 50/100 = 50%
    expect(html).toContain("width:25%")
    expect(html).toContain("width:50%")
  })

  it("auto-rotates usageColorSequence when a segment omits its color", () => {
    const html = renderToStaticMarkup(
      <UsageBar
        segments={[
          { id: "a", value: 10 },
          { id: "b", value: 10 },
        ]}
        total={100}
      />,
    )
    expect(html).toContain(usageColorSequence[0] as string)
    expect(html).toContain(usageColorSequence[1] as string)
  })

  it("renders the remainder span when segments do not fill the window", () => {
    const html = renderToStaticMarkup(<UsageBar segments={[{ id: "a", value: 10 }]} total={100} />)
    expect(html).toContain(usageRemainderColor)
    // remainder = 90%
    expect(html).toContain("width:90%")
  })

  it("clamps non-finite / negative values to 0 (no NaN)", () => {
    const html = renderToStaticMarkup(
      <UsageBar
        segments={[
          { id: "neg", value: -5 },
          { id: "nan", value: Number.NaN },
          { id: "ok", value: 50 },
        ]}
        total={100}
      />,
    )
    expect(html).not.toContain("NaN")
    // only the valid 50% segment renders + remainder 50%
    expect(html).toContain("width:50%")
  })

  it("total<=0 ⇒ no NaN, remainder fills 100% (no segment widths)", () => {
    const html = renderToStaticMarkup(<UsageBar segments={[{ id: "a", value: 10 }]} total={0} />)
    expect(html).not.toContain("NaN")
  })

  it("renders top-left / top-right labels + aria summary", () => {
    const html = renderToStaticMarkup(
      <UsageBar
        segments={[{ id: "a", value: 50 }]}
        total={100}
        topLeftLabel="50% Full"
        topRightLabel="50 / 100 Tokens"
      />,
    )
    expect(html).toContain("50% Full")
    expect(html).toContain("50 / 100 Tokens")
    expect(html).toContain('aria-label="context usage: 50% Full, 50 / 100 Tokens"')
  })
})
