/**
 * GOAL-01 hellgate — objective identity.
 *
 * The legacy (v1) objective id is a versioned, LENGTH-DELIMITED canonical hash so
 * two different (threadId, goal) pairs that concatenate to the same bytes never
 * collide, and the same v1 record always migrates to the same id.
 */

import { describe, expect, test } from "bun:test"
import {
  defaultObjectiveIdFactory,
  legacyObjectiveId,
  MAX_GOAL_CHARS,
  normalizeGoalText,
} from "@/objective"

describe("GOAL-01 — legacy objective id", () => {
  test("is deterministic for the same v1 record", () => {
    const a = legacyObjectiveId({ threadId: "thr", goal: "ship", createdAt: 42 })
    const b = legacyObjectiveId({ threadId: "thr", goal: "ship", createdAt: 42 })
    expect(a).toBe(b)
    expect(a.startsWith("legacy-v1:")).toBe(true)
    expect(a.length).toBeGreaterThan("legacy-v1:".length + 32)
  })

  test("ambiguous concatenation pairs hash differently (length-delimited)", () => {
    const a = legacyObjectiveId({ threadId: "ab", goal: "c", createdAt: 1 })
    const b = legacyObjectiveId({ threadId: "a", goal: "bc", createdAt: 1 })
    expect(a).not.toBe(b)
    const c = legacyObjectiveId({ threadId: "a", goal: "b", createdAt: 11 })
    const d = legacyObjectiveId({ threadId: "a", goal: "b1", createdAt: 1 })
    expect(c).not.toBe(d)
  })

  test("createdAt participates in identity", () => {
    expect(legacyObjectiveId({ threadId: "t", goal: "g", createdAt: 1 })).not.toBe(
      legacyObjectiveId({ threadId: "t", goal: "g", createdAt: 2 }),
    )
  })
})

describe("GOAL-01 — default id factory + goal normalization", () => {
  test("the default factory mints unique non-legacy ids", () => {
    const ids = new Set(Array.from({ length: 64 }, () => defaultObjectiveIdFactory()))
    expect(ids.size).toBe(64)
    for (const id of ids) expect(id.startsWith("legacy-v1:")).toBe(false)
  })

  test("normalizeGoalText owns the 4000-character ceiling", () => {
    expect(MAX_GOAL_CHARS).toBe(4000)
    expect(normalizeGoalText("g".repeat(4000))).toBe("g".repeat(4000))
    expect(normalizeGoalText("g".repeat(4001))).toBeNull()
    expect(normalizeGoalText("")).toBeNull()
    expect(normalizeGoalText(42)).toBeNull()
  })
})
