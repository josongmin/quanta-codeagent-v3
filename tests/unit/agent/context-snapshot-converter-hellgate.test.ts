/**
 * Track D hellgate — runtime → REPL context wire, the SystemBlock→PromptSection
 * converter.
 *
 * Pins:
 *  - `snapshotToSections` reconstructs section NAMES from the captured
 *    `SystemBlock[]` + the turn's `promptPolicy` presence flags, in the fixed
 *    `fourSectionPreset` order (base, project_md?, session_ctx?, user_append?).
 *  - The reconstructed sections feed `buildUsageBreakdownDefault` so per-category
 *    tokens are IDENTICAL to building the breakdown from the original
 *    `PromptSection[]` (no second heuristic; the section→category SSOT decides).
 *  - A `single_block` layout (or any extra block) bills to "System" via the
 *    unmapped-name fallback — never dropped.
 */
import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@/agent/compaction"
import {
  buildUsageBreakdown,
  buildUsageBreakdownDefault,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
  snapshotToSections,
} from "@/agent/context/usage-breakdown"
import { buildSectionedSystemBlocks, fourSectionPreset } from "@/agent/prompt-sections"
import type { SystemBlock } from "@/llm"

const fourSections = () =>
  fourSectionPreset({
    base: "x".repeat(400), // System
    projectMd: "y".repeat(200), // Rules
    sessionCtx: "z".repeat(300), // Conversation
    userAppend: "w".repeat(100), // Conversation
  })

const fourSectionSnapshot = (): PromptAssembledSnapshot => ({
  system: buildSectionedSystemBlocks(fourSections()),
  layout: "four_section",
  repoRulesPresent: true,
  sessionCtxPresent: true,
  userAppendPresent: true,
  max: 200_000,
  model: "test-model",
})

describe("Track D converter — name reconstruction from policy flags", () => {
  test("four-section snapshot recovers base/project_md/session_ctx/user_append in order", () => {
    const recovered = snapshotToSections(fourSectionSnapshot())
    expect(recovered.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    // Text + cache flag are carried through verbatim from the SystemBlock[].
    expect(recovered[0]?.text).toBe("x".repeat(400))
    expect(recovered.every((s) => s.cache === true)).toBe(true)
  })

  test("absent optionals are skipped so names stay aligned to surviving blocks", () => {
    // Only base + session_ctx present (no project_md, no user_append).
    const sections = fourSectionPreset({ base: "b".repeat(40), sessionCtx: "s".repeat(80) })
    const snap: PromptAssembledSnapshot = {
      system: buildSectionedSystemBlocks(sections),
      layout: "four_section",
      repoRulesPresent: false,
      sessionCtxPresent: true,
      userAppendPresent: false,
      max: 0,
    }
    const recovered = snapshotToSections(snap)
    expect(recovered.map((s) => s.name)).toEqual(["base", "session_ctx"])
  })

  test("converted breakdown == breakdown from original PromptSection[] (per-category tokens)", () => {
    const original = fourSections()
    const fromOriginal = buildUsageBreakdown({ sections: original, max: 200_000 }, estimateTokens)
    const fromSnapshot = buildUsageBreakdownDefault(snapshotToBreakdownInput(fourSectionSnapshot()))

    // Same categories, same per-category token counts, same total.
    expect(fromSnapshot.segments.map((s) => [s.id, s.tokens])).toEqual(
      fromOriginal.segments.map((s) => [s.id, s.tokens]),
    )
    expect(fromSnapshot.total).toBe(fromOriginal.total)
    expect(fromSnapshot.total).toBe(fromSnapshot.segments.reduce((a, s) => a + s.tokens, 0))
    // System = base (400 chars) ⇒ ceil(400/4) = 100 tokens via the SAME estimator.
    const sys = fromSnapshot.segments.find((s) => s.id === "System")
    expect(sys?.tokens).toBe(
      estimateTokens([{ role: "user", content: [{ type: "text", text: "x".repeat(400) }] }]),
    )
  })

  test("single_block layout bills the lone block to System (unmapped→fallback)", () => {
    const blocks: SystemBlock[] = [{ type: "text", text: "p".repeat(120), cache: true }]
    const snap: PromptAssembledSnapshot = {
      system: blocks,
      layout: "single_block",
      repoRulesPresent: false,
      sessionCtxPresent: false,
      userAppendPresent: false,
      max: 0,
    }
    const recovered = snapshotToSections(snap)
    expect(recovered.map((s) => s.name)).toEqual(["base"])
    const b = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap))
    expect(b.segments.map((s) => s.id)).toEqual(["System"])
    expect(b.segments[0]?.tokens).toBeGreaterThan(0)
  })

  test("extra block beyond the named prefix falls back to base/System, never dropped", () => {
    // Four-section blocks + one unexpected trailing block.
    const blocks = [
      ...buildSectionedSystemBlocks(fourSections()),
      { type: "text" as const, text: "extra".repeat(20), cache: false },
    ]
    const snap: PromptAssembledSnapshot = {
      system: blocks,
      layout: "four_section",
      repoRulesPresent: true,
      sessionCtxPresent: true,
      userAppendPresent: true,
      max: 0,
    }
    const recovered = snapshotToSections(snap)
    expect(recovered).toHaveLength(5)
    expect(recovered[4]?.name).toBe("base")
    expect(recovered[4]?.cache).toBe(false)
  })
})
