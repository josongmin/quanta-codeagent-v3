/**
 * HELLGATE — StopCategory producer completeness (aug-23 Grok-Build diff, 우선순위 0 / slice 1a)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13. An audit found our
 * 18-code StopCategory taxonomy is written and never read, AND that one terminal
 * path produces an outcome with NO stopCategory at all. Wiring surfaces (slice
 * 1d) is pointless if a producer can still emit an uncategorized outcome — the
 * surface would fall back to success copy, which is exactly the competitor bug
 * we are trying not to reproduce.
 *
 * Adversarial invariants pinned here:
 *
 *  H1  EVERY `StopReason` union member maps to a `StopCategoryKind`. Enforced as
 *      a `Record<StopReason, StopCategoryKind>` so adding a `StopReason` fails
 *      COMPILATION, plus a runtime drift guard so a stale/extra key fails at
 *      module load (the `promax/classify.ts:140-156` precedent).
 *
 *  H2  `approvalPlaceholderOutcome` carries a `stopCategory`. Today it returns
 *      `{reason:"awaiting_approval", turns:0, messages}` with the field absent
 *      (`src/host/runtime/internal/context-binding/approval-support.ts:167`).
 *
 *  H3  RED-ON-INJECTION: the drift guard must actually fire. A table with a
 *      missing key and a table with an extra key must both throw — a guard that
 *      silently passes is worse than none.
 *
 *  H4  PAIRED CONTROL: the kind assigned to `awaiting_approval` must NOT be
 *      `completed`/`max_turns`. A paused-for-approval turn rendered as success
 *      is the precise failure mode under audit.
 */

import { describe, expect, test } from "bun:test"
import type { StopCategoryKind } from "@/agent/stop-category"
import {
  assertStopReasonTablesInSync,
  STOP_CATEGORY_KIND_BY_STOP_REASON,
} from "@/agent/stop-category"
import type { StopReason } from "@/agent/types/agent-outcome"
import { approvalPlaceholderOutcome } from "@/host/runtime/internal/context-binding/approval-support"

/** The legacy union, spelled out. Kept literal on purpose: if `StopReason`
 *  gains a member this array stays stale, and H1's Record type + the runtime
 *  guard below are what catch it. */
const ALL_STOP_REASONS: readonly StopReason[] = [
  "completed",
  "max_turns",
  "aborted",
  "error",
  "budget_exhausted",
  "refusal",
  "awaiting_approval",
] as const

describe("H1 — every StopReason has a StopCategoryKind", () => {
  test("the mapping table covers the union exactly", () => {
    for (const reason of ALL_STOP_REASONS) {
      const kind = STOP_CATEGORY_KIND_BY_STOP_REASON[reason]
      expect(kind, `StopReason "${reason}" has no StopCategoryKind`).toBeDefined()
      expect(typeof kind).toBe("string")
    }
    expect(Object.keys(STOP_CATEGORY_KIND_BY_STOP_REASON).sort()).toEqual(
      [...ALL_STOP_REASONS].sort(),
    )
  })

  test("the runtime drift guard passes on the shipped table", () => {
    expect(() => {
      assertStopReasonTablesInSync()
    }).not.toThrow()
  })
})

describe("H3 — the drift guard is not vacuous (red-on-injection)", () => {
  test("a MISSING key throws", () => {
    const holed = { ...STOP_CATEGORY_KIND_BY_STOP_REASON } as Record<string, StopCategoryKind>
    delete holed.refusal
    expect(() => {
      assertStopReasonTablesInSync(holed, ALL_STOP_REASONS)
    }).toThrow(/refusal/)
  })

  test("an EXTRA key throws", () => {
    const bloated = {
      ...STOP_CATEGORY_KIND_BY_STOP_REASON,
      not_a_real_reason: "failed",
    } as Record<string, StopCategoryKind>
    expect(() => {
      assertStopReasonTablesInSync(bloated, ALL_STOP_REASONS)
    }).toThrow(/not_a_real_reason/)
  })
})

describe("H2 — approvalPlaceholderOutcome is categorized", () => {
  test("carries a stopCategory", () => {
    const outcome = approvalPlaceholderOutcome([])
    expect(outcome.reason).toBe("awaiting_approval")
    expect(
      outcome.stopCategory,
      "a paused-for-approval outcome must be categorized, else a surface renders it as success",
    ).toBeDefined()
  })

  test("H4 paired control — it is NOT categorized as a success bucket", () => {
    const outcome = approvalPlaceholderOutcome([])
    const kind = outcome.stopCategory?.kind
    expect(kind).toBeDefined()
    expect(kind).not.toBe("completed")
    expect(kind).not.toBe("max_turns")
  })

  test("its kind agrees with the mapping table", () => {
    const outcome = approvalPlaceholderOutcome([])
    expect(outcome.stopCategory?.kind).toBe(STOP_CATEGORY_KIND_BY_STOP_REASON.awaiting_approval)
  })
})
