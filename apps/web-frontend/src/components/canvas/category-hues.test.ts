import { describe, expect, it } from "vitest"
import type { ContextUsageMessage } from "../../types/protocol"
import { breakdownToUsageBarProps, CATEGORY_TO_HUE, hueForCategory } from "./category-hues"
import { colorPalette, usageColorSequence } from "./tokens"

describe("CATEGORY_TO_HUE", () => {
  it("matches the Cursor usage-bar.d.ts:44-50 canonical mapping 1:1", () => {
    expect(CATEGORY_TO_HUE).toEqual({
      System: "gray",
      Tools: "purple",
      Rules: "green",
      Skills: "yellow",
      MCP: "pink",
      Subagents: "blue",
      Conversation: "orange",
    })
  })

  it("covers every category from CATEGORY_ORDER", () => {
    const categories = ["System", "Tools", "Rules", "Skills", "MCP", "Subagents", "Conversation"]
    for (const c of categories) {
      expect(CATEGORY_TO_HUE[c]).toBeDefined()
    }
  })
})

describe("hueForCategory", () => {
  it("returns the palette hex for a known category", () => {
    expect(hueForCategory("Tools", 0)).toBe(colorPalette.purple)
    expect(hueForCategory("Conversation", 5)).toBe(colorPalette.orange)
  })

  it("falls back to usageColorSequence rotation for an unknown id (RFC-06 fallback)", () => {
    expect(hueForCategory("WeirdUnknown", 0)).toBe(usageColorSequence[0])
    expect(hueForCategory("AlsoUnknown", 1)).toBe(usageColorSequence[1])
  })
})

const msg = (over: Partial<ContextUsageMessage> = {}): ContextUsageMessage => ({
  kind: "context.usage",
  segments: [
    { id: "System", tokens: 1000 },
    { id: "Tools", tokens: 2000 },
  ],
  total: 3000,
  max: 10000,
  emittedAt: 0,
  ...over,
})

describe("breakdownToUsageBarProps", () => {
  it("assigns each segment its category hue", () => {
    const props = breakdownToUsageBarProps(msg())
    expect(props.segments[0]?.color).toBe(colorPalette.gray) // System
    expect(props.segments[1]?.color).toBe(colorPalette.purple) // Tools
  })

  it("fills against the full window (max) and reproduces the CLI head-line labels", () => {
    const props = breakdownToUsageBarProps(msg({ total: 6400, max: 10000 }))
    expect(props.total).toBe(10000)
    expect(props.topLeftLabel).toBe("64% Full")
    // formatTokens(10000) = "10.0k" (k<100 ⇒ toFixed(1)) — CLI-verbatim.
    expect(props.topRightLabel).toBe("6.4k / 10.0k Tokens")
  })

  it("clamps non-finite / negative tokens to 0 (no NaN)", () => {
    const props = breakdownToUsageBarProps(
      msg({
        segments: [
          { id: "System", tokens: -5 },
          { id: "Tools", tokens: Number.NaN },
        ],
      }),
    )
    expect(props.segments[0]?.value).toBe(0)
    expect(props.segments[1]?.value).toBe(0)
  })

  // UUX-4-25 (jul-10 W4) — the old shape filled the bar against `total`, so an
  // UNKNOWN window rendered a visually FULL bar + "? Full": a false "context
  // exhausted" alarm. Unknown max ⇒ INDETERMINATE: no fill at all (empty
  // track), honest "window unknown" labels. (Same posture as the `/context`
  // text gauge: `asciiBar(0)` + "(window unknown)" in slash-context-gauge.ts.)
  describe("max<=0 (unknown window) ⇒ indeterminate bar, honest label (UUX-4-25)", () => {
    it("renders NO fill: zero segments against a positive track total", () => {
      const props = breakdownToUsageBarProps(msg({ total: 3000, max: 0 }))
      const filled = props.segments.reduce((a, s) => a + s.value, 0)
      expect(filled).toBe(0)
      // The track itself must still render (UsageBar remainder needs total>0).
      expect(props.total).toBeGreaterThan(0)
    })

    it("labels are honest: 'Window unknown' + used tokens, never '? Full' / a '?' max", () => {
      const props = breakdownToUsageBarProps(msg({ total: 3000, max: 0 }))
      expect(props.topLeftLabel).toBe("Window unknown")
      expect(props.topRightLabel).toBe("3.0k Tokens used")
      expect(props.topLeftLabel).not.toContain("Full")
    })

    it("negative max is the same unknown-window arm as 0", () => {
      const props = breakdownToUsageBarProps(msg({ total: 3000, max: -1 }))
      const filled = props.segments.reduce((a, s) => a + s.value, 0)
      expect(filled).toBe(0)
      expect(props.topLeftLabel).toBe("Window unknown")
    })

    it("a KNOWN window is untouched by the unknown-window arm (paired control)", () => {
      const props = breakdownToUsageBarProps(msg({ total: 6400, max: 10000 }))
      expect(props.segments.length).toBe(2)
      expect(props.topLeftLabel).toBe("64% Full")
      expect(props.topRightLabel).toBe("6.4k / 10.0k Tokens")
    })
  })
})
