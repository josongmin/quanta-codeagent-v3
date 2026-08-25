/**
 * R3 audit-M2/M3 closeout — zod input caps on `objective_set` /
 * `objective_update`. Pins the EXACT pass/reject boundaries so a future
 * refactor cannot loosen the caps without tripping this hellgate.
 *
 * Production constants (`src/tool/objective/index.ts`):
 *   - goal             min(1).max(MAX_GOAL_CHARS = 4000) — GOAL-01: the ceiling
 *                      is DOMAIN-owned (`@/objective`), no longer the tool's 8000
 *   - success_criteria array(string.max(2000)).max(256)
 *   - reason (blocker) min(1).max(8000)
 *   - actions          array(string.max(2000)).max(256)
 *   - max_tokens/turns int().nonnegative().finite()
 *   - status op        REMOVED — GOAL-02: status is host-owned (GOAL-01 had
 *                      narrowed it to active|paused; `completed` is derived)
 *   - recordUsage op   REMOVED — GOAL-01: usage is host-settled, never self-reported
 *   - markCriterion /  REMOVED — GOAL-02: completion is user attestation +
 *     clearBlocker op  verifier receipts; only addBlocker + nextActions remain
 *   - thread_id        OPTIONAL and ignored — GOAL-02: the thread is session-bound
 */

import { describe, expect, test } from "bun:test"
import { MAX_GOAL_CHARS } from "@/objective"
import { objectiveGetSchema, objectiveSetSchema, objectiveUpdateSchema } from "@/tool/objective"

const repeat = (n: number): string => "a".repeat(n)

describe("R3 audit-M2/M3 — objective_set / objective_update input caps", () => {
  // ── (1) goal length boundary ───────────────────────────────────────────────
  // GOAL-01: the cap moved from the tool's 8000 to the domain's MAX_GOAL_CHARS
  // (4000). Pin BOTH the symbolic boundary and the literal so a domain-side
  // loosening cannot hide behind the import.
  test("(1) goal length MAX_GOAL_CHARS (4000) PASSES; +1 REJECTS", () => {
    expect(MAX_GOAL_CHARS).toBe(4000)
    expect(
      objectiveSetSchema.safeParse({ thread_id: "t", goal: repeat(MAX_GOAL_CHARS) }).success,
    ).toBe(true)
    expect(
      objectiveSetSchema.safeParse({ thread_id: "t", goal: repeat(MAX_GOAL_CHARS + 1) }).success,
    ).toBe(false)
    // The old 8000 ceiling is no longer accepted.
    expect(objectiveSetSchema.safeParse({ thread_id: "t", goal: repeat(8000) }).success).toBe(false)
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
        op: {
          kind: "addBlocker",
          reason: repeat(8000),
          waiting_on: "user",
          dependency_target: { kind: "approval", ref: "deploy" },
        },
      }).success,
    ).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: {
          kind: "addBlocker",
          reason: repeat(8001),
          waiting_on: "user",
          dependency_target: { kind: "approval", ref: "deploy" },
        },
      }).success,
    ).toBe(false)
  })

  test("(3b) update.addBlocker.reason empty REJECTS (min 1)", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: {
          kind: "addBlocker",
          reason: "",
          waiting_on: "user",
          dependency_target: { kind: "approval", ref: "deploy" },
        },
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

  // GOAL-01 (REVERSED): this case used to pin the numeric tightening of the
  // `recordUsage` op. The op is REMOVED (usage is host-settled), so the schema
  // now rejects it OUTRIGHT — including a perfectly well-formed payload. The
  // hostile numerics stay in the loop so a future re-introduction of the op
  // cannot sneak past on the "bad" values alone.
  test("(5c) recordUsage op is rejected outright (well-formed AND hostile numerics)", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "recordUsage", tokens: 1, turns: 1 },
      }).success,
    ).toBe(false)
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

  // GOAL-02 (REVERSED): GOAL-01 had narrowed the explicit status intent to
  // `active | paused`. Status is HOST-owned now — the `status` op is REMOVED
  // from the model schema, so the formerly-accepted values are rejected exactly
  // like `completed` and the derived limit states.
  test("(6) status op is rejected outright (active|paused AND completed + derived states)", () => {
    for (const status of [
      "active",
      "paused",
      "completed",
      "blocked",
      "usage_limited",
      "budget_limited",
      "",
    ]) {
      expect(
        objectiveUpdateSchema.safeParse({ thread_id: "t", op: { kind: "status", status } }).success,
      ).toBe(false)
    }
  })

  // GOAL-02: criterion completion and blocker clearing are not model ops —
  // well-formed payloads are rejected at the schema; only addBlocker and
  // nextActions survive as the model's update surface.
  test("(7) markCriterion + clearBlocker ops are rejected outright; addBlocker + nextActions remain", () => {
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "markCriterion", criterion_id: "c1", met: true },
      }).success,
    ).toBe(false)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "markCriterion", criterion_id: "c1", met: false },
      }).success,
    ).toBe(false)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: { kind: "clearBlocker", blocker_id: "b1" },
      }).success,
    ).toBe(false)
    expect(
      objectiveUpdateSchema.safeParse({
        thread_id: "t",
        op: {
          kind: "addBlocker",
          reason: "r",
          waiting_on: "tool",
          dependency_target: { kind: "tool", ref: "remote" },
        },
      }).success,
    ).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({ thread_id: "t", op: { kind: "nextActions", actions: [] } })
        .success,
    ).toBe(true)
  })

  // GOAL-02: `thread_id` is deprecated and IGNORED — the thread is bound by the
  // session (`ctx.ownerId`), so its absence is not a validation failure on any
  // of the three tools. (The fail-closed session binding is pinned in
  // objective-tools-hellgate.)
  test("(8) thread_id is optional on objective_set / objective_update / objective_get", () => {
    expect(objectiveSetSchema.safeParse({ goal: "g" }).success).toBe(true)
    expect(
      objectiveUpdateSchema.safeParse({ op: { kind: "nextActions", actions: ["a"] } }).success,
    ).toBe(true)
    expect(objectiveGetSchema.safeParse({}).success).toBe(true)
  })
})
