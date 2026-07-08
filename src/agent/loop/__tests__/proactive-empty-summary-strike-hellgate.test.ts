/**
 * ★ HELLGATE — ALBB-08 Fix 1 (proactive `empty_summary` breaker strike WIRE).
 *
 * Audited defect: `applyProactiveResult` (compaction-wire) recorded a
 * `recordProactive(before, before)` no-progress strike ONLY on
 * `reason === "no_boundary"`. A summarizer that returns `""` yields
 * `{compacted:false, reason:"empty_summary"}` from `compactIfNeeded`; that fell
 * through the `else if` with NO strike. Because an empty summary leaves the
 * transcript unshrunk and STILL over-threshold, `maybeCompact` re-fires next turn,
 * the same refusing summarizer returns `""` again, and `proactiveStrikes` never
 * increments — so `maxNoProgressProactive` (CC `z_K=3`,
 * `tengu_auto_compact_circuit_breaker`) NEVER trips. Unbounded re-compaction spin.
 *
 * The EXISTING hellgate (`tests/unit/compaction-no-progress-strike-hellgate.test.ts`)
 * drives `compactIfNeeded`'s `no_boundary` return AND the breaker UNIT directly, but
 * does NOT drive `applyProactiveResult`'s `empty_summary` WIRE — the untested gap.
 *
 * This test drives the REAL `maybeCompact` → `runProactiveTier2` → `compactIfNeeded`
 * (empty summarizer) → `applyProactiveResult` path against a LIVE `CompactionBreaker`
 * N = maxNoProgressProactive times and asserts the breaker trips.
 *
 * RED-on-injection: revert Fix 1 (drop `empty_summary` from
 * `UNPRODUCTIVE_PROACTIVE_REASONS`, i.e. back to `else if (reason === "no_boundary")`)
 * and the (N+1)th `maybeCompact` keeps returning `{abort:false}` (the spin) — RED.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { CompactionBreaker } from "../../compaction-breaker"
import { maybeCompact } from "../compaction-wire"
import type { AgentConfig } from "../../types"

/** A summarizer that ALWAYS refuses — emits an empty text turn ⇒ `summarize(...)`
 *  trims to `""` ⇒ `compactIfNeeded` returns `{compacted:false, reason:"empty_summary"}`. */
const refusingSummarizerLlm: LLMPort = {
  model: "refusing-summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "   " } // whitespace only ⇒ trims to ""
    }
    return gen()
  },
}

/** Minimal AgentConfig for the proactive path. `keepRecentTurns:1` forces a real
 *  boundary (so `compactIfNeeded` reaches the summarizer rather than returning
 *  `no_boundary`); `thresholdTokens:1` keeps the fat transcript over-threshold on
 *  every turn (so the proactive path keeps re-firing — the spin condition). */
const makeConfig = (): AgentConfig =>
  ({
    system: "sys",
    llm: refusingSummarizerLlm,
    stream: { emit() {} },
    compaction: { summarizerLlm: refusingSummarizerLlm, keepRecentTurns: 1, thresholdTokens: 1 },
  }) as unknown as AgentConfig

/** A multi-turn transcript, fat enough to sit over the threshold and with a real
 *  summarizable boundary (>1 turn). */
const seedMessages = (): Message[] =>
  Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(400)}` }],
  }))

const noopReset = (): void => {}

describe("ALBB-08 Fix 1 — proactive empty_summary trips the futility breaker (WIRE)", () => {
  test("N consecutive empty_summary outcomes trip maxNoProgressProactive", async () => {
    const CAP = 3
    const wm = createWorkingMemory(seedMessages())
    const before = [...wm.snapshot()]
    const breaker = new CompactionBreaker({ maxNoProgressProactive: CAP })

    const call = (): ReturnType<typeof maybeCompact> =>
      maybeCompact({
        config: makeConfig(),
        system: "sys" as never,
        wm,
        breaker,
        archive: undefined,
        turn: 1,
        bgController: undefined,
        resetClassifier: noopReset,
        tokenBaselineBox: undefined,
      })

    // Calls 1..CAP each hit compactIfNeeded → empty_summary → a proactive strike.
    // The breaker's `.check()` runs at the START of each call, so strike K is only
    // observed on call K+1: call CAP+1's check() is the one that trips.
    for (let k = 1; k <= CAP; k++) {
      const v = await call()
      // Not yet tripped while strikes < CAP.
      expect(v.abort).toBe(false)
      // Vacuity guard: the refusing summarizer never shrank the transcript, so it
      // stayed unshrunk and over-threshold across EVERY call (the spin condition).
      expect(wm.snapshot().length).toBe(before.length)
    }
    // The proactive strike counter reached the cap.
    expect(breaker.strikes.proactive).toBe(CAP)

    // The (CAP+1)th call's opening `.check()` now trips the circuit breaker.
    const tripped = await call()
    expect(tripped.abort).toBe(true)
    if (tripped.abort)
      expect(tripped.reason).toContain("rapid_refill_breaker: proactive")
  })
})
