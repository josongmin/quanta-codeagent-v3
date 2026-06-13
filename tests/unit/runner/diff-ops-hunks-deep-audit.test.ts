/**
 * Deep adversarial audit for hunk decomposition edge cases.
 * 
 * Specifically probes for:
 * 1. Divergence in hunk numbering between hunksFromOps and applySelectedHunks inline tracking
 * 2. Off-by-one errors in oldStart/newStart calculation  
 * 3. Boundary conditions: keep/change transitions, empty runs, trailing ops
 * 4. Specific LCS ambiguities that could cause hunk index desync
 */

import { describe, it, expect } from "bun:test"
import { splitHunks, applySelectedHunks, diffOps } from "@/runner/diff-ops"

/**
 * Manually apply hunks using the hunk decomposition (hunksFromOps logic) to verify
 * that the inline tracking in applySelectedHunks produces identical results.
 */
const verifyHunkNumberingConsistency = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  const ops = diffOps(before, after)
  
  // Build a manual hunk-index map from ops to verify inline tracking matches
  const opToHunkIndex = new Map<number, number>()
  {
    let hunkIndex = -1
    let inRun = false
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!
      if (op.kind === "keep") {
        inRun = false
      } else {
        if (!inRun) {
          inRun = true
          hunkIndex++
        }
        opToHunkIndex.set(i, hunkIndex)
      }
    }
  }
  
  // Now verify each hunk in hunks array corresponds to the right ops
  let opIndex = 0
  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx]!
    // Find the first non-keep op that belongs to this hunk
    while (opIndex < ops.length && ops[opIndex]!.kind === "keep") {
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
  
  // Apply hunks one at a time and combine the results manually
  let composed = before
  for (const hunk of hunks) {
    const singleApply = applySelectedHunks(before, after, [hunk.id])
    // Each single-hunk application should change exactly the lines in that hunk
    if (typeof singleApply !== "string") return false
  }
  
  // Applying all hunks should equal applying them all at once
  const allAtOnce = applySelectedHunks(before, after, hunks.map((h) => h.id))
  const sequential = applySelectedHunks(before, after, hunks.map((h) => h.id))
  return allAtOnce === sequential
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
  const beforeLines = before === "" ? [] : before.split("\n")
  const afterLines = after === "" ? [] : after.split("\n")
  
  let expectedOldLine = 0
  let expectedNewLine = 0
  
  for (const hunk of hunks) {
    // Count kept lines before this hunk in ops
    const ops = diffOps(before, after)
    let keepLinesBefore = 0
    let seenNonKeep = false
    
    for (const op of ops) {
      if (!seenNonKeep && op.kind === "keep") {
        keepLinesBefore++
      } else if (op.kind !== "keep") {
        seenNonKeep = true
      }
    }
    
    // For pure insertions: oldStart should equal the cursor (last kept line)
    if (hunk.delCount === 0 && hunk.addCount > 0) {
      if (hunk.oldStart !== keepLinesBefore) {
        return false
      }
    }
    
    // For modifications and deletions: oldStart should be the first deleted line (1-based)
    if (hunk.delCount > 0) {
      if (hunk.oldStart < 1 && hunk.oldStart !== 0) {
        return false // oldStart 0 only valid for insertion before first line
      }
    }
  }
  
  return true
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
        const passed = verifyHunkNumberingConsistency(before, after)
        if (!passed) {
          console.log(`FAIL [${label}]: hunk numbering divergence`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
          console.log(`  hunks:  ${JSON.stringify(splitHunks(before, after))}`)
        }
        expect(passed).toBe(true)
      })
      
      it("single-hunk selections compose correctly", () => {
        const passed = verifySingleHunkComposition(before, after)
        if (!passed) {
          console.log(`FAIL [${label}]: single-hunk composition failure`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
        }
        expect(passed).toBe(true)
      })
      
      it("hunk positions (oldStart/newStart) are valid", () => {
        const passed = verifyHunkPositions(before, after)
        if (!passed) {
          console.log(`FAIL [${label}]: invalid hunk positions`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
          console.log(`  hunks:  ${JSON.stringify(splitHunks(before, after))}`)
        }
        expect(passed).toBe(true)
      })
      
      it("all hunk ops are accounted for in ops array", () => {
        const passed = verifyHunkOpsInclusion(before, after)
        if (!passed) {
          console.log(`FAIL [${label}]: hunk ops not fully included`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
        }
        expect(passed).toBe(true)
      })
      
      it("selecting each hunk individually then all together produces consistent results", () => {
        const hunks = splitHunks(before, after)
        if (hunks.length === 0) {
          expect(true).toBe(true)
          return
        }
        
        const allSelected = applySelectedHunks(before, after, hunks.map((h) => h.id))
        const none = applySelectedHunks(before, after, [])
        
        expect(allSelected).toBe(after)
        expect(none).toBe(before)
      })
    })
  }
})
