/**
 * HELLGATE — every kernel terminal arm keeps `lastStopCategory` honest
 * (aug-23 §13 / objective-audit follow-up)
 *
 * `onTurnCompleted` carries the outcome's category onto state. The other three
 * arms — aborted / failed / errored — set `lastOutcomeReason` but spread
 * `...args.state`, so:
 *
 *   (a) the RICH signal is discarded (`onTurnErrored` receives an outcome that
 *       may carry `provider.rate_limit`, `compaction.thrash`, `loop.no_progress`
 *       and drops it), and
 *   (b) worse, the PREVIOUS turn's category survives into the new state, so a
 *       failed turn can be projected with a stale `completed.normal` — a
 *       success label on a failure, which is exactly the class of defect this
 *       whole workstream exists to remove.
 *
 * Invariants:
 *
 *  H1  NO STALE CARRY-OVER — after a terminal that has no category of its own,
 *      a category from an earlier turn must NOT remain on state.
 *  H2  RICH SIGNAL PRESERVED — when the errored outcome carries a category, it
 *      reaches state rather than being dropped.
 *  H3  PAIRED CONTROL — the completed arm still carries its category (the fix
 *      is not "always clear").
 *  H4  REASON AND CATEGORY AGREE — whenever both are present, the category's
 *      kind matches the mapping for the reason.
 */

import { describe, expect, test } from "bun:test"
import { STOP_CATEGORY_KIND_BY_STOP_REASON } from "@/agent/stop-category"
import { nextStateForTerminalTest } from "@/kernel/session/scheduler-turn-terminals"

const priorState = {
  lastOutcomeReason: "completed",
  lastStopCategory: { kind: "completed", reasonCode: "completed.normal" },
} as const

describe("H1 — a terminal with no category clears the stale one", () => {
  test.each([["aborted"], ["error"]])("%s does not inherit the prior category", (reason) => {
    const next = nextStateForTerminalTest({ prior: priorState, reason })
    expect(next.lastOutcomeReason).toBe(reason)
    expect(next.lastStopCategory?.reasonCode).not.toBe("completed.normal")
  })
})

describe("H2 — a category on the outcome is preserved", () => {
  test("errored carries provider.rate_limit through", () => {
    const next = nextStateForTerminalTest({
      prior: priorState,
      reason: "error",
      category: { kind: "failed", reasonCode: "provider.rate_limit" },
    })
    expect(next.lastStopCategory?.reasonCode).toBe("provider.rate_limit")
  })
})

describe("H3 — paired control", () => {
  test("a completed terminal still carries its own category", () => {
    const next = nextStateForTerminalTest({
      prior: { lastOutcomeReason: "error" },
      reason: "completed",
      category: { kind: "completed", reasonCode: "completed.normal" },
    })
    expect(next.lastStopCategory?.reasonCode).toBe("completed.normal")
  })
})

describe("H4 — reason and category never disagree", () => {
  test.each([["aborted"], ["error"], ["completed"]])("%s agrees with the mapping", (reason) => {
    const next = nextStateForTerminalTest({ prior: priorState, reason })
    const category = next.lastStopCategory
    if (category === undefined) return
    expect(category.kind).toBe(
      STOP_CATEGORY_KIND_BY_STOP_REASON[reason as keyof typeof STOP_CATEGORY_KIND_BY_STOP_REASON],
    )
  })
})
