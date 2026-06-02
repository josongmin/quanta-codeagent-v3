import { describe, expect, it } from "vitest"
import type { DiffLineData, ToolDiffMessage } from "../types/protocol"
import { diffStatsFromLines, diffStatsFromMessage } from "./diff-adapter"

const lines: DiffLineData[] = [
  { type: "unchanged", content: "keep", lineNumber: 1 },
  { type: "removed", content: "old", lineNumber: 2 },
  { type: "added", content: "new1", lineNumber: 2 },
  { type: "added", content: "new2", lineNumber: 3 },
]

describe("diff-adapter", () => {
  it("reads daemon-computed counts straight off the message (no recompute)", () => {
    const msg: ToolDiffMessage = {
      kind: "tool.diff",
      toolCallId: "t1",
      lines,
      additions: 2,
      deletions: 1,
      emittedAt: 0,
    }
    expect(diffStatsFromMessage(msg)).toEqual({ additions: 2, deletions: 1 })
  })

  it("derives counts by tallying line types (pure tally, not a diff)", () => {
    expect(diffStatsFromLines(lines)).toEqual({ additions: 2, deletions: 1 })
  })

  it("tally of an empty / all-unchanged set is zero", () => {
    expect(diffStatsFromLines([])).toEqual({ additions: 0, deletions: 0 })
    expect(diffStatsFromLines([{ type: "unchanged", content: "x", lineNumber: 1 }])).toEqual({
      additions: 0,
      deletions: 0,
    })
  })
})
