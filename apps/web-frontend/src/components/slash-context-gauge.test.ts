/**
 * S3 — `/context` live gauge text renderer (pure, node env).
 *
 * Proves: null usage ⇒ null (caller falls back to the stub, byte-identical);
 * a live frame ⇒ a segmented gauge whose numbers reuse the CLI-verbatim
 * `usage-adapter` helpers; the reasoning-token split is surfaced explicitly.
 */

import { describe, expect, it } from "vitest"
import type { ContextUsageMessage } from "../types/protocol"
import { renderContextGauge } from "./slash-context-gauge"

const usage = (
  segments: { id: string; tokens: number }[],
  total: number,
  max: number,
  model?: string,
): ContextUsageMessage => ({
  kind: "context.usage",
  segments,
  total,
  max,
  ...(model !== undefined ? { model } : {}),
  emittedAt: 0,
})

describe("S3 renderContextGauge", () => {
  it("returns null when there is no usage frame (fallback to the stub)", () => {
    expect(renderContextGauge(null)).toBeNull()
  })

  it("renders the percent-full header + a proportional bar", () => {
    const out = renderContextGauge(
      usage([{ id: "Conversation", tokens: 30_000 }], 60_000, 120_000),
    )
    expect(out).not.toBeNull()
    // 60k / 120k = 50% full.
    expect(out).toContain("50% full")
    expect(out).toContain("60.0k / 120k tokens")
    // proportional ascii bar present.
    expect(out).toContain("[")
    expect(out).toContain("=")
  })

  it("lists each segment with its share of the spent total", () => {
    const out = renderContextGauge(
      usage(
        [
          { id: "System", tokens: 25_000 },
          { id: "Conversation", tokens: 75_000 },
        ],
        100_000,
        200_000,
      ),
    )
    expect(out).toContain("System")
    expect(out).toContain("Conversation")
    // 75k / 100k spent = 75%.
    expect(out).toContain("75%")
  })

  it("surfaces the reasoning-token split explicitly", () => {
    const out = renderContextGauge(
      usage(
        [
          { id: "Conversation", tokens: 40_000 },
          { id: "Reasoning", tokens: 10_000 },
        ],
        50_000,
        100_000,
      ),
    )
    expect(out).toContain("reasoning:")
    expect(out).toContain("10.0k")
  })

  it("omits the reasoning line when no reasoning segment is present", () => {
    const out = renderContextGauge(usage([{ id: "System", tokens: 10 }], 10, 100))
    expect(out).not.toContain("reasoning:")
  })

  it("degrades to a token-only header when the window is unknown (max<=0)", () => {
    const out = renderContextGauge(usage([{ id: "System", tokens: 500 }], 500, 0))
    expect(out).toContain("window unknown")
    expect(out).not.toContain("% full")
  })

  it("includes the model line when the frame carries a model slug", () => {
    const out = renderContextGauge(usage([], 10, 100, "gpt-5"))
    expect(out).toContain("model: gpt-5")
  })
})
