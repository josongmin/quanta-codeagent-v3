import { describe, expect, test } from "bun:test"
import { parseConflicts } from "@/git"
import {
  CANARY_INDICES,
  GIT_CASES,
  gitFuzzCanaryIds,
  gitFuzzCaseId,
  gitFuzzNightlyIds,
  gitFuzzUniverseIds,
  NIGHTLY_INDICES,
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

  test("PR canary and nightly remainder are disjoint and cover the original universe", () => {
    expect(NIGHTLY_INDICES).toHaveLength(GIT_CASES - CANARY_INDICES.length)
    const canary = new Set(gitFuzzCanaryIds())
    const nightly = new Set(gitFuzzNightlyIds())
    for (const id of canary) expect(nightly.has(id)).toBe(false)
    const combined = [...new Set([...canary, ...nightly])].sort()
    expect(combined).toEqual([...gitFuzzUniverseIds()].sort())
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
