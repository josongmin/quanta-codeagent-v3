/**
 * Track D hellgate — segmented usage RENDER + single-bar regression anchor.
 *
 * Pins: segmented bar width is STABLE regardless of segment count / total;
 * legend rows per present category; "Full" fullness label; deterministic
 * render; and — load-bearing — the existing single-bar `formatContextUsage`
 * stays byte-identical (it must remain the default status line).
 */
import { describe, expect, test } from "bun:test"
import {
  formatContextUsage,
  formatSegmentedUsage,
  SEGMENTED_BAR_CELLS,
  type SegmentedUsageView,
} from "@/apps/cli/status-line"

const view = (total: number, max: number, model?: string): SegmentedUsageView => ({
  segments: [
    { id: "System", tokens: Math.round(total * 0.5) },
    { id: "Rules", tokens: Math.round(total * 0.25) },
    { id: "Conversation", tokens: total - Math.round(total * 0.5) - Math.round(total * 0.25) },
  ],
  total,
  max,
  ...(model !== undefined ? { model } : {}),
})

const barRow = (out: string): string => {
  const first = out.split("\n")[0] ?? ""
  const m = first.match(/\[([^\]]*)\]/)
  return m?.[1] ?? ""
}

describe("formatSegmentedUsage — bar width stability", () => {
  test("bar is exactly SEGMENTED_BAR_CELLS wide across totals", () => {
    for (const total of [1, 500, 7680, 119_999]) {
      expect(barRow(formatSegmentedUsage(view(total, 120_000))).length).toBe(SEGMENTED_BAR_CELLS)
    }
  })

  test("bar width stable with zero total", () => {
    expect(barRow(formatSegmentedUsage(view(0, 120_000))).length).toBe(SEGMENTED_BAR_CELLS)
  })

  test("bar width stable with one segment", () => {
    const v: SegmentedUsageView = {
      segments: [{ id: "System", tokens: 100 }],
      total: 100,
      max: 200,
    }
    expect(barRow(formatSegmentedUsage(v)).length).toBe(SEGMENTED_BAR_CELLS)
  })
})

describe("formatSegmentedUsage — labels", () => {
  test("renders k/k total label and Full fullness", () => {
    const out = formatSegmentedUsage(view(76_800, 120_000))
    expect(out).toContain("76.8k/120k")
    expect(out).toContain("64% Full")
  })

  test("at/over 100% shows bare 'Full'", () => {
    expect(formatSegmentedUsage(view(120_000, 120_000))).toContain("· Full")
  })

  test("legend row per present category with a percent", () => {
    const out = formatSegmentedUsage(view(1000, 4000))
    expect(out).toContain("System")
    expect(out).toContain("Rules")
    expect(out).toContain("Conversation")
    expect(out).toMatch(/\(\d+%\)/)
  })

  test("model appended when present", () => {
    expect(formatSegmentedUsage(view(1000, 4000, "gpt-5"))).toContain("· gpt-5")
  })

  test("render is deterministic", () => {
    expect(formatSegmentedUsage(view(1234, 8000))).toBe(formatSegmentedUsage(view(1234, 8000)))
  })
})

describe("REGRESSION — single-bar formatContextUsage byte-identical anchor", () => {
  test("50% bar is exactly the pre-Track-D string", () => {
    expect(formatContextUsage(100_000, 200_000, "claude-sonnet-4-5")).toBe(
      "[██████████░░░░░░░░░░] 100k/200k (50%) · claude-sonnet-4-5",
    )
  })

  test("25% bar unchanged", () => {
    expect(formatContextUsage(50_000, 200_000, "claude-sonnet-4-5")).toBe(
      "[█████░░░░░░░░░░░░░░░] 50.0k/200k (25%) · claude-sonnet-4-5",
    )
  })

  test("single-bar output stays single-line", () => {
    expect(formatContextUsage(50_000, 200_000, "m").includes("\n")).toBe(false)
  })
})
