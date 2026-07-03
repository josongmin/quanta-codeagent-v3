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

describe("formatSegmentedUsage — codex-rs `% context left` head (S3 polish)", () => {
  test("head renders `Context N% left` (remaining, not used) matching codex-rs", () => {
    // 60k of 200k used ⇒ 30% used ⇒ 70% LEFT.
    const head = formatSegmentedUsage(base).split("\n")[0] ?? ""
    expect(head).toContain("Context 70% left")
    // The used/max token counter is preserved for the legend context.
    expect(head).toContain("60.0k/200k")
  })

  test("a fresh window is `100% left`, a full window is `0% left`", () => {
    const fresh = formatSegmentedUsage({
      ...base,
      segments: [{ id: "System", tokens: 0 }],
      total: 0,
    })
    expect(fresh.split("\n")[0] ?? "").toContain("Context 100% left")
    const full = formatSegmentedUsage({
      ...base,
      segments: [{ id: "System", tokens: 200_000 }],
      total: 200_000,
    })
    expect(full.split("\n")[0] ?? "").toContain("Context 0% left")
  })

  test("renders the codex `N tokens left in this context window` annotation", () => {
    // 200k − 60k = 140k left.
    const out = formatSegmentedUsage(base)
    expect(out).toContain("140k tokens left in this context window")
  })
})
