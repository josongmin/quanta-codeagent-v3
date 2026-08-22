import { describe, expect, test } from "bun:test"
import { DEFAULT_EVICTION_CAPS, EVICTION_DECAY, planEviction } from "@/memory/eviction"
import type { MemoryEntry } from "@/memory/types"

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

const entry = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
  kind: "fact",
  text: "",
  tags: [],
  tier: "semantic",
  createdAt: NOW,
  ...over,
})

describe("eviction — constants", () => {
  test("defaults exposed", () => {
    expect(DEFAULT_EVICTION_CAPS).toEqual({ semanticMax: 500, episodicMax: 200 })
    expect(EVICTION_DECAY).toBe(0.5)
  })
})

describe("eviction — cap overflow", () => {
  test("keeps highest-value, deletes lowest-value overflow per tier", () => {
    const cand = [
      entry({ id: "keep1", importance: 0.9, createdAt: NOW }),
      entry({ id: "keep2", importance: 0.8, createdAt: NOW }),
      entry({ id: "drop", importance: 0.1, createdAt: NOW }),
    ]
    const plan = planEviction(cand, { semanticMax: 2 }, NOW)
    expect(plan.delete).toEqual(["drop"])
    expect(plan.decay).toEqual([])
  })

  test("tiers are bounded independently", () => {
    const cand = [
      entry({ id: "s1", tier: "semantic", importance: 0.9 }),
      entry({ id: "s2", tier: "semantic", importance: 0.1 }),
      entry({ id: "e1", tier: "episodic", importance: 0.9 }),
      entry({ id: "e2", tier: "episodic", importance: 0.1 }),
    ]
    const plan = planEviction(cand, { semanticMax: 1, episodicMax: 1 }, NOW)
    expect(plan.delete.sort()).toEqual(["e2", "s2"])
  })
})

describe("eviction — ancient superseded delete", () => {
  test("superseded + age > 30d is deleted regardless of cap", () => {
    const cand = [
      entry({ id: "ancient", supersededBy: "x", createdAt: NOW - 40 * DAY }),
      entry({ id: "fresh-sup", supersededBy: "x", createdAt: NOW }),
    ]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.delete).toEqual(["ancient"])
  })
})

describe("eviction — decay set", () => {
  test("archived survivors with importance>0.05 go to decay (not delete)", () => {
    const cand = [
      entry({ id: "arch-hi", importance: 0.5, createdAt: NOW - 40 * DAY }),
      entry({ id: "arch-lo", importance: 0.01, createdAt: NOW - 40 * DAY }),
      entry({ id: "fresh", importance: 0.5, createdAt: NOW }),
    ]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.decay).toEqual(["arch-hi"])
    expect(plan.delete).toEqual([])
  })

  test("delete wins over decay (id in at most one list)", () => {
    const cand = [
      // archived AND superseded-ancient → must be delete only
      entry({
        id: "both",
        importance: 0.9,
        supersededBy: "y",
        createdAt: NOW - 40 * DAY,
      }),
    ]
    const plan = planEviction(cand, undefined, NOW)
    expect(plan.delete).toEqual(["both"])
    expect(plan.decay).toEqual([])
  })
})

describe("eviction — determinism", () => {
  test("ordering value desc, createdAt desc, id desc", () => {
    const cand = [
      entry({ id: "a", importance: 0.1, createdAt: NOW }),
      entry({ id: "b", importance: 0.1, createdAt: NOW }),
      entry({ id: "c", importance: 0.1, createdAt: NOW }),
    ]
    // cap 0 → all deleted, sorted value(equal) → createdAt(equal) → id desc
    const plan = planEviction(cand, { semanticMax: 0 }, NOW)
    expect(plan.delete).toEqual(["c", "b", "a"])
  })

  test("pure: same input → same output", () => {
    const cand = [entry({ id: "z", importance: 0.3, createdAt: NOW - 40 * DAY })]
    expect(planEviction(cand, undefined, NOW)).toEqual(planEviction(cand, undefined, NOW))
  })
})
