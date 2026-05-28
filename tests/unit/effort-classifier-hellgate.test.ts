/**
 * ADR-0417 hellgate — effort classifier (prompt-keyword escalation +
 * tool-failure accumulation → EffortLevel recommendation).
 *
 * Pure leaf, no IO. The classifier is a PORT (slot on AgentConfig); no
 * consumer triggers it this wave (loop.ts / prompt-pipeline.ts unmodified),
 * so these cases prove the LOGIC standalone.
 *
 * 14 adversarial cases:
 *
 *   Keyword rules (5)
 *     HELL-EC-01 default rule: /ultrathink/i ⇒ "max"
 *     HELL-EC-02 default rule: /think harder/i ⇒ "max"
 *     HELL-EC-03 default rule: /think hard/i + /deeper/i ⇒ "high"
 *     HELL-EC-04 default rule: /be thorough/i ⇒ "high"
 *     HELL-EC-05 no keyword ⇒ empty signals, recommendation stays "default"
 *
 *   Highest-wins (3)
 *     HELL-EC-06 "ultrathink" + "be thorough" in one prompt ⇒ recommendation "max"
 *     HELL-EC-07 multiple prompts accumulate; highest survives ("high" then "max" ⇒ "max")
 *     HELL-EC-08 lower keyword after higher does NOT downgrade ("max" then "high" ⇒ "max")
 *
 *   Failure counter (3)
 *     HELL-EC-09 cumulative: failures below threshold ⇒ no signal
 *     HELL-EC-10 at threshold (default 3) ⇒ tool_failure_accumulation signal "high"
 *     HELL-EC-11 per-tool counters independent (2+2 across two tools ⇒ no fire at default 3)
 *
 *   Reset + custom (2)
 *     HELL-EC-12 reset() clears keyword + failure state ⇒ back to "default"
 *     HELL-EC-13 custom keywordRules + failureThreshold + failureLevel honored
 *
 *   NO-THROW (1)
 *     HELL-EC-14 empty / whitespace / unicode prompt ⇒ no throw, empty signals
 */

import { describe, expect, test } from "bun:test"
import {
  createEffortClassifier,
  type EffortLevel,
  type EscalationSignal,
} from "@/agent/effort-classifier"

const kindsOf = (sigs: readonly EscalationSignal[]) => sigs.map((s) => s.kind)

