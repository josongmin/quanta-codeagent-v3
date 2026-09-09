import { describe, expect, test } from "bun:test"
import { parseConflicts } from "@/git"
import {
  CANARY_INDICES,
  GIT_CASES,
  gitFuzzCanaryIds,
  gitFuzzCaseId,
  gitFuzzUniverseIds,
} from "./conflict-parser-fuzz-cases"

describe("conflict-parser fuzz canary enrollment", () => {
  test("canary indices are a subset of the existing 60-seed universe", () => {
    expect(GIT_CASES).toBe(60)
    expect(CANARY_INDICES).toHaveLength(6)
    for (const index of CANARY_INDICES) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(GIT_CASES)
    }
    const universe = new Set(gitFuzzUniverseIds())
    expect(universe.size).toBe(GIT_CASES)
    for (const id of gitFuzzCanaryIds()) {
      expect(universe.has(id)).toBe(true)
    }
  })

  test("exhaustive ∪ canary IDs equal the original case universe", () => {
    const exhaustive = gitFuzzUniverseIds()
    const combined = [...new Set([...exhaustive, ...gitFuzzCanaryIds()])].sort()
    expect(combined).toEqual([...exhaustive].sort())
  })

  test("known malformed markers stay typed (PR canary)", () => {
    for (const index of CANARY_INDICES) {
      const id = gitFuzzCaseId(index)
      const parsed = parseConflicts(`<<<<<<< ${id}\nours\n=======\ntheirs\n>>>>>>> ${id}\n`)
      expect(parsed.blocks.length).toBeGreaterThanOrEqual(1)
      expect(Array.isArray(parsed.diagnostics)).toBe(true)
    }
  })
})
