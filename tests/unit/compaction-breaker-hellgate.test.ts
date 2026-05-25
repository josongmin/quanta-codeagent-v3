/**
 * ★ CONTRACT — D6: src/agent/compaction-breaker.ts CompactionBreaker. The
 *   3-strike consecutive-reactive-compaction boundary is EXACT off-by-one
 *   (2 allowed, 3rd trips with reason `rapid_refill_breaker`). The 15%
 *   progress-ratio threshold is INCLUSIVE on the documented side (use
 *   exported `DEFAULT_COMPACTION_BREAKER_CAPS`, no magic literals). Trip
 *   surfaces as a clean structured abort (not infinite spin, not maxTurns
 *   exhaustion). Healthy compaction (≥15% progress) resets the strike.
 */

import { describe, expect, test } from "bun:test"
import { CompactionBreaker, DEFAULT_COMPACTION_BREAKER_CAPS } from "@/agent/compaction-breaker"
import { reactiveCompact } from "@/agent/compaction"
import type { LLMPort, Message, StreamEvent } from "@/llm"

/**
 * D6 HELLGATE — the thrash breaker's EXACT boundaries.
 *
 * The breaker exists so an un-shrinkable prompt cannot spin the loop forever.
 * We pin (a) the 3-strike off-by-one and (b) the progress-ratio threshold from
 * both sides, using the ACTUAL exported constants — never a hardcoded literal,
 * so a future constant change is forced to update the contract here too.
 */

const { maxConsecutiveReactive: REACTIVE_CAP, minProgressRatio: RATIO } =
  DEFAULT_COMPACTION_BREAKER_CAPS

describe("D6 hellgate — reactive 3-strike off-by-one boundary", () => {
  test(`exactly ${REACTIVE_CAP - 1} no-progress reactive compactions are ALLOWED; the ${REACTIVE_CAP}th trips`, () => {
    const b = new CompactionBreaker()
    // Strikes 1..(CAP-1): each a no-progress compaction; the breaker must stay
    // closed BEFORE the cap is reached.
    for (let i = 1; i <= REACTIVE_CAP - 1; i++) {
      b.recordReactive(100_000, 99_000) // <15% drop ⇒ a strike
      expect(b.strikes.reactive).toBe(i)
      expect(b.check()).toEqual({ abort: false })
    }
    // The CAP-th strike trips it — and not one earlier.
    b.recordReactive(100_000, 99_000)
    expect(b.strikes.reactive).toBe(REACTIVE_CAP)
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      expect(v.reason).toContain("rapid_refill_breaker")
      expect(v.reason.toLowerCase()).toContain("reactive")
    }
  })

  test("a single progress run BEFORE the cap resets the count (no trip)", () => {
    const b = new CompactionBreaker()
    // Take CAP-1 strikes, then a productive compaction resets, then CAP-1 more:
    // never reaches the cap because the slate was cleared.
    for (let i = 0; i < REACTIVE_CAP - 1; i++) b.recordReactive(100_000, 99_000)
    b.recordReactive(100_000, 10_000) // 90% drop ⇒ resets
    expect(b.strikes.reactive).toBe(0)
    for (let i = 0; i < REACTIVE_CAP - 1; i++) b.recordReactive(100_000, 99_000)
    expect(b.check()).toEqual({ abort: false })
  })
})

describe("D6 hellgate — progress-ratio threshold from both sides", () => {
  // The contract: a compaction counts as PROGRESS iff (before-after)/before >=
  // minProgressRatio. So "just above the ratio" resets; "just below" is a
  // strike. We build before/after pairs straddling the exact threshold.
  const before = 1_000_000

  test(`a drop JUST ABOVE ${RATIO} does NOT count as a strike (resets)`, () => {
    const b = new CompactionBreaker()
    // First take a strike so we can observe a reset.
    b.recordReactive(100_000, 99_000)
    expect(b.strikes.reactive).toBe(1)
    // Drop ratio strictly above the threshold ⇒ progress ⇒ reset.
    const after = Math.floor(before * (1 - (RATIO + 0.01)))
    expect((before - after) / before).toBeGreaterThan(RATIO)
    b.recordReactive(before, after)
    expect(b.strikes.reactive).toBe(0)
  })

  test(`a drop JUST BELOW ${RATIO} DOES count as a strike`, () => {
    const b = new CompactionBreaker()
    const after = Math.ceil(before * (1 - (RATIO - 0.01)))
    expect((before - after) / before).toBeLessThan(RATIO)
    b.recordReactive(before, after)
    expect(b.strikes.reactive).toBe(1)
  })

  test(`a drop EXACTLY AT ${RATIO} counts as progress (>= is inclusive)`, () => {
    const b = new CompactionBreaker()
    b.recordReactive(100_000, 99_000) // seed one strike
    expect(b.strikes.reactive).toBe(1)
    const after = before - Math.round(before * RATIO) // exactly RATIO drop
    expect((before - after) / before).toBeCloseTo(RATIO, 10)
    b.recordReactive(before, after)
    // Inclusive `>=` ⇒ exactly-at-threshold is progress ⇒ resets.
    expect(b.strikes.reactive).toBe(0)
  })
})

