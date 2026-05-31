/**
 * Track D hellgate — segmented context-window usage breakdown.
 *
 * Pins: per-category tokens are MEASURED by the loop's OWN estimator
 * (`estimateTokens` from `@/agent/compaction`, reused verbatim — no second
 * heuristic); total = sum of segments; empty categories omitted; section→category
 * mapping is the co-located SSOT; extras feed Tools/MCP/etc; segments follow
 * CATEGORY_ORDER; color rotation deterministic.
 */
import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@/agent/compaction"
import {
  type BuildBreakdownInput,
  breakdownPercent,
  buildUsageBreakdown,
  buildUsageBreakdownDefault,
  CATEGORY_ORDER,
  type ContextCategory,
} from "@/agent/context/usage-breakdown"
import { fourSectionPreset, SECTION_CONTEXT_CATEGORY } from "@/agent/prompt-sections"

const sections = () =>
  fourSectionPreset({
    base: "x".repeat(400), // System
    projectMd: "y".repeat(200), // Rules
    sessionCtx: "z".repeat(300), // Conversation
    userAppend: "w".repeat(100), // Conversation
  })

const input = (over: Partial<BuildBreakdownInput> = {}): BuildBreakdownInput => ({
  sections: sections(),
  max: 200_000,
  ...over,
})

describe("usage-breakdown — measured by the loop's estimator", () => {
  test("total equals sum of segment tokens", () => {
    const b = buildUsageBreakdown(input(), estimateTokens)
    const sum = b.segments.reduce((a, s) => a + s.tokens, 0)
    expect(b.total).toBe(sum)
    expect(b.total).toBeGreaterThan(0)
  })

  test("each segment uses estimateTokens on its concatenated text (chars/4)", () => {
    const b = buildUsageBreakdown(input(), estimateTokens)
    const sys = b.segments.find((s) => s.id === "System")
    // System = base section only (400 chars) ⇒ ceil(400/4) = 100 tokens.
    expect(sys?.chars).toBe(400)
    expect(sys?.tokens).toBe(
      estimateTokens([{ role: "user", content: [{ type: "text", text: "x".repeat(400) }] }]),
    )
  })

  test("buildUsageBreakdownDefault is wired to the real estimator", () => {
    const a = buildUsageBreakdownDefault(input())
    const b = buildUsageBreakdown(input(), estimateTokens)
    expect(a).toEqual(b)
  })

  test("Conversation merges session_ctx + user_append (300+100 chars, joined)", () => {
    const b = buildUsageBreakdown(input(), estimateTokens)
    const conv = b.segments.filter((s) => s.id === "Conversation")
    expect(conv.length).toBe(1)
    // joined "\n\n" between the two parts ⇒ 300 + 2 + 100 = 402 chars.
    expect(conv[0]?.chars).toBe(402)
  })

  test("section→category mapping is the co-located SSOT", () => {
    expect(SECTION_CONTEXT_CATEGORY.base).toBe("System")
    expect(SECTION_CONTEXT_CATEGORY.project_md).toBe("Rules")
    expect(SECTION_CONTEXT_CATEGORY.session_ctx).toBe("Conversation")
    expect(SECTION_CONTEXT_CATEGORY.user_append).toBe("Conversation")
  })
})

describe("usage-breakdown — empty categories + extras", () => {
  test("omits categories with no content (no Tools/Skills/MCP/Subagents here)", () => {
    const ids = buildUsageBreakdown(input(), estimateTokens).segments.map((s) => s.id)
    expect(ids).not.toContain("Tools")
    expect(ids).not.toContain("Skills")
    expect(ids).not.toContain("MCP")
    expect(ids).not.toContain("Subagents")
  })

  test("extras feed Tools/MCP categories and still sum to total", () => {
    const b = buildUsageBreakdown(
      input({
        extras: [
          { category: "Tools", text: "t".repeat(80) },
          { category: "MCP", text: "m".repeat(40) },
        ],
      }),
      estimateTokens,
    )
    const ids = b.segments.map((s) => s.id)
    expect(ids).toContain("Tools")
    expect(ids).toContain("MCP")
    expect(b.total).toBe(b.segments.reduce((a, s) => a + s.tokens, 0))
  })

  test("empty sections ⇒ no segments, zero total", () => {
    const b = buildUsageBreakdown({ sections: [], max: 1000 }, estimateTokens)
    expect(b.segments.length).toBe(0)
    expect(b.total).toBe(0)
  })

  test("whitespace-collapsed inputs that fourSectionPreset drops ⇒ System only", () => {
    const b = buildUsageBreakdown(
      { sections: fourSectionPreset({ base: "abcd" }), max: 1000 },
      estimateTokens,
    )
    expect(b.segments.map((s) => s.id)).toEqual(["System"])
  })
})

describe("usage-breakdown — ordering + determinism", () => {
  test("segments follow canonical CATEGORY_ORDER", () => {
    const b = buildUsageBreakdown(
      input({ extras: [{ category: "Tools", text: "t".repeat(10) }] }),
      estimateTokens,
    )
    const ids = b.segments.map((s) => s.id)
    const expected = CATEGORY_ORDER.filter((c: ContextCategory) => ids.includes(c))
    expect(ids).toEqual([...expected])
    expect(ids[0]).toBe("System")
    expect(ids.indexOf("Tools")).toBeLessThan(ids.indexOf("Rules"))
  })

  test("color rotation is deterministic per category", () => {
    const a = buildUsageBreakdown(input(), estimateTokens).segments.map((s) => [s.id, s.color])
    const b = buildUsageBreakdown(input(), estimateTokens).segments.map((s) => [s.id, s.color])
    expect(a).toEqual(b)
  })
})

describe("breakdownPercent", () => {
  test("clamps to 100 and never NaN", () => {
    expect(breakdownPercent({ segments: [], total: 8000, max: 4000 })).toBe(100)
    expect(breakdownPercent({ segments: [], total: 0, max: 0 })).toBe(0)
    expect(breakdownPercent({ segments: [], total: 2000, max: 4000 })).toBe(50)
  })
})
