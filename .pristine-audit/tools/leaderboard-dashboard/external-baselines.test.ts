import { describe, expect, test } from "bun:test"
import {
  buildExternalBaselines,
  parseLiveLeaderboard,
  proBaselines,
  sotaFor,
} from "./external-baselines"

describe("parseLiveLeaderboard — tolerant int|array resolved", () => {
  const jsonl = [
    JSON.stringify({ name: "A", set: "lite", total: 300, resolved: 189 }), // count form
    JSON.stringify({ name: "B", set: "full", total: 4, resolved: ["x__1", "x__2"] }), // array form
    JSON.stringify({ name: "C", set: "full", total: 4, resolved: ["x__2"] }),
    "not json — must be skipped",
    JSON.stringify({ name: "D", total: 0, resolved: 5 }), // total<=0 dropped
  ].join("\n")

  test("count form ⇒ rate; array form ⇒ rate + per-instance resolved-by", () => {
    const { models, liveResolvedBy } = parseLiveLeaderboard(jsonl, "test")
    const a = models.find((m) => m.name === "A")!
    expect(a.rate).toBeCloseTo(189 / 300)
    const b = models.find((m) => m.name === "B")!
    expect(b.resolved).toBe(2)
    expect(b.rate).toBeCloseTo(0.5)
    // x__2 resolved by BOTH B and C; x__1 only B.
    expect(liveResolvedBy["x__2"]).toEqual(["B", "C"])
    expect(liveResolvedBy["x__1"]).toEqual(["B"])
  })

  test("malformed line skipped, total<=0 dropped, never throws", () => {
    const { models } = parseLiveLeaderboard(jsonl, "test")
    expect(models.map((m) => m.name).sort()).toEqual(["A", "B", "C"])
  })

  test("empty input ⇒ empty (fail-safe)", () => {
    expect(parseLiveLeaderboard("", "test").models).toEqual([])
  })
})

describe("proBaselines + sotaFor", () => {
  test("Pro curated baselines carry the 731-public set + provenance-stable rates", () => {
    const pro = proBaselines()
    expect(pro.every((m) => m.dataset === "pro" && m.set === "public-731" && m.total === 731)).toBe(
      true,
    )
    expect(pro[0]!.rate).toBeGreaterThan(0.5) // SOTA gpt-5.4
  })

  test("sotaFor picks the TOP rate for a (dataset,set)", () => {
    const b = buildExternalBaselines(
      [
        JSON.stringify({ name: "lo", set: "verified", total: 500, resolved: 100 }),
        JSON.stringify({ name: "hi", set: "verified", total: 500, resolved: 250 }),
      ].join("\n"),
      "src",
    )
    expect(sotaFor(b, "live", "verified")!.name).toBe("hi")
    expect(sotaFor(b, "pro", "public-731")!.rate).toBeGreaterThanOrEqual(0.59)
  })
})
