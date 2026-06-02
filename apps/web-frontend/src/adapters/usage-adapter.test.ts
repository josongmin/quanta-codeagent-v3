import { describe, expect, it } from "vitest"
import type { ContextUsageMessage } from "../types/protocol"
import { formatTokens, usageMessageToBarProps, usagePercent } from "./usage-adapter"

describe("usage-adapter", () => {
  it("formatTokens matches the CLI status-line contract verbatim", () => {
    expect(formatTokens(523)).toBe("523")
    expect(formatTokens(50_000)).toBe("50.0k")
    expect(formatTokens(76_800)).toBe("76.8k")
    expect(formatTokens(120_000)).toBe("120k")
    expect(formatTokens(-5)).toBe("0")
  })

  it("usagePercent matches viewPercent (clamp 100, max<=0 ⇒ 0, never NaN)", () => {
    expect(usagePercent(76_800, 120_000)).toBe(64)
    expect(usagePercent(250_000, 200_000)).toBe(100)
    expect(usagePercent(10, 0)).toBe(0)
    expect(Number.isNaN(usagePercent(10, 0))).toBe(false)
  })

  it("preserves segment ids/values + reproduces the CLI head-line labels", () => {
    const msg: ContextUsageMessage = {
      kind: "context.usage",
      segments: [
        { id: "System", tokens: 40_000 },
        { id: "Rules", tokens: 20_000 },
        { id: "Conversation", tokens: 16_800 },
      ],
      total: 76_800,
      max: 120_000,
      model: "gpt-5",
      emittedAt: 0,
    }
    const props = usageMessageToBarProps(msg)
    expect(props.segments).toEqual([
      { id: "System", value: 40_000 },
      { id: "Rules", value: 20_000 },
      { id: "Conversation", value: 16_800 },
    ])
    // total = the FULL window so the remainder span = unused budget
    expect(props.total).toBe(120_000)
    expect(props.topLeftLabel).toBe("64% Full")
    expect(props.topRightLabel).toBe("76.8k / 120k Tokens")
    // adapter does NOT assign colors — leaves auto-rotation to the component
    expect(props.segments.every((s) => !("color" in s))).toBe(true)
  })

  it("clamps non-finite/negative segment values to 0", () => {
    const msg: ContextUsageMessage = {
      kind: "context.usage",
      segments: [
        { id: "neg", tokens: -10 },
        { id: "ok", tokens: 100 },
      ],
      total: 90,
      max: 200,
      emittedAt: 0,
    }
    const props = usageMessageToBarProps(msg)
    expect(props.segments).toEqual([
      { id: "neg", value: 0 },
      { id: "ok", value: 100 },
    ])
  })

  it("max=0 ⇒ falls back to total as the window, percent 0, no NaN", () => {
    const msg: ContextUsageMessage = {
      kind: "context.usage",
      segments: [{ id: "a", tokens: 50 }],
      total: 50,
      max: 0,
      emittedAt: 0,
    }
    const props = usageMessageToBarProps(msg)
    expect(props.total).toBe(50)
    expect(props.topLeftLabel).toBe("0% Full")
    expect(props.topRightLabel).not.toContain("NaN")
  })
})
