/**
 * TDD — S3 (jul-03): the `/context` segmented gauge surfaces the reasoning-token
 * split as a distinct annotation.
 *
 * Reasoning tokens are OUTPUT-side (the provider billed them as part of the
 * response), NOT input-context. Folding them into a bar SEGMENT would inflate
 * the input-context window total and misrepresent the gauge. So the reasoning
 * count rides `SegmentedUsageView.reasoningTokens?` (optional ⇒ absent for
 * providers with no split, e.g. Anthropic) and is rendered as a SEPARATE legend
 * annotation — visible, but never summed into `total` and never a bar cell.
 */
import { describe, expect, test } from "bun:test"
import { formatSegmentedUsage, type SegmentedUsageView } from "./status-line"

const base: SegmentedUsageView = {
  segments: [
    { id: "System", tokens: 40_000 },
    { id: "Conversation", tokens: 20_000 },
  ],
  total: 60_000,
  max: 200_000,
  model: "gpt-5",
}

describe("formatSegmentedUsage — reasoning annotation (S3)", () => {
  test("renders a Reasoning annotation line when reasoningTokens is present", () => {
    const out = formatSegmentedUsage({ ...base, reasoningTokens: 12_000 })
    expect(out).toContain("Reasoning")
    // The count is surfaced (12.0k via the shared token formatter).
    expect(out).toContain("12.0k")
  })

  test("does NOT add reasoning to the context-window total or bar", () => {
    const withReasoning = formatSegmentedUsage({ ...base, reasoningTokens: 50_000 })
    const withoutReasoning = formatSegmentedUsage(base)
    const headOf = (s: string): string => s.split("\n")[0] ?? ""
    // The bar + total header line is byte-identical whether or not reasoning is
    // present — reasoning is an annotation, not part of the window accounting.
    expect(headOf(withReasoning)).toBe(headOf(withoutReasoning))
  })

  test("omits the annotation entirely when reasoningTokens is absent (byte-identical)", () => {
    const out = formatSegmentedUsage(base)
    expect(out).not.toContain("Reasoning")
  })

  test("omits the annotation when reasoningTokens is 0 (no output reasoning ⇒ nothing to show)", () => {
    const out = formatSegmentedUsage({ ...base, reasoningTokens: 0 })
    expect(out).not.toContain("Reasoning")
  })
})
