/**
 * ★ HELLGATE — parse_test_failure js-stack ReDoS (wave-4 RESOURCE_EXHAUSTION).
 *
 * The js-stack rule regex had no leading boundary anchor, so its greedy negated
 * class was re-attempted at every offset: a single long no-boundary run
 * ("a.a.a…") backtracked O(n^2), and a few-hundred-KB crafted log (attacker-
 * influenced CI/test output) pinned the event loop for tens of seconds.
 * FIX: boundary-anchor the file token (?:^|[\s(]) + trailing lookahead — same
 * shape as the `generic` rule — so the scan is LINEAR regardless of input size
 * (no arbitrary input cap; the regex itself is the fix).
 */
import { describe, expect, test } from "bun:test"
import { parseTestFailure } from "@/tool"

describe("parse_test_failure is linear (no ReDoS) and still correct", () => {
  test("a 320KB single-line pathological blob parses in well under a second", () => {
    // The exact catastrophic shape: one long whitespace/paren/colon-free run of
    // "a." with no valid :line:col ending. Old regex: ~64s. Fixed: ~0ms.
    const blob = "a.".repeat(160_000) // ~320KB, single line
    const start = Date.now()
    const frames = parseTestFailure(blob, 30)
    const elapsedMs = Date.now() - start
    expect(elapsedMs).toBeLessThan(500) // linear; was tens of seconds
    expect(frames).toEqual([]) // no real frame in the blob
  })

  test("real JS stack frames are still extracted (no regression)", () => {
    const out = [
      "FAIL src/foo.test.ts",
      "    at Object.<anonymous> (/repo/src/foo.ts:12:34)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "  (/repo/src/bar.mjs:7:1)",
    ].join("\n")
    const frames = parseTestFailure(out, 30)
    expect(frames).toContainEqual(expect.objectContaining({ file: "/repo/src/foo.ts", line: 12 }))
    expect(frames).toContainEqual(expect.objectContaining({ file: "/repo/src/bar.mjs", line: 7 }))
  })

  test("a long line that DOES end in a valid frame still matches in linear time", () => {
    const prefix = "x".repeat(200_000)
    const out = `${prefix} (/repo/src/q.ts:9:9)`
    const start = Date.now()
    const frames = parseTestFailure(out, 30)
    expect(Date.now() - start).toBeLessThan(500)
    expect(frames).toContainEqual(expect.objectContaining({ file: "/repo/src/q.ts", line: 9 }))
  })
})
