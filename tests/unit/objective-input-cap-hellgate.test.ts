/**
 * R3 audit-M2/M3 closeout — zod input caps on `objective_set` /
 * `objective_update`. Pins the EXACT pass/reject boundaries so a future
 * refactor cannot loosen the caps without tripping this hellgate.
 *
 * Production constants (`src/tool/objective/index.ts`):
 *   - goal             min(1).max(8000)
 *   - success_criteria array(string.max(2000)).max(256)
 *   - reason (blocker) min(1).max(8000)
 *   - actions          array(string.max(2000)).max(256)
 *   - max_tokens/turns int().nonnegative().finite()
 */

import { describe, expect, test } from "bun:test"
import { objectiveSetSchema, objectiveUpdateSchema } from "@/tool/objective"

const repeat = (n: number): string => "a".repeat(n)

describe("R3 audit-M2/M3 — objective_set / objective_update input caps", () => {
  // ── (1) goal length boundary ───────────────────────────────────────────────
  test("(1) goal length 8000 PASSES; 8001 REJECTS", () => {
    expect(objectiveSetSchema.safeParse({ thread_id: "t", goal: repeat(8000) }).success).toBe(true)
    expect(objectiveSetSchema.safeParse({ thread_id: "t", goal: repeat(8001) }).success).toBe(false)
  })

  // ── (2) success_criteria item + array caps ─────────────────────────────────
  test("(2) success_criteria item length 2000 PASSES; 2001 REJECTS", () => {
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        success_criteria: [repeat(2000)],
      }).success,
    ).toBe(true)
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        success_criteria: [repeat(2001)],
      }).success,
    ).toBe(false)
  })

  test("(2b) success_criteria array length 256 PASSES; 257 REJECTS", () => {
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        success_criteria: new Array<string>(256).fill("x"),
      }).success,
    ).toBe(true)
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        success_criteria: new Array<string>(257).fill("x"),
      }).success,
    ).toBe(false)
  })

  // ── (3) addBlocker.reason boundary ─────────────────────────────────────────
  test("(3) update.addBlocker.reason length 8000 PASSES; 8001 REJECTS", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "addBlocker", reason: repeat(8000), waiting_on: "user" },
      }).success,
    ).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "addBlocker", reason: repeat(8001), waiting_on: "user" },
      }).success,
    ).toBe(false)
  })

  test("(3b) update.addBlocker.reason empty REJECTS (min 1)", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "addBlocker", reason: "", waiting_on: "user" },
      }).success,
    ).toBe(false)
  })

  // ── (4) nextActions item + array caps ──────────────────────────────────────
  test("(4) update.nextActions item length 2000 PASSES; 2001 REJECTS", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "nextActions", actions: [repeat(2000)] },
      }).success,
    ).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "nextActions", actions: [repeat(2001)] },
      }).success,
    ).toBe(false)
  })

  test("(4b) update.nextActions array length 256 PASSES; 257 REJECTS", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "nextActions", actions: new Array<string>(256).fill("x") },
      }).success,
    ).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "nextActions", actions: new Array<string>(257).fill("x") },
      }).success,
    ).toBe(false)
  })

  // ── numeric int/finite/nonneg tightening (NaN / Infinity / float / negative) ──
  test("(5) budget.max_tokens rejects NaN / Infinity / float / negative", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5]) {
      expect(
        objectiveSetSchema.safeParse({
          thread_id: "t",
          goal: "g",
          budget: { max_tokens: bad },
        }).success,
      ).toBe(false)
    }
  })

  test("(5b) budget.max_tokens accepts 0 + safe positive integer", () => {
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        budget: { max_tokens: 0 },
      }).success,
    ).toBe(true)
    expect(
      objectiveSetSchema.safeParse({
        thread_id: "t",
        goal: "g",
        budget: { max_tokens: 200_000 },
      }).success,
    ).toBe(true)
  })

  test("(5c) recordUsage.tokens / turns reject NaN / negative / float", () => {
    for (const bad of [Number.NaN, -1, 1.5]) {
      expect(
        objectiveUpdateSchema.safeParse({
          thread_id: "t",
          op: { kind: "recordUsage", tokens: bad },
        }).success,
      ).toBe(false)
      expect(
        objectiveUpdateSchema.safeParse({
          thread_id: "t",
          op: { kind: "recordUsage", turns: bad },
        }).success,
      ).toBe(false)
    }
  })
})
