import { describe, expect, test } from "bun:test"
import {
  breakdownPercent,
  buildUsageBreakdownDefault,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"

/**
 * OC-5 / BUG-2. `snapshotToBreakdownInput` used to pass ONLY `snap.system`, so a
 * 50k-char system prompt rendered "94% left" no matter how long the transcript
 * grew, and the pre-compaction warning (built on the same total) never fired. The
 * snapshot now carries the conversation transcript's own token/char counts.
 */
const snap = (over: Partial<PromptAssembledSnapshot> = {}): PromptAssembledSnapshot => ({
  system: [{ type: "text", text: "x".repeat(50_000) }],
  layout: "single_block",
  repoRulesPresent: false,
  sessionCtxPresent: false,
  userAppendPresent: false,
  max: 200_000,
  ...over,
})

describe("context usage includes the conversation transcript (OC-5/BUG-2)", () => {
  test("RED baseline: without conversation fields, total is system-only (the old bug)", () => {
    const b = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap()))
    // 50k chars / 4 ≈ 12.5k tokens of 200k ⇒ ~6% used regardless of dialogue.
    expect(b.segments.some((s) => s.id === "Conversation")).toBe(false)
    expect(b.total).toBeLessThan(15_000)
  })

  test("a large transcript now dominates the total and a Conversation segment appears", () => {
    // 600k tokens of conversation (a long session) — must swamp the 12.5k system.
    const b = buildUsageBreakdownDefault(
      snapshotToBreakdownInput(snap({ conversationTokens: 600_000, conversationChars: 2_400_000 })),
    )
    const conv = b.segments.find((s) => s.id === "Conversation")
    expect(conv?.tokens).toBe(600_000)
    expect(b.total).toBeGreaterThan(600_000)
    // and the gauge now reflects an over-full window instead of "94% left".
    expect(breakdownPercent(b)).toBe(100)
  })

  test("the total is the sum of system + conversation (no double count, no drop)", () => {
    const withConv = buildUsageBreakdownDefault(
      snapshotToBreakdownInput(snap({ conversationTokens: 1_000, conversationChars: 4_000 })),
    )
    const systemOnly = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap()))
    expect(withConv.total).toBe(systemOnly.total + 1_000)
  })

  test("absent/zero conversation ⇒ back-compat (no Conversation segment, byte-identical total)", () => {
    const zero = buildUsageBreakdownDefault(
      snapshotToBreakdownInput(snap({ conversationTokens: 0 })),
    )
    const absent = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap()))
    expect(zero.total).toBe(absent.total)
    expect(zero.segments.some((s) => s.id === "Conversation")).toBe(false)
  })
})