describe("D6 hellgate — proactive boundary mirrors reactive", () => {
  const PROACTIVE_CAP = DEFAULT_COMPACTION_BREAKER_CAPS.maxNoProgressProactive
  test(`the ${PROACTIVE_CAP}th no-progress proactive compaction trips the circuit breaker`, () => {
    const b = new CompactionBreaker()
    for (let i = 1; i <= PROACTIVE_CAP - 1; i++) {
      b.recordProactive(200_000, 199_000)
      expect(b.check()).toEqual({ abort: false })
    }
    b.recordProactive(200_000, 199_000)
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      expect(v.reason).toContain("rapid_refill_breaker")
      expect(v.reason).toContain("circuit")
    }
  })
})

describe("D6 hellgate — trip surfaces a CLEAN error verdict (not a spin)", () => {
  test("a tripped breaker returns a structured halt verdict with a human reason, deterministically", () => {
    const b = new CompactionBreaker({ maxConsecutiveReactive: 1 })
    b.recordReactive(100_000, 99_999) // ~0% drop ⇒ instant strike at cap=1
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      // A non-empty, actionable string — surfaces as the loop error reason,
      // NOT a thrown exception, NOT undefined, NOT maxTurns exhaustion.
      expect(typeof v.reason).toBe("string")
      expect(v.reason.length).toBeGreaterThan(20)
      expect(v.reason).toContain("rapid_refill_breaker")
    }
    // Idempotent: checking again does not change the verdict (no hidden state
    // drift that could spin). Stays tripped.
    expect(b.check().abort).toBe(true)
  })

  test("a degenerate before<=0 compaction never trips (cannot spin on a no-op)", () => {
    const b = new CompactionBreaker({ maxConsecutiveReactive: 1 })
    for (let i = 0; i < 5; i++) b.recordReactive(0, 0)
    expect(b.strikes.reactive).toBe(0)
    expect(b.check()).toEqual({ abort: false })
  })
})

/* ------------------------------------------------------------------ */
/* merged from compaction-breaker.test.ts */
/* ------------------------------------------------------------------ */

describe("CompactionBreaker — defaults & clean path", () => {
  test("fresh breaker stays on clean path; defaults track CC (3/3/0.15)", () => {
    expect(DEFAULT_COMPACTION_BREAKER_CAPS).toEqual({
      maxConsecutiveReactive: 3,
      maxNoProgressProactive: 3,
      minProgressRatio: 0.15,
    })
    const b = new CompactionBreaker()
    expect(b.check()).toEqual({ abort: false })
    expect(b.strikes).toEqual({ reactive: 0, proactive: 0 })
  })

  test("productive compactions never trip the breaker", () => {
    const b = new CompactionBreaker()
    for (let i = 0; i < 10; i++) {
      // 100k → 40k is a 60% drop: clear progress.
      b.recordReactive(100_000, 40_000)
      b.recordProactive(100_000, 40_000)
    }
    expect(b.check()).toEqual({ abort: false })
    expect(b.strikes).toEqual({ reactive: 0, proactive: 0 })
  })

  test("a no-op compaction (before<=0) counts as progress, not a strike", () => {
    const b = new CompactionBreaker()
    b.recordReactive(0, 0)
    b.recordProactive(0, 0)
    expect(b.strikes).toEqual({ reactive: 0, proactive: 0 })
    expect(b.check()).toEqual({ abort: false })
  })
})

describe("CompactionBreaker — reactive thrash", () => {
  test("trips after N consecutive no-progress reactive compactions", () => {
    const b = new CompactionBreaker()
    // < 15% drop each time = no progress.
    b.recordReactive(100_000, 95_000)
    expect(b.check()).toEqual({ abort: false })
    b.recordReactive(100_000, 96_000)
    expect(b.check()).toEqual({ abort: false })
    b.recordReactive(100_000, 99_000)
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) expect(v.reason).toContain("rapid_refill_breaker")
  })

  test("a productive run resets the reactive counter (noteProgress-equivalent)", () => {
    const b = new CompactionBreaker()
    b.recordReactive(100_000, 99_000)
    b.recordReactive(100_000, 99_000)
    expect(b.strikes.reactive).toBe(2)
    b.recordReactive(100_000, 10_000) // big drop → resets
    expect(b.strikes.reactive).toBe(0)
    b.recordReactive(100_000, 99_000)
    expect(b.check()).toEqual({ abort: false })
  })

  test("respects a custom cap", () => {
    const b = new CompactionBreaker({ maxConsecutiveReactive: 2 })
    b.recordReactive(100_000, 99_000)
    expect(b.check()).toEqual({ abort: false })
    b.recordReactive(100_000, 99_000)
    expect(b.check().abort).toBe(true)
  })
})

