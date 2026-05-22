import { describe, expect, test } from "bun:test"
import { type AgentMode, CORE_RULES, renderPackByMode } from "@/agent/prompt-rules"

/**
 * Pack-level invariants for each of the 4 modes.
 *
 *   1. Every pack returns a non-empty line array.
 *   2. Every pack includes ALL 7 core-rule ID tags inline (no pack drops a
 *      core rule).
 *   3. Mode-specific packs include their additional rule IDs.
 *   4. No ID appears more than once in a single pack (no accidental dedupe
 *      bypass via concat).
 */

const CORE_IDS = [
  "R-ENV",
  "R-STOP-ENV",
  "R-SEARCH-FIRST",
  "R-READ-FAILURE",
  "R-NO-THRASH",
  "R-NO-SHIM",
  "R-FAILURE-MODE",
] as const

const expectIdAppearsOnce = (lines: readonly string[], id: string) => {
  const joined = lines.join("\n")
  const count = joined.split(`[${id}]`).length - 1
  expect(count).toBe(1)
}

const MODES: readonly AgentMode[] = ["interactive", "headless", "batch", "ci-bot"]

describe("renderPackByMode — all 4 modes", () => {
  for (const mode of MODES) {
    test(`${mode}: returns a non-empty line array`, () => {
      const lines = renderPackByMode(mode)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
    })

    test(`${mode}: contains all 7 CORE_RULE ID tags`, () => {
      const lines = renderPackByMode(mode)
      for (const id of CORE_IDS) {
        expect(lines.join("\n")).toContain(`[${id}]`)
      }
    })

    test(`${mode}: every core rule ID appears exactly once`, () => {
      const lines = renderPackByMode(mode)
      for (const id of CORE_IDS) expectIdAppearsOnce(lines, id)
    })
  }
})

describe("renderPackByMode — mode-specific new rules", () => {
  test("headless adds R-SINGLE-COHERENT exactly once", () => {
    const lines = renderPackByMode("headless")
    expect(lines.join("\n")).toContain("[R-SINGLE-COHERENT]")
    expectIdAppearsOnce(lines, "R-SINGLE-COHERENT")
  })

  test("batch adds R-NO-EXPLORE-OVER-EDIT exactly once", () => {
    const lines = renderPackByMode("batch")
    expect(lines.join("\n")).toContain("[R-NO-EXPLORE-OVER-EDIT]")
    expectIdAppearsOnce(lines, "R-NO-EXPLORE-OVER-EDIT")
  })

  test("ci-bot adds R-SMALL-DIFF, R-EXPLAIN-IN-PR, R-NO-PUSH-MAIN exactly once each", () => {
    const lines = renderPackByMode("ci-bot")
    const joined = lines.join("\n")
    expect(joined).toContain("[R-SMALL-DIFF]")
    expect(joined).toContain("[R-EXPLAIN-IN-PR]")
    expect(joined).toContain("[R-NO-PUSH-MAIN]")
    expectIdAppearsOnce(lines, "R-SMALL-DIFF")
    expectIdAppearsOnce(lines, "R-EXPLAIN-IN-PR")
    expectIdAppearsOnce(lines, "R-NO-PUSH-MAIN")
  })

  test("interactive does NOT include any mode-specific rule (byte-stable legacy)", () => {
    const joined = renderPackByMode("interactive").join("\n")
    expect(joined).not.toContain("[R-SINGLE-COHERENT]")
    expect(joined).not.toContain("[R-NO-EXPLORE-OVER-EDIT]")
    expect(joined).not.toContain("[R-SMALL-DIFF]")
    expect(joined).not.toContain("[R-EXPLAIN-IN-PR]")
    expect(joined).not.toContain("[R-NO-PUSH-MAIN]")
  })

  test("CORE_RULES export shape matches the 7 expected IDs in order", () => {
    expect(CORE_RULES.map((r) => r.id)).toEqual([...CORE_IDS])
  })
})
