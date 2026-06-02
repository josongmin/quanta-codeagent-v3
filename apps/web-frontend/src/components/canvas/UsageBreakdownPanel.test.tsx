import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ContextUsageMessage } from "../../types/protocol"
import { colorPalette } from "./tokens"
import { UsageBreakdownPanel } from "./UsageBreakdownPanel"

const usage = (over: Partial<ContextUsageMessage> = {}): ContextUsageMessage => ({
  kind: "context.usage",
  segments: [
    { id: "System", tokens: 1000, chars: 4000 },
    { id: "Tools", tokens: 2000, chars: 8000 },
    { id: "Conversation", tokens: 3000, chars: 12000 },
  ],
  total: 6000,
  max: 10000,
  emittedAt: 0,
  ...over,
})

describe("UsageBreakdownPanel", () => {
  it("renders nothing when usage is null (default-OFF)", () => {
    const html = renderToStaticMarkup(<UsageBreakdownPanel usage={null} />)
    expect(html).toBe("")
  })

  it("renders the bar + one legend swatch per category, colored from the palette", () => {
    const html = renderToStaticMarkup(<UsageBreakdownPanel usage={usage()} />)
    // one Swatch per category, each its CATEGORY_TO_HUE color
    expect(html).toContain('data-swatch-color="gray"') // System
    expect(html).toContain('data-swatch-color="purple"') // Tools
    expect(html).toContain('data-swatch-color="orange"') // Conversation
    // the bar paints the same hues (coherence)
    expect(html).toContain(`background:${colorPalette.gray}`)
    expect(html).toContain(`background:${colorPalette.purple}`)
  })

  it("shows tokens, chars, and % in each category's trailing readout", () => {
    const html = renderToStaticMarkup(<UsageBreakdownPanel usage={usage()} />)
    // System: 1000 tokens, 4000 chars, share = 1000/6000 = 17%
    expect(html).toContain("1.0k")
    expect(html).toContain("4.0kch")
    expect(html).toContain("17%")
  })

  it("omits the chars readout gracefully when the optional wire field is absent", () => {
    const noChars = usage({
      segments: [{ id: "System", tokens: 1000 }],
    })
    const html = renderToStaticMarkup(<UsageBreakdownPanel usage={noChars} />)
    expect(html).not.toContain("ch ·")
    expect(html).not.toContain("undefined")
  })

  it("max=0 (unknown window) ⇒ left label degrades to '?' (no false 0% Full)", () => {
    const html = renderToStaticMarkup(
      <UsageBreakdownPanel usage={usage({ total: 5000, max: 0 })} />,
    )
    expect(html).toContain("? Full")
    expect(html).not.toContain("0% Full")
  })

  it("empty segments ⇒ header + bar only, no legend rows (non-throwing)", () => {
    const html = renderToStaticMarkup(
      <UsageBreakdownPanel usage={usage({ segments: [], total: 0, max: 10000 })} />,
    )
    expect(html).toContain("Context usage")
    expect(html).not.toContain("data-swatch-color")
  })

  it("legend rows start CLOSED (drilldown body not in initial markup)", () => {
    const html = renderToStaticMarkup(<UsageBreakdownPanel usage={usage()} />)
    // CollapsibleSection closed-default: the per-category <dl> body is not yet rendered
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("<dl")
  })
})
