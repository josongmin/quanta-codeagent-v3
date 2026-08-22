/**
 * Stress test: extreme cases and high-volume property checking.
 *
 * Tests invariants across:
 * - Very large files (near LCS worst-case)
 * - Many hunks (10+)
 * - Very long lines
 * - Many consecutive ops of same type
 * - Alternating op patterns
 */

import { describe, expect, it } from "bun:test"
import { applySelectedHunks, splitHunks } from "@/runner/diff-ops"

describe("Stress tests — extreme cases", () => {
  it("invariant 1: large file with many independent hunks", () => {
    // Create a file with 20 lines, modify every other line
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n")
    const afterLines = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? `line${i}` : `MODIFIED_${i}`,
    )
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 2: many consecutive insertions", () => {
    const before = "a"
    const afterLines = ["a", ...Array.from({ length: 50 }, (_, i) => `inserted_${i}`)]
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 3: many consecutive deletions", () => {
    const beforeLines = ["a", ...Array.from({ length: 50 }, (_, i) => `line_${i}`)]
    const before = beforeLines.join("\n")
    const after = "a"

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 4: alternating keep-del-add-keep pattern", () => {
    const before = Array.from({ length: 30 }, (_, i) => `k${i}`).join("\n")
    const afterLines: string[] = []
    for (let i = 0; i < 30; i += 2) {
      afterLines.push(`k${i}`)
      afterLines.push(`x${i}`)
    }
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 5: del-add-del-add alternating", () => {
    const before = Array.from({ length: 40 }, (_, i) => `o${i}`).join("\n")
    const afterLines: string[] = []
    for (let i = 0; i < 40; i += 2) {
      afterLines.push(`n${i}`)
      afterLines.push(`n${i + 1}`)
    }
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 6: single massive hunk (entire file changed)", () => {
    const before = Array.from({ length: 100 }, (_, i) => `old_${i}`).join("\n")
    const after = Array.from({ length: 100 }, (_, i) => `new_${i}`).join("\n")

    const hunks = splitHunks(before, after)
    expect(hunks.length).toBe(1)
    const h0 = hunks[0]
    expect(h0?.delCount).toBe(100)
    expect(h0?.addCount).toBe(100)

    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 7: very long lines", () => {
    const longLine = "x".repeat(1000)
    const longLineModified = "y".repeat(1000)
    const before = [longLine, "a", longLine].join("\n")
    const after = [longLineModified, "a", longLineModified].join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 8: many blank lines", () => {
    const beforeLines = ["a", "", "", "b", "", "c", "", "", ""]
    const before = beforeLines.join("\n")
    const afterLines = ["a", "", "X", "", "b", "", "c"]
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 9: Unicode and special characters", () => {
    const before = ["你好", "world", "🎉"].join("\n")
    const after = ["hello", "world", "🎊"].join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("invariant 10: tab and whitespace handling", () => {
    const before = ["a\tb", "  c", "\td"].join("\n")
    const after = ["a\tX", "  c", "\td"].join("\n")

    const hunks = splitHunks(before, after)
    const allIds = hunks.map((h) => h.id)
    expect(applySelectedHunks(before, after, allIds)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })

  it("hunk composition: random subset selection on large file", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
    const afterLines = Array.from({ length: 50 }, (_, i) =>
      i % 3 === 0 ? `modified${i}` : `line${i}`,
    )
    const after = afterLines.join("\n")

    const hunks = splitHunks(before, after)

    // Try multiple random subsets
    for (let trial = 0; trial < 10; trial++) {
      const selectedIndices = hunks
        .map((_, i) => (Math.random() > 0.5 ? i : -1))
        .filter((i) => i >= 0)

      if (selectedIndices.length === 0) {
        const result = applySelectedHunks(before, after, [])
        expect(result).toBe(before)
      } else if (selectedIndices.length === hunks.length) {
        const allIds = hunks.map((h) => h.id)
        const result = applySelectedHunks(before, after, allIds)
        expect(result).toBe(after)
      } else {
        const selectedIds = selectedIndices.flatMap((i) => {
          const h = hunks[i]
          return h ? [h.id] : []
        })
        const result = applySelectedHunks(before, after, selectedIds)
        // Robustness: a partial selection over a large random diff must produce a
        // valid reconstruction whose every line comes from `before` or `after`
        // (no corruption / no throw / no hang on the LCS-heavy input).
        const allowed = new Set([...before.split("\n"), ...after.split("\n")])
        for (const line of result.split("\n")) expect(allowed.has(line)).toBe(true)
      }
    }
  })
})
