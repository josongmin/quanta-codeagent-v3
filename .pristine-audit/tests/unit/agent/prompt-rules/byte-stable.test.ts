import { describe, expect, test } from "bun:test"
import { renderPackByMode, renderToolUseRules } from "@/agent/prompt-rules"

/**
 * Byte-stability guard for the slice refactor.
 *
 * `renderToolUseRules()` is the legacy entry point that `prompt.ts` calls when
 * no `promptPack` is supplied. Its output MUST equal `renderPackByMode("interactive")`
 * line-for-line so the cached system-prompt prefix for interactive sessions is
 * unchanged by the slice split.
 *
 * Additionally, the pack contents must be deterministic across calls (no
 * hidden mutation, no Date.now-keyed shuffling).
 */
describe("prompt-rules — byte-stable assistant pack", () => {
  test("renderToolUseRules() equals renderPackByMode('interactive') line-for-line", () => {
    const legacy = renderToolUseRules()
    const interactive = renderPackByMode("interactive")
    expect(legacy.length).toBe(interactive.length)
    for (let i = 0; i < legacy.length; i++) {
      expect(legacy[i]).toBe(interactive[i])
    }
  })

  test("joined line output is byte-identical to the interactive pack", () => {
    expect(renderToolUseRules().join("\n")).toBe(renderPackByMode("interactive").join("\n"))
  })

  test("renderToolUseRules() output is stable across repeated calls", () => {
    const a = renderToolUseRules().join("\n")
    const b = renderToolUseRules().join("\n")
    expect(a).toBe(b)
    expect(a.length).toBe(b.length)
  })

  test("each mode's output is stable across repeated calls", () => {
    for (const mode of ["interactive", "headless", "batch", "ci-bot"] as const) {
      const a = renderPackByMode(mode).join("\n")
      const b = renderPackByMode(mode).join("\n")
      expect(a).toBe(b)
    }
  })
})
