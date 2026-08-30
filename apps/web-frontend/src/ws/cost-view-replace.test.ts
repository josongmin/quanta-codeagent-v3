/**
 * A7 — the cumulative cost snapshot REPLACES, never adds.
 *
 * `turn.completed.costView` is already the running total. Folding it the way
 * the legacy `tokenUsage` delta is folded would double-count the whole
 * session on every turn — the exact independent-ledger failure the web
 * surface had. The legacy fold survives ONLY for events with no snapshot
 * (old daemons / accounting off).
 */
import { describe, expect, it } from "vitest"
import type { CostSurfaceViewWire } from "../types/protocol.session.generated"
import { applySessionEventToTranscript, initialTranscript } from "./session-hooks"

const view = (totalUsd: number, calls: number): CostSurfaceViewWire => ({
  totalUsd,
  estimatedUsd: 0,
  unpricedCalls: 0,
  promptTokens: calls * 1_000,
  outputTokens: calls * 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls,
  rootUsd: totalUsd,
  subagentUsd: 0,
})

const completed = (over: Record<string, unknown>) =>
  ({
    eventId: "e",
    seq: 1,
    revision: 1,
    emittedAt: 1,
    causedByCommandId: "c",
    type: "turn.completed",
    outcomeReason: "completed",
    ...over,
  }) as never

describe("A7 — costView replace semantics", () => {
  it("two snapshot turns leave the SNAPSHOT total, not the sum of snapshots", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, completed({ costView: view(3, 1) }))
    state = applySessionEventToTranscript(state, completed({ costView: view(6, 2) }))
    // Additive handling would read 9 here — the mutation this test exists for.
    expect(state.costView?.totalUsd).toBe(6)
    expect(state.costView?.calls).toBe(2)
  })

  it("a snapshot-carrying event does NOT also fold the legacy delta", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(
      state,
      completed({
        costView: view(3, 1),
        tokenUsage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      }),
    )
    // Folding both would double-count; the legacy counter stays untouched.
    expect(state.tokenUsage.promptTokens).toBe(0)
    expect(state.costView?.totalUsd).toBe(3)
  })

  it("legacy events (no snapshot) keep the additive fallback exactly as before", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(
      state,
      completed({ tokenUsage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 } }),
    )
    state = applySessionEventToTranscript(
      state,
      completed({ tokenUsage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 } }),
    )
    expect(state.tokenUsage.promptTokens).toBe(1_000)
    expect(state.tokenUsage.turns).toBe(2)
    expect(state.costView).toBeNull()
  })

  it("a later legacy event never clears an established snapshot", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, completed({ costView: view(3, 1) }))
    state = applySessionEventToTranscript(
      state,
      completed({ tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    )
    expect(state.costView?.totalUsd).toBe(3)
  })
})
