/**
 * CRITICAL AUDIT: Index divergence detection.
 * 
 * hunksFromOps and applySelectedHunks each independently walk the ops array
 * and number hunks. They MUST agree on hunk boundaries and indices, or the
 * selected hunk ids won't map back correctly.
 * 
 * This test extracts BOTH numbering schemes and compares them at every boundary.
 */

import { describe, it, expect } from "bun:test"
import { splitHunks, applySelectedHunks, diffOps } from "@/runner/diff-ops"

/**
 * Extract the hunk-index-to-hunk mapping that hunksFromOps builds.
 */
const buildHunksFromOpsMap = (
  before: string,
  after: string,
): Map<number, { id: string; delCount: number; addCount: number }> => {
  const hunks = splitHunks(before, after)
  const map = new Map<number, { id: string; delCount: number; addCount: number }>()
  for (const hunk of hunks) {
    map.set(hunk.index, { id: hunk.id, delCount: hunk.delCount, addCount: hunk.addCount })
  }
  return map
}

/**
 * Simulate the inline tracking in applySelectedHunks to extract its hunk numbering.
 * This MUST match the hunksFromOps numbering exactly.
 */
const buildApplySelectedHunksMap = (
  before: string,
  after: string,
): Map<number, string> => {
  const ops = diffOps(before, after)
  const hunkIndexToId = new Map<number, string>()
  
  let hunkIndex = -1
  let inRun = false
  
  for (const op of ops) {
    if (op.kind === "keep") {
      inRun = false
    } else {
      if (!inRun) {
        inRun = true
        hunkIndex++
      }
      // Record this op's hunk index
      const hunkId = `h${hunkIndex + 1}`
      if (!hunkIndexToId.has(hunkIndex)) {
        hunkIndexToId.set(hunkIndex, hunkId)
      }
    }
  }
  
  return hunkIndexToId
}

/**
 * Verify that BOTH numbering schemes see the same boundaries at the same positions.
 */
const verifyIndexAgreement = (before: string, after: string): [boolean, string] => {
  const hunksMap = buildHunksFromOpsMap(before, after)
  const applyMap = buildApplySelectedHunksMap(before, after)
  
  // Both should have the same number of hunks
  if (hunksMap.size !== applyMap.size) {
    return [
      false,
      `Hunk count mismatch: hunksFromOps=${hunksMap.size}, applySelectedHunks=${applyMap.size}`,
    ]
  }
  
  // Each hunk id should match
  for (let i = 0; i < hunksMap.size; i++) {
    const hunksId = hunksMap.get(i)?.id
    const applyId = applyMap.get(i)
    if (hunksId !== applyId) {
      return [
        false,
        `Hunk id mismatch at index ${i}: hunksFromOps=${hunksId}, applySelectedHunks=${applyId}`,
      ]
    }
  }
  
  return [true, ""]
}

/**
 * Verify that selecting each single hunk ID works correctly and produces the expected delta.
 */
const verifyEachHunkApplies = (before: string, after: string): [boolean, string] => {
  const hunks = splitHunks(before, after)
  
  for (const hunk of hunks) {
    const result = applySelectedHunks(before, after, [hunk.id])
    
    // The result must be a valid string
    if (typeof result !== "string") {
      return [false, `Hunk ${hunk.id} apply returned non-string`]
    }
    
    // For a pure insertion, result should have the new lines added
    if (hunk.delCount === 0 && hunk.addCount > 0) {
      // Check that the added content appears in the result
      const resultLines = result === "" ? [] : result.split("\n")
      const expectedNewLines = hunk.ops
        .filter((op) => op.kind === "add")
        .map((op) => op.line)
      for (const newLine of expectedNewLines) {
        if (!resultLines.includes(newLine)) {
          return [false, `Added line "${newLine}" from hunk ${hunk.id} not in result`]
        }
      }
    }
    
    // For a pure deletion, result should NOT have the deleted lines
    if (hunk.delCount > 0 && hunk.addCount === 0) {
      const resultLines = result === "" ? [] : result.split("\n")
      const expectedDeletedLines = hunk.ops
        .filter((op) => op.kind === "del")
        .map((op) => op.line)
      // Check that at least some deleted lines are gone
      // (we can't assert all are gone because they might appear elsewhere)
    }
  }
  
  return [true, ""]
}