describe("CompactionBreaker — proactive thrash", () => {
  test("trips after N consecutive no-progress proactive compactions", () => {
    const b = new CompactionBreaker()
    for (let i = 0; i < 3; i++) {
      expect(b.check()).toEqual({ abort: false })
      b.recordProactive(200_000, 199_000)
    }
    const v = b.check()
    expect(v.abort).toBe(true)
    if (v.abort) {
      expect(v.reason).toContain("rapid_refill_breaker")
      expect(v.reason).toContain("circuit")
    }
  })

  test("custom minProgressRatio changes what counts as progress", () => {
    // Require a 50% drop. A 40% drop now counts as no progress.
    const b = new CompactionBreaker({ minProgressRatio: 0.5 })
    b.recordProactive(100_000, 60_000) // 40% drop < 50% → strike
    b.recordProactive(100_000, 60_000)
    b.recordProactive(100_000, 60_000)
    expect(b.check().abort).toBe(true)
  })
})

describe("CompactionBreaker — noteProgress", () => {
  test("noteProgress resets both counters", () => {
    const b = new CompactionBreaker()
    b.recordReactive(100_000, 99_000)
    b.recordReactive(100_000, 99_000)
    b.recordProactive(100_000, 99_000)
    b.recordProactive(100_000, 99_000)
    expect(b.strikes).toEqual({ reactive: 2, proactive: 2 })
    b.noteProgress()
    expect(b.strikes).toEqual({ reactive: 0, proactive: 0 })
    expect(b.check()).toEqual({ abort: false })
  })

  test("noteProgress between strikes prevents a trip", () => {
    const b = new CompactionBreaker()
    b.recordReactive(100_000, 99_000)
    b.recordReactive(100_000, 99_000)
    b.noteProgress()
    b.recordReactive(100_000, 99_000)
    // Only one strike since the reset → no abort.
    expect(b.check()).toEqual({ abort: false })
  })
})

class FixedLLM implements LLMPort {
  constructor(private readonly summary: string) {}
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const assistant = (...content: Message["content"]): Message => ({
  role: "assistant",
  content,
})
const textMsg = (text: string): Message => assistant({ type: "text", text })

describe("reactiveCompact — fail-fast when nothing meaningful is shed", () => {
  test("large input + un-shrinkable retained suffix → ok:false (no <15% drop)", async () => {
    // A giant tool_result lives in the retained suffix (its tool_use is in
    // the kept tail too, so the orphan-safe boundary cannot drop it). The
    // summarizable prefix is tiny → the build barely shrinks the prompt.
    const giant = "x".repeat(200_000) // ~50k est tokens, all in the suffix
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      textMsg("a tiny old turn"),
      assistant({ type: "tool_use", id: "t1", name: "read", input: {} }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: giant }] },
      textMsg("recent answer"),
    ]
    const res = await reactiveCompact({
      messages: msgs,
      llm: new FixedLLM("<summary>short</summary>"),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toContain("freed no meaningful context")
      expect(res.reason).toContain("retained suffix")
    }
  })

  test("large input that DOES shrink meaningfully still succeeds", async () => {
    // Giant payload is in the SUMMARIZED prefix this time → it gets dropped.
    const giant = "y".repeat(200_000)
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant({ type: "tool_use", id: "t1", name: "read", input: {} }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: giant }] },
      textMsg("old turn"),
      { role: "user", content: [{ type: "text", text: "recent" }] },
      textMsg("recent answer"),
    ]
    const res = await reactiveCompact({
      messages: msgs,
      llm: new FixedLLM("<summary>condensed</summary>"),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(res.ok).toBe(true)
  })

  test("tiny input (below the floor) is NOT failed even if it grows", async () => {
    // Regression guard: the synthetic header can exceed a trivial prefix.
    // This is the exact shape exercised by recovery.test.ts.
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant({ type: "tool_use", id: "t1", name: "read", input: {} }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
      textMsg("older"),
      { role: "user", content: [{ type: "text", text: "recent" }] },
      textMsg("recent answer"),
    ]
    const res = await reactiveCompact({
      messages: msgs,
      llm: new FixedLLM("<summary>resume here</summary>"),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(res.ok).toBe(true)
  })

  test("existing fail cases still win (empty boundary / empty summary)", async () => {
    const noPrefix = await reactiveCompact({
      messages: [textMsg("only one giant turn")],
      llm: new FixedLLM("x"),
      system: "sys",
      keepRecentTurns: 6,
    })
    expect(noPrefix.ok).toBe(false)
    if (!noPrefix.ok) expect(noPrefix.reason).toContain("no summarizable prefix")

    const emptySummary = await reactiveCompact({
      messages: [textMsg("a"), textMsg("b"), textMsg("c")],
      llm: new FixedLLM("   "),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(emptySummary.ok).toBe(false)
    if (!emptySummary.ok) expect(emptySummary.reason).toContain("empty")
  })
})
