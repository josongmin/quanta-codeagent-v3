import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseHunkSelection } from "@/apps/cli/repl/hunk-select"
import { splitHunks } from "@/runner/diff-ops"

const fresh = (): string => mkdtempSync(join(tmpdir(), "t05-audit-"))
const B = ["line1", "line2", "line3", "line4", "line5"].join("\n")
const A = ["line1", "L2X", "line3", "L4X", "line5"].join("\n")

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
