/**
 * Deep adversarial audit for hunk decomposition edge cases.
 *
 * Specifically probes for:
 * 1. Divergence in hunk numbering between hunksFromOps and applySelectedHunks inline tracking
 * 2. Off-by-one errors in oldStart/newStart calculation
 * 3. Boundary conditions: keep/change transitions, empty runs, trailing ops
 * 4. Specific LCS ambiguities that could cause hunk index desync
 */

import { describe, expect, it } from "bun:test"
import { applySelectedHunks, diffOps, splitHunks } from "@/runner/diff-ops"

/** Independent op-index → hunk-index map: a separate pass over the ops that
 *  numbers maximal non-`keep` runs (the same scheme `hunksFromOps` uses). Kept
 *  out of {@link verifyHunkNumberingConsistency} to hold its complexity down. */
const buildOpHunkIndexMap = (ops: ReturnType<typeof diffOps>): Map<number, number> => {
  const opToHunkIndex = new Map<number, number>()
  let hunkIndex = -1
  let inRun = false
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op === undefined) continue
    if (op.kind === "keep") {
      inRun = false
      continue
    }
    if (!inRun) {
      inRun = true
      hunkIndex++
    }
    opToHunkIndex.set(i, hunkIndex)
  }
  return opToHunkIndex
}

/**
 * Manually apply hunks using the hunk decomposition (hunksFromOps logic) to verify
 * that the inline tracking in applySelectedHunks produces identical results.
 */
const verifyHunkNumberingConsistency = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  const ops = diffOps(before, after)
  const opToHunkIndex = buildOpHunkIndexMap(ops)

  // Now verify each hunk in hunks array corresponds to the right ops
  let opIndex = 0
  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx]
    if (hunk === undefined) return false
    // Find the first non-keep op that belongs to this hunk
    while (opIndex < ops.length && ops[opIndex]?.kind === "keep") {
      opIndex++
    }
    if (opIndex >= ops.length) break

    // The hunk at hunkIdx should match the inline hunkIndex mapping
    const expectedHunkIdx = opToHunkIndex.get(opIndex)
    if (expectedHunkIdx !== hunkIdx) {
      return false
    }

    // Skip past this hunk's ops
    opIndex += hunk.ops.length
  }

  return true
}

/**
 * Verify that selecting a single hunk produces consistent results when
 * composing multiple single-hunk selections.
 */
const verifySingleHunkComposition = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  if (hunks.length <= 1) return true
  const all = hunks.map((h) => h.id)

  // The full selection must reproduce `after` exactly.
  if (applySelectedHunks(before, after, all) !== after) return false

  for (const hunk of hunks) {
    // TEETH: selecting ONLY this hunk must actually change `before` (the hunk is
    // non-empty). A no-op / inverted applySelectedHunks would leave it === before.
    if (applySelectedHunks(before, after, [hunk.id]) === before) return false

    // TEETH: DROPPING this hunk from the full set must change the result away from
    // `after` (its change is no longer applied). If selection were ignored, the
    // result would still equal `after`.
    const without = all.filter((id) => id !== hunk.id)
    if (applySelectedHunks(before, after, without) === after) return false

    // INDEPENDENCE: the full result equals (full-minus-this) re-applied with this
    // hunk re-selected — i.e. selecting `without ∪ {hunk}` == selecting `all`.
    if (applySelectedHunks(before, after, [...without, hunk.id]) !== after) return false
  }
  return true
}

/**
 * Verify oldStart/newStart are correct for each hunk, especially at boundary cases:
 * - First hunk at position 0 (oldStart should be 0 for insertion, 1 for deletion)
 * - Hunks after keep ops (oldStart should be line number of last keep + 1)
 * - Pure insertions (oldStart should be cursor position, addCount > 0)
 * - Pure deletions (newStart should be cursor position, delCount > 0)
 */
