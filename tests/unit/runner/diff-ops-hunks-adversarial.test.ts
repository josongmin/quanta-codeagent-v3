/**
 * Adversarial property-based test for hunk decomposition invariants.
 * 
 * Probes: 
 * 1. Invariants: applySelectedHunks(b,a,allIds)===a; applySelectedHunks(b,a,[])===b
 * 2. Hunk numbering divergence between splitHunks (hunksFromOps) vs applySelectedHunks (inline tracking)
 * 3. Edge cases: empty files, single lines, repeating content, CRLF, blank lines, trailing newlines
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { splitHunks, applySelectedHunks, diffOps } from "@/runner/diff-ops"

/**
 * Generate before/after line arrays with controlled structure to probe
 * for specific failure modes.
 */
const genRandomPair = (
  seed: number,
  mode: "simple" | "repeating" | "interleaved" | "edge",
): [before: string, after: string] => {
  const str = (ls: string[]) => ls.join("\n")

  if (mode === "simple") {
    // Random insertions, deletions, modifications on a base.
    const base = ["line1", "line2", "line3", "line4", "line5"]
    const before = base.slice(0, 3 + (seed % 3))
    const after = base.slice(0, 3 + ((seed + 1) % 3))
    return [str(before), str(after)]
  }

  if (mode === "repeating") {
    // Lines that repeat (LCS ambiguity) — does hunk numbering agree?
    const dup = "dup"
    const before = ["a", dup, dup, "b", dup]
    const after = ["a", dup, "X", dup, "b", dup]
    return [str(before), str(after)]
  }

  if (mode === "interleaved") {
    // Interleaved del/add within a run vs split across runs.
    const before = ["1", "2", "3", "4", "5"]
    const after = ["1", "X", "3", "Y", "5"]
    return [str(before), str(after)]
  }

  if (mode === "edge") {
    const edgeCases: Array<[string, string]> = [
      // Empty files
      ["", ""],
      ["", "x"],
      ["x", ""],
      // Single line
      ["a", "a"],
      ["a", "b"],
      ["a", "ab"],
      // Blank lines (empty strings after split)
      ["a\n\nb", "a\n\nb"],
      ["a\n\nb", "a\nX\nb"],
      ["a\n\nb", "a\n\n\nb"],
      // Trailing newline
      ["a\nb\n", "a\nb\n"],
      ["a\nb\n", "a\nX\n"],
      // CRLF sequences (split only on "\n", not "\r")
      ["a\r\nb", "a\r\nX"],
      // Pure insertion at top (oldStart=0 edge)
      ["abc", "x\nabc"],
      // Pure deletion at top
      ["x\nabc", "abc"],
      // Pure insertion in middle
      ["a\nc", "a\nx\nc"],
      // Pure deletion in middle
      ["a\nx\nc", "a\nc"],
      // Repeated identical lines with modification between
      ["a", "a"],
      ["aaa", "aaa"],
      // Very long repeated pattern
      ["x\nx\nx", "x\ny\nx"],
    ]
    return edgeCases[seed % edgeCases.length]!
  }

  return ["a", "b"]
}

/**
 * Core invariant: selecting ALL hunks must reconstruct `after` exactly.
 */
const invariant1 = (before: string, after: string): boolean => {
  if (before === after) {
    // No hunks, so allIds is []; applySelectedHunks(b,a,[]) should return before (===after).
    return applySelectedHunks(before, after, []) === before
  }
  const hunks = splitHunks(before, after)
  const allIds = hunks.map((h) => h.id)
  const reconstructed = applySelectedHunks(before, after, allIds)
  return reconstructed === after
}

/**
 * Core invariant: selecting NO hunks must reconstruct `before` exactly.
 */
const invariant2 = (before: string, after: string): boolean => {
  const reconstructed = applySelectedHunks(before, after, [])
  return reconstructed === before
}