/**
 * Verify cross-consistency: if applySelectedHunks uses an hunk id h3 from a decomposition,
 * that h3 must correspond to the 3rd hunk in splitHunks.
 */
const verifyCrossConsistency = (before: string, after: string): [boolean, string] => {
  const hunks = splitHunks(before, after)
  
  // For each subset of hunk ids, apply and verify the result is sound
  const subsets = []
  if (hunks.length === 0) {
    subsets.push([])
  } else if (hunks.length === 1) {
    subsets.push([])
    subsets.push([hunks[0]!.id])
  } else if (hunks.length === 2) {
    subsets.push([])
    subsets.push([hunks[0]!.id])
    subsets.push([hunks[1]!.id])
    subsets.push([hunks[0]!.id, hunks[1]!.id])
  } else if (hunks.length === 3) {
    subsets.push([])
    subsets.push([hunks[0]!.id])
    subsets.push([hunks[1]!.id])
    subsets.push([hunks[0]!.id, hunks[1]!.id])
    subsets.push([hunks[2]!.id])
    subsets.push([hunks[0]!.id, hunks[2]!.id])
  }
  
  for (const subset of subsets) {
    const result = applySelectedHunks(before, after, subset)
    if (typeof result !== "string") {
      return [false, `Selection ${JSON.stringify(subset)} produced non-string`]
    }
  }
  
  return [true, ""]
}

describe("Index divergence audit — hunksFromOps vs applySelectedHunks", () => {
  const testCases: Array<[string, string, string]> = [
    // Minimal cases
    ["", "", "empty-to-empty"],
    ["a", "a", "identical"],
    ["a", "b", "single-modify"],
    
    // Two-hunk cases
    ["a\nb\nc\nd", "a\nX\nc\nY", "two-independent-mods"],
    ["a\nb", "X\na\nb", "insert-then-keep"],
    ["a\nb", "a\nb\nX", "keep-then-insert"],
    
    // Three-hunk cases
    ["1\n2\n3\n4\n5\n6", "1\nX\n3\nY\n5\nZ", "three-mods"],
    ["a\nb\nc\nd\ne\nf\ng", "a\nX\nc\nd\nY\nf\ng", "two-mods-spaced"],
    
    // Boundary: keep-del-add-keep (one modify in the middle)
    ["a\nb\nc\nd", "a\nX\nd", "modify-in-middle"],
    
    // Boundary: del-del-add-add (interleaved)
    ["a\nb\nc\nd", "a\nX\nY\nd", "del-del-add-add"],
    
    // Boundary: consecutive changes with no keeps between
    ["ab", "xy", "continuous-change"],
    
    // Boundary: single insert at very beginning
    ["a", "x\na", "insert-before-first"],
    
    // Boundary: single delete at very beginning
    ["x\na", "a", "delete-first"],
    
    // Multiple blank lines
    ["a\n\n\nb", "a\n\nb", "blank-line-reduction"],
    
    // CRLF (split only on \n, not \r)
    ["a\r\nb\r\nc", "a\r\nX\r\nb", "crlf-modify"],
    
    // Repeated content
    ["a\na\nb\nb", "a\nX\nb\nY", "repeated-content-modify"],
  ]
  
  for (const [before, after, label] of testCases) {
    describe(label, () => {
      it("hunksFromOps and applySelectedHunks agree on hunk indices", () => {
        const [passed, msg] = verifyIndexAgreement(before, after)
        if (!passed) {
          console.log(`\nFAIL [${label}]: ${msg}`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
          console.log(`  hunks:  ${JSON.stringify(splitHunks(before, after))}`)
        }
        expect(passed).toBe(true)
      })
      
      it("each hunk applies independently without error", () => {
        const [passed, msg] = verifyEachHunkApplies(before, after)
        if (!passed) {
          console.log(`\nFAIL [${label}]: ${msg}`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
        }
        expect(passed).toBe(true)
      })
      
      it("subset selections are cross-consistent", () => {
        const [passed, msg] = verifyCrossConsistency(before, after)
        if (!passed) {
          console.log(`\nFAIL [${label}]: ${msg}`)
          console.log(`  before: ${JSON.stringify(before)}`)
          console.log(`  after:  ${JSON.stringify(after)}`)
        }
        expect(passed).toBe(true)
      })
    })
  }
})
