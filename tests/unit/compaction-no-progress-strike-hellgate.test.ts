/**
 * ★ HELLGATE — T11 (loop + compaction no-progress accounting).
 *
 * Audited defect: a NO-OP compaction must NOT be silently treated as benign.
 *
 * (a) PROACTIVE giant-turn: `compactIfNeeded` returned a bare
 *     `{compacted:false}` both when UNDER the threshold (benign) AND when OVER
 *     the threshold but the transcript is one indivisible giant turn the
 *     orphan-safe boundary cannot split (`findBoundary <= 0`). The loop only
 *     recorded a breaker strike inside `if (result.compacted)`, so the
 *     over-budget no-op fed the breaker NOTHING — `maxNoProgressProactive`
 *     could never trip and the autocompact re-fired every turn with no headroom
 *     gained. FIX: `CompactResult` now carries a `reason` discriminator
 *     (`under_threshold` vs `no_boundary` vs `deferred`); the loop records a
 *     zero-progress strike (`recordProactive(before, before)`) only on
 *     `no_boundary`.
 *
 * (An earlier audit also proposed fail-closing reactiveCompact below
 * REACTIVE_MIN_INPUT_TOKENS on a zero/negative drop, but that reverses an
 * intentional, separately-tested tolerance and is redundant with the reactive
 * breaker, so it was deliberately NOT adopted — see compaction-breaker-hellgate
 * "tiny input below the floor is NOT failed".)
 */

import { describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent/compaction"
import { CompactionBreaker } from "@/agent/compaction-breaker"
import type { LLMPort, Message, StreamEvent } from "@/llm"

/** A throwing LLM — used to prove the over-budget-no-boundary path returns
 *  BEFORE the summarizer is ever consulted (the giant turn is unsummarizable,
 *  so calling the summarizer would be both wasteful and a contract leak). */
class NeverCalledLLM implements LLMPort {
  // biome-ignore lint/correctness/useYield: must throw if reached.
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("summarizer must NOT be called on the no_boundary path")
  }
}

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })

describe("T11(a) — compactIfNeeded no-op reason discriminator", () => {
  test("under threshold → {compacted:false, reason:'under_threshold'} (benign, no strike)", async () => {
    const res = await compactIfNeeded({
      messages: [textMsg("tiny")],
      llm: new NeverCalledLLM(),
      system: "sys",
      thresholdTokens: 1_000_000,
    })
    expect(res.compacted).toBe(false)
    if (!res.compacted) expect(res.reason).toBe("under_threshold")
  })

  test("over threshold but ONE indivisible giant turn → reason:'no_boundary' (no summarizer call)", async () => {
    // A single huge assistant turn. With any keepTurns the orphan-safe boundary
    // keeps that one turn, so findBoundary === 0 → nothing summarizable.
    const giant = textMsg("g".repeat(800_000)) // ~200k est tokens, > threshold
    const res = await compactIfNeeded({
      messages: [giant],
      llm: new NeverCalledLLM(),
      system: "sys",
      thresholdTokens: 120_000,
    })
    expect(res.compacted).toBe(false)
    // The discriminator is the whole point: this is NOT the same no-op as
    // under-threshold — it is over-budget-no-progress, which the loop MUST
    // turn into a breaker strike.
    if (!res.compacted) expect(res.reason).toBe("no_boundary")
  })

  test("the no_boundary strike actually trips the proactive cap (dead-knob regression)", () => {
    // Mirror the loop's wire: a no_boundary no-op feeds recordProactive(before,
    // before) — a zero-progress strike. After maxNoProgressProactive of them in
    // a row the breaker aborts. Before the fix this strike was never recorded
    // (it lived inside `if (result.compacted)`), so the cap was a dead knob.
    const before = 200_000
    const b = new CompactionBreaker({ maxNoProgressProactive: 3 })
    expect(b.check()).toEqual({ abort: false })
    b.recordProactive(before, before) // strike 1
    b.recordProactive(before, before) // strike 2
    expect(b.check()).toEqual({ abort: false }) // 2 allowed
    b.recordProactive(before, before) // strike 3 → trips
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) expect(v.reason).toContain("rapid_refill_breaker")
  })

  test("a productive proactive compaction RESETS the strike (no_boundary is the only striker)", () => {
    const b = new CompactionBreaker({ maxNoProgressProactive: 3 })
    b.recordProactive(200_000, 200_000) // no_boundary strike
    b.recordProactive(200_000, 200_000) // no_boundary strike
    // A real compaction lands (≥15% drop) — this is what `compacted:true`
    // records; it must clear the slate so a later giant turn starts fresh.
    b.recordProactive(200_000, 40_000)
    b.recordProactive(200_000, 200_000)
    b.recordProactive(200_000, 200_000)
    expect(b.check()).toEqual({ abort: false }) // only 2 since the reset
  })
})