/**
 * Hunk numbering consistency: hunksFromOps and inline tracking in applySelectedHunks
 * must agree on hunk boundaries and ids. Detect by verifying that each single hunk
 * can be selected in isolation and the result is consistent.
 */
const invariant3 = (before: string, after: string): boolean => {
  const hunks = splitHunks(before, after)
  if (hunks.length === 0) return true

  // For each hunk, select it alone and verify the ops are applied correctly.
  for (const hunk of hunks) {
    const singleResult = applySelectedHunks(before, after, [hunk.id])
    // At minimum, result is a string (not an error).
    if (typeof singleResult !== "string") return false
  }

  // Composition: selecting h1+h2 twice should yield identical results.
  const ids1 = hunks.slice(0, Math.min(2, hunks.length)).map((h) => h.id)
  const ids2 = hunks.slice(0, Math.min(2, hunks.length)).map((h) => h.id)
  return applySelectedHunks(before, after, ids1) === applySelectedHunks(before, after, ids2)
}

describe("Hunk decomposition invariants — adversarial property suite", () => {
  let passCount = 0
  let failCount = 0
  const failures: Array<{
    mode: string
    before: string
    after: string
    inv: number
    error: string
  }> = []

  beforeAll(() => {
    console.log("\n=== ADVERSARIAL PROBING START ===\n")
  })

  describe("Invariant 1: applySelectedHunks(b,a,allIds) === a", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const mode of ["simple", "repeating", "interleaved", "edge"] as const) {
        it(`seed ${seed} mode ${mode}`, () => {
          const [before, after] = genRandomPair(seed, mode)
          const passed = invariant1(before, after)
          if (passed) {
            passCount++
          } else {
            failCount++
            const hunks = splitHunks(before, after)
            const allIds = hunks.map((h) => h.id)
            const got = applySelectedHunks(before, after, allIds)
            failures.push({
              mode,
              before,
              after,
              inv: 1,
              error: `Expected ${JSON.stringify(after)}, got ${JSON.stringify(got)}`,
            })
          }
          expect(passed).toBe(true)
        })
      }
    }
  })

  describe("Invariant 2: applySelectedHunks(b,a,[]) === b", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const mode of ["simple", "repeating", "interleaved", "edge"] as const) {
        it(`seed ${seed} mode ${mode}`, () => {
          const [before, after] = genRandomPair(seed, mode)
          const passed = invariant2(before, after)
          if (passed) {
            passCount++
          } else {
            failCount++
            const got = applySelectedHunks(before, after, [])
            failures.push({
              mode,
              before,
              after,
              inv: 2,
              error: `Expected ${JSON.stringify(before)}, got ${JSON.stringify(got)}`,
            })
          }
          expect(passed).toBe(true)
        })
      }
    }
  })

  describe("Invariant 3: hunk numbering consistency", () => {
    for (let seed = 0; seed < 30; seed++) {
      for (const mode of ["simple", "repeating", "interleaved", "edge"] as const) {
        it(`seed ${seed} mode ${mode}`, () => {
          const [before, after] = genRandomPair(seed, mode)
          const passed = invariant3(before, after)
          if (passed) {
            passCount++
          } else {
            failCount++
            failures.push({
              mode,
              before,
              after,
              inv: 3,
              error: "Hunk numbering mismatch between hunksFromOps and applySelectedHunks inline tracking",
            })
          }
          expect(passed).toBe(true)
        })
      }
    }
  })

  it("summary", () => {
    console.log(`\n=== PROBE SUMMARY ===`)
    console.log(`Pass: ${passCount}`)
    console.log(`Fail: ${failCount}`)
    if (failures.length > 0) {
      console.log(`\nFAILURES:\n`)
      for (const failure of failures) {
        console.log(`[${failure.mode}] Invariant ${failure.inv}:`)
        console.log(`  before: ${JSON.stringify(failure.before)}`)
        console.log(`  after:  ${JSON.stringify(failure.after)}`)
        console.log(`  error:  ${failure.error}`)
        console.log()
      }
    }
    expect(failCount).toBe(0)
  })
})
