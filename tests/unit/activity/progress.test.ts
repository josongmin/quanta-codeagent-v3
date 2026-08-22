/**
 * RFC-04 (R6) D1 — closed progress union hellgate (aug-22 absorption).
 *
 * `Progress` is `indeterminate | ratio` and NOTHING else (D1 stop rule: no
 * free-form meta). `toProgress` validates/clamps; a malformed/unavailable ratio
 * collapses to `indeterminate` — git's OWN number or nothing, never a fabricated
 * bar (no-heuristics). `mergeProgress` guards regression.
 */

import { describe, expect, test } from "bun:test"
import { INDETERMINATE, type Progress, mergeProgress, progressEquals, toProgress } from "@/activity"

describe("D1 · toProgress (validate + clamp, never fabricate)", () => {
  test("a valid ratio passes through", () => {
    expect(toProgress(3, 10)).toEqual({ kind: "ratio", completed: 3, total: 10 })
  })
  test("completed > total clamps to total (a ratio never exceeds 100%)", () => {
    expect(toProgress(12, 10)).toEqual({ kind: "ratio", completed: 10, total: 10 })
  })
  test.each<[string, number, number]>([
    ["total == 0 (no denominator)", 3, 0],
    ["negative total", 3, -5],
    ["negative completed", -1, 10],
    ["NaN completed", Number.NaN, 10],
    ["+Infinity total", 3, Number.POSITIVE_INFINITY],
    ["-Infinity completed", Number.NEGATIVE_INFINITY, 10],
  ])("%s -> indeterminate", (_label, c, t) => {
    expect(toProgress(c, t)).toEqual(INDETERMINATE)
  })
})

describe("D1 · mergeProgress (forward-only, regression -> indeterminate)", () => {
  test("forward progress on the same total is accepted", () => {
    expect(mergeProgress(toProgress(2, 10), toProgress(5, 10))).toEqual({
      kind: "ratio",
      completed: 5,
      total: 10,
    })
  })
  test("regression on the same total collapses to indeterminate (never rewind)", () => {
    expect(mergeProgress(toProgress(8, 10), toProgress(3, 10))).toEqual(INDETERMINATE)
  })
  test("a NEW total (retry/next attempt) is accepted forward, not a regression", () => {
    expect(mergeProgress(toProgress(8, 10), toProgress(1, 20))).toEqual({
      kind: "ratio",
      completed: 1,
      total: 20,
    })
  })
  test("from indeterminate/absent, a ratio is accepted", () => {
    expect(mergeProgress(INDETERMINATE, toProgress(4, 10))).toEqual({
      kind: "ratio",
      completed: 4,
      total: 10,
    })
    expect(mergeProgress(undefined, toProgress(4, 10))).toEqual({
      kind: "ratio",
      completed: 4,
      total: 10,
    })
  })
  test("an incoming indeterminate always wins (explicit ratio-unknown)", () => {
    expect(mergeProgress(toProgress(4, 10), INDETERMINATE)).toEqual(INDETERMINATE)
  })
})

describe("D1 · progressEquals (drop no-op coalesced re-emits)", () => {
  test("equal ratios compare equal; differing do not", () => {
    const a: Progress = { kind: "ratio", completed: 5, total: 10 }
    expect(progressEquals(a, { kind: "ratio", completed: 5, total: 10 })).toBe(true)
    expect(progressEquals(a, { kind: "ratio", completed: 6, total: 10 })).toBe(false)
  })
  test("indeterminate equals only indeterminate", () => {
    expect(progressEquals(INDETERMINATE, { kind: "indeterminate" })).toBe(true)
    expect(progressEquals(INDETERMINATE, { kind: "ratio", completed: 0, total: 1 })).toBe(false)
  })
})
