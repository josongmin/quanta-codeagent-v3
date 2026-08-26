/**
 * Moved here 2026-08-27 from the REPO ROOT (`test-t05-audit.test.ts`), where it
 * had sat since 2026-08-24 as the one test file living outside every directory
 * any glob names — so nothing ran it and nothing linted it. The unused `node:fs`
 * / `node:os` / `splitHunks` imports and the three dead fixture constants it
 * arrived with are the evidence of the second half of that: they were removed in
 * the same move. See `tests/unit/_arch/gated-test-scope-ratchet.test.ts`.
 */

import { describe, expect, it } from "bun:test"
import { parseHunkSelection } from "@/apps/cli/repl/hunk-select"

describe("T05 Audit - parseHunkSelection pathological inputs", () => {
  const ids = ["h1", "h2", "h3", "h4", "h5"]

  it("huge range 1-999999999 should not hang", () => {
    const start = Date.now()
    const result = parseHunkSelection("1-999999999", ids)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100)
    expect(result).toEqual(ids)
  })

  it("malformed '-1' silently drops", () => {
    expect(parseHunkSelection("-1", ids)).toEqual([])
  })

  it("'1-' missing end silently drops", () => {
    expect(parseHunkSelection("1-", ids)).toEqual([])
  })

  it("'0' out of range 1-based silently drops", () => {
    expect(parseHunkSelection("0", ids)).toEqual([])
  })
})