describe("ADR-0417 effort-classifier hellgate", () => {
  test("HELL-EC-01 ultrathink keyword ⇒ max", () => {
    const c = createEffortClassifier()
    const sigs = c.onUserPrompt("please ULTRATHINK this design")
    expect(sigs.length).toBe(1)
    expect(sigs[0]).toMatchObject({ kind: "keyword", suggestedLevel: "max" })
    expect(c.currentRecommendation().level).toBe("max")
  })

  test("HELL-EC-02 'think harder' keyword ⇒ max", () => {
    const c = createEffortClassifier()
    const sigs = c.onUserPrompt("can you think harder about edge cases")
    expect(sigs.some((s) => s.kind === "keyword" && s.suggestedLevel === "max")).toBe(true)
    expect(c.currentRecommendation().level).toBe("max")
  })

  test("HELL-EC-03 'think hard' / 'deeper' ⇒ high", () => {
    const a = createEffortClassifier()
    expect(a.onUserPrompt("think hard about this")[0]).toMatchObject({ suggestedLevel: "high" })
    expect(a.currentRecommendation().level).toBe("high")

    const b = createEffortClassifier()
    expect(b.onUserPrompt("look deeper into the stack")[0]).toMatchObject({
      suggestedLevel: "high",
    })
    expect(b.currentRecommendation().level).toBe("high")
  })

  test("HELL-EC-04 'be thorough' ⇒ high", () => {
    const c = createEffortClassifier()
    expect(c.onUserPrompt("be thorough please")[0]).toMatchObject({ suggestedLevel: "high" })
    expect(c.currentRecommendation().level).toBe("high")
  })

  test("HELL-EC-05 no keyword ⇒ empty signals, default recommendation", () => {
    const c = createEffortClassifier()
    expect(c.onUserPrompt("add a button to the page")).toEqual([])
    const rec = c.currentRecommendation()
    expect(rec.level).toBe("default")
    expect(rec.signals).toEqual([])
    expect(typeof rec.reason).toBe("string")
  })

  test("HELL-EC-06 two keywords in one prompt ⇒ highest wins (max)", () => {
    const c = createEffortClassifier()
    const sigs = c.onUserPrompt("be thorough and ultrathink this")
    // both matched as signals
    expect(sigs.length).toBeGreaterThanOrEqual(2)
    // recommendation collapses to the highest
    expect(c.currentRecommendation().level).toBe("max")
  })

  test("HELL-EC-07 accumulate across prompts; highest survives", () => {
    const c = createEffortClassifier()
    c.onUserPrompt("be thorough") // high
    expect(c.currentRecommendation().level).toBe("high")
    c.onUserPrompt("ultrathink it") // max
    expect(c.currentRecommendation().level).toBe("max")
  })

  test("HELL-EC-08 lower keyword after higher does NOT downgrade", () => {
    const c = createEffortClassifier()
    c.onUserPrompt("ultrathink") // max
    c.onUserPrompt("think hard") // high — must NOT pull recommendation down
    expect(c.currentRecommendation().level).toBe("max")
  })

  test("HELL-EC-09 failures below threshold ⇒ no signal", () => {
    const c = createEffortClassifier()
    expect(c.onToolFailure("bash")).toEqual([])
    expect(c.onToolFailure("bash")).toEqual([]) // 2 < 3
    expect(c.currentRecommendation().level).toBe("default")
  })

  test("HELL-EC-10 at threshold (3) ⇒ tool_failure_accumulation high", () => {
    const c = createEffortClassifier()
    c.onToolFailure("bash")
    c.onToolFailure("bash")
    const sigs = c.onToolFailure("bash") // 3rd hit = threshold
    expect(sigs.length).toBe(1)
    expect(sigs[0]).toMatchObject({
      kind: "tool_failure_accumulation",
      tool: "bash",
      failureCount: 3,
      suggestedLevel: "high",
    })
    expect(c.currentRecommendation().level).toBe("high")
    expect(kindsOf(c.currentRecommendation().signals)).toContain("tool_failure_accumulation")
  })

  test("HELL-EC-11 per-tool counters are independent", () => {
    const c = createEffortClassifier()
    c.onToolFailure("bash")
    c.onToolFailure("bash") // bash=2
    c.onToolFailure("edit")
    expect(c.onToolFailure("edit")).toEqual([]) // edit=2 — neither hits 3
    expect(c.currentRecommendation().level).toBe("default")
  })

  test("HELL-EC-12 reset() clears keyword + failure state", () => {
    const c = createEffortClassifier()
    c.onUserPrompt("ultrathink")
    c.onToolFailure("bash")
    c.onToolFailure("bash")
    c.onToolFailure("bash")
    expect(c.currentRecommendation().level).toBe("max")
    c.reset()
    const rec = c.currentRecommendation()
    expect(rec.level).toBe("default")
    expect(rec.signals).toEqual([])
    // counters reset too: 3 more failures should be needed to refire
    expect(c.onToolFailure("bash")).toEqual([])
  })

  test("HELL-EC-13 custom rules + threshold + level honored", () => {
    const rules: readonly { pattern: RegExp; level: EffortLevel }[] = [
      { pattern: /turbo/i, level: "low" },
    ]
    const c = createEffortClassifier({
      keywordRules: rules,
      failureThreshold: 2,
      failureLevel: "medium",
    })
    // default keywords are REPLACED by custom set
    expect(c.onUserPrompt("ultrathink")).toEqual([])
    expect(c.onUserPrompt("turbo mode")[0]).toMatchObject({ suggestedLevel: "low" })
    // custom failure threshold/level
    c.onToolFailure("test")
    const sigs = c.onToolFailure("test") // hits custom threshold 2
    expect(sigs[0]).toMatchObject({
      kind: "tool_failure_accumulation",
      failureCount: 2,
      suggestedLevel: "medium",
    })
  })

  test("HELL-EC-14 NO-THROW on empty / whitespace / weird input", () => {
    const c = createEffortClassifier()
    expect(() => c.onUserPrompt("")).not.toThrow()
    expect(() => c.onUserPrompt("   \n\t  ")).not.toThrow()
    expect(() => c.onUserPrompt("日本語 think hard 🚀")).not.toThrow()
    expect(() => c.onToolFailure("")).not.toThrow()
    expect(c.onUserPrompt("")).toEqual([])
    // unicode-embedded keyword still matches
    expect(c.onUserPrompt("日本語 think hard 🚀").length).toBeGreaterThanOrEqual(1)
  })
})