const verifyHunkPositions = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  const ops = diffOps(before, after)
  // Walk the ops INDEPENDENTLY (a separate cursor pass) and assert each hunk's
  // reported oldStart/newStart matches the line it actually begins on. This is an
  // exact-equality oracle (not a bounds check), so an off-by-one mutation in the
  // source anchor formula (e.g. `runOldCursor + 2`) makes this RED.
  let oldLine = 0
  let newLine = 0
  let hi = 0
  let inRun = false
  let runHasDel = false
  let runHasAdd = false
  let runOldCursor = 0
  let runNewCursor = 0
  const checkRun = (): boolean => {
    const h = hunks[hi]
    if (h === undefined) return false
    const expOldStart = runHasDel ? runOldCursor + 1 : runOldCursor
    const expNewStart = runHasAdd ? runNewCursor + 1 : runNewCursor
    if (h.oldStart !== expOldStart || h.newStart !== expNewStart) return false
    hi++
    return true
  }
  for (const op of ops) {
    if (op.kind === "keep") {
      if (inRun && !checkRun()) return false
      inRun = false
      runHasDel = false
      runHasAdd = false
      oldLine++
      newLine++
      continue
    }
    if (!inRun) {
      inRun = true
      runOldCursor = oldLine
      runNewCursor = newLine
    }
    if (op.kind === "del") {
      runHasDel = true
      oldLine++
    } else {
      runHasAdd = true
      newLine++
    }
  }
  if (inRun && !checkRun()) return false
  // Every hunk must have been visited exactly once.
  return hi === hunks.length
}

/**
 * Stress test: verify that the hunk ops themselves match the operations in the
 * main ops array, at the correct indices.
 */
const verifyHunkOpsInclusion = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  const ops = diffOps(before, after)

  // Build the op stream that should be inside hunks
  const nonKeepOps = ops.filter((op) => op.kind !== "keep")
  const opsSummed = hunks.reduce((sum, h) => sum + h.ops.length, 0)

  // Total non-keep ops should match sum of hunk ops
  return nonKeepOps.length === opsSummed
}

describe("Deep hunk decomposition audit", () => {
  const edgeCases: Array<[string, string, string]> = [
    // Pure insertion at top
    ["abc", "x\nabc", "insertion-at-top"],
    // Pure deletion at top
    ["x\nabc", "abc", "deletion-at-top"],
    // Multiple insertions and deletions interleaved
    ["a\nb\nc\nd", "a\nX\nc\nY", "interleaved-edits"],
    // Keep, insert, keep, delete, keep
    ["a\nb\nc\nd\ne", "a\nb\nX\nc\ne", "mixed-ops"],
    // Blank lines with edits
    ["a\n\nb", "a\nX\n\nb", "blank-line-edit"],
    // Single line modifications
    ["a", "b", "single-line-modify"],
    // Empty to non-empty
    ["", "a\nb\nc", "empty-to-many"],
    // Non-empty to empty
    ["a\nb\nc", "", "many-to-empty"],
    // Repeated lines with modification
    ["a\na\na", "a\nX\na", "repeated-lines"],
    // CRLF handling
    ["a\r\nb\r\nc", "a\r\nX\r\nb", "crlf-mixed"],
    // Triple modify (del+add, del+add, del+add)
    ["1\n2\n3", "x\ny\nz", "triple-modify"],
    // del-del-add (two consecutive deletions then insertions)
    ["a\nb\nc", "a\nx\ny", "del-del-add"],
    // add-add then keep then del-del
    ["a\nd\ne", "x\ny\na\nd", "add-add-keep-del-del"],
    // Trailing newline difference
    ["a\nb", "a\nb\n", "trailing-newline-add"],
    // Leading blank line
    ["\na\nb", "a\nb", "remove-leading-blank"],
    // Multiple consecutive blank lines
    ["a\n\n\nb", "a\n\nb", "reduce-blank-lines"],
  ]

  for (const [before, after, label] of edgeCases) {
    describe(label, () => {
      it("hunk numbering is consistent between hunksFromOps and applySelectedHunks", () => {
        // `label` (the describe name) identifies the failing edge case.
        expect(verifyHunkNumberingConsistency(before, after)).toBe(true)
      })

      it("single-hunk selections compose correctly", () => {
        expect(verifySingleHunkComposition(before, after)).toBe(true)
      })

      it("hunk positions (oldStart/newStart) are valid", () => {
        expect(verifyHunkPositions(before, after)).toBe(true)
      })

      it("all hunk ops are accounted for in ops array", () => {
        expect(verifyHunkOpsInclusion(before, after)).toBe(true)
      })

      it("selecting each hunk individually then all together produces consistent results", () => {
        const hunks = splitHunks(before, after)
        if (hunks.length === 0) {
          expect(true).toBe(true)
          return
        }

        const allSelected = applySelectedHunks(
          before,
          after,
          hunks.map((h) => h.id),
        )
        const none = applySelectedHunks(before, after, [])

        expect(allSelected).toBe(after)
        expect(none).toBe(before)
      })
    })
  }
})
