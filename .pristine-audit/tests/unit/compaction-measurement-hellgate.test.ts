/**
 * D4 + D5 (jun-7 naive-impl hardening) hellgate — compaction measurement.
 *
 * D4: the proactive compaction threshold is DERIVED from the model's context
 *     window (`window − maxOutput − COMPACTION_SAFETY_MARGIN`) for a KNOWN
 *     model, with precedence `explicit → env → model-derived → 120k legacy`.
 *     An UNKNOWN model is byte-identical to the pre-D4 120k constant.
 *
 * D5: the trigger token count anchors on the provider's authoritative
 *     `inputTokens` baseline + chars/4 of ONLY the suffix appended since the
 *     measurement, instead of chars/4 over the whole transcript. Absent
 *     baseline ⇒ legacy chars/4 estimate, byte-identical.
 *
 * red-on-injection:
 *   - D4: dropping the model branch (threshold ignores the model) makes the
 *     known-model assertions RED; the unknown-model assertion stays GREEN.
 *   - D5: ignoring `tokenBaseline` (always chars/4 over everything) makes the
 *     "authoritative=150k estimate=115k ⇒ TRIGGERS" assertion RED while the
 *     "no baseline ⇒ MISSES (reproduces the bug)" assertion stays GREEN.
 */
import { describe, expect, test } from "bun:test"
import {
  compactIfNeeded,
  estimateTokens,
  markBaselineStaleIfShrunk,
  type TokenBaseline,
  triggerTokenCount,
} from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"
import { resolveModelWindow } from "@/llm/provider-metadata"

class SummarizingLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "SUMMARY" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** Build a transcript that ESTIMATES at ~`estTokens` chars/4 tokens, spread
 *  across alternating user/assistant turns so `findBoundary` has a summarizable
 *  prefix. Uses enough turns (default 16 ⇒ 8 assistant turns) that with
 *  `keepRecentTurns: KEEP` a non-trivial prefix remains foldable. */
const transcriptEstimating = (estTokens: number, turns = 16): Message[] => {
  const charsTotal = estTokens * 4
  const perTurn = Math.ceil(charsTotal / turns)
  const msgs: Message[] = []
  for (let i = 0; i < turns; i++) {
    const text = "x".repeat(perTurn)
    msgs.push(i % 2 === 0 ? userText(text) : assistantText(text))
  }
  return msgs
}

const SYSTEM: SystemPromptInput = "sys"
/** Small keep so a synthetic transcript has a summarizable prefix; the
 *  threshold/baseline behavior under test is orthogonal to the keep count. */
const KEEP = 2

describe("D4 — model-derived compaction threshold (via compactIfNeeded)", () => {
  // A transcript estimating ~150k chars/4 tokens. On a 200k-window Anthropic
  // model the derived threshold is 200_000 − 64_000 − 13_000 = 123_000, so a
  // 150k transcript is OVER and must compact. On an unknown model the legacy
  // 120k threshold also fires — so to isolate the model branch we use a count
  // BETWEEN the legacy 120k and the gpt-5 derived threshold.
  test("known small-window model (gpt-4o 128k) compacts EARLIER than 120k legacy", async () => {
    // gpt-4o derived threshold = 128_000 − 16_384 − 13_000 = 98_616. A 110k
    // transcript is UNDER the 120k legacy (would NOT compact) but OVER the
    // gpt-4o derived threshold (MUST compact). This isolates the model branch.
    const derived = resolveModelWindow("gpt-4o")
    expect(derived).toBeDefined()
    const messages = transcriptEstimating(110_000)
    expect(estimateTokens(messages)).toBeGreaterThan(98_616)
    expect(estimateTokens(messages)).toBeLessThan(120_000)

    const withModel = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      model: "gpt-4o",
      keepRecentTurns: KEEP,
    })
    expect(withModel.compacted).toBe(true)
  })

  test("UNKNOWN model ⇒ 120k legacy threshold, byte-identical (110k stays UNDER)", async () => {
    const messages = transcriptEstimating(110_000)
    const withUnknown = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      model: "mystery-llm-9000",
    })
    expect(withUnknown.compacted).toBe(false)
    // No `model` at all is identical to an unknown model.
    const withoutModel = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
    })
    expect(withoutModel.compacted).toBe(false)
  })

  test("explicit thresholdTokens override stays AUTHORITATIVE over the model", async () => {
    // Even on a known model, an explicit override wins. Set it absurdly high so
    // a 150k transcript does NOT compact (proving the model branch did not
    // override the explicit value).
    const messages = transcriptEstimating(150_000)
    const result = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      model: "gpt-4o",
      thresholdTokens: 5_000_000,
    })
    expect(result.compacted).toBe(false)
  })

  test("1M-window model (claude-sonnet-4-6-1m) does NOT compact a 150k transcript", async () => {
    // Derived = 1_000_000 − 64_000 − 13_000 = 923_000. A 150k transcript that
    // the 120k-blind legacy would have folded stays verbatim on a 1M model.
    const messages = transcriptEstimating(150_000)
    const result = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      model: "claude-sonnet-4-6-1m",
    })
    expect(result.compacted).toBe(false)
  })
})

describe("D5 — authoritative token baseline (triggerTokenCount + compactIfNeeded)", () => {
  test("triggerTokenCount: baseline anchors on authoritative + suffix estimate", () => {
    const messages = [userText("a".repeat(40)), assistantText("b".repeat(40))]
    const baseline: TokenBaseline = {
      measuredInputTokens: 100_000,
      // measured when only the first message existed → suffix = [msg1]
      measuredAtMessageCount: 1,
    }
    // 100_000 authoritative + chars/4 of the 40-char suffix (10) = 100_010.
    expect(triggerTokenCount(messages, baseline)).toBe(100_010)
    // No baseline ⇒ chars/4 over everything (80 chars → 20).
    expect(triggerTokenCount(messages)).toBe(20)
  })

  test("triggerTokenCount fail-safe: out-of-range measuredAtMessageCount ⇒ legacy", () => {
    const messages = [userText("a".repeat(40))]
    const stale: TokenBaseline = {
      measuredInputTokens: 999_999,
      measuredAtMessageCount: 5, // > messages.length → history replaced under it
    }
    expect(triggerTokenCount(messages, stale)).toBe(estimateTokens(messages))
  })

  test("triggerTokenCount fail-safe: non-finite / negative measurement ⇒ legacy", () => {
    const messages = [userText("a".repeat(40))]
    expect(
      triggerTokenCount(messages, {
        measuredInputTokens: Number.NaN,
        measuredAtMessageCount: 0,
      }),
    ).toBe(estimateTokens(messages))
    expect(
      triggerTokenCount(messages, {
        measuredInputTokens: -1,
        measuredAtMessageCount: 0,
      }),
    ).toBe(estimateTokens(messages))
  })

  test("code-dense fixture: authoritative=150k but estimate=115k — baseline TRIGGERS, no-baseline MISSES", async () => {
    // The chars/4 estimate under-counts code/JSON. Construct a transcript that
    // estimates ~115k (UNDER the 120k legacy gate) but whose provider-reported
    // authoritative input is 150k (OVER the gate) — the exact production bug.
    const messages = transcriptEstimating(115_000)
    expect(estimateTokens(messages)).toBeLessThan(120_000)

    // WITHOUT baseline (turn-1 / not exact): chars/4 wins → 115k < 120k → MISS.
    // This reproduces the current bug: a real 150k transcript is NOT compacted.
    const missed = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
    })
    expect(missed.compacted).toBe(false)

    // WITH the authoritative baseline: 150k anchor + tiny suffix > 120k → FIRE.
    const baseline: TokenBaseline = {
      measuredInputTokens: 150_000,
      measuredAtMessageCount: messages.length,
    }
    const triggered = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      tokenBaseline: baseline,
      keepRecentTurns: KEEP,
    })
    expect(triggered.compacted).toBe(true)
  })

  test("image/PDF proxy under-count: authoritative baseline overrides the fixed char proxy", async () => {
    // Many images estimate as a fixed 6000-char proxy each — well under any real
    // multi-image vision payload the provider actually bills. Interleave
    // assistant turns so `findBoundary` has a foldable prefix; the chars/4 proxy
    // still under-counts the true vision cost.
    const imageMsg: Message = {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "AAAA" }],
    }
    const messages: Message[] = []
    for (let i = 0; i < 16; i++) {
      messages.push(i % 2 === 0 ? imageMsg : assistantText("noted"))
    }
    // chars/4 proxy: 8 images × 6000 / 4 = 12_000 tokens — far under 120k.
    expect(estimateTokens(messages)).toBeLessThan(120_000)
    const missed = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      keepRecentTurns: KEEP,
    })
    expect(missed.compacted).toBe(false)

    // Provider authoritative input = 130k (real vision cost) → baseline fires.
    const triggered = await compactIfNeeded({
      messages,
      llm: new SummarizingLLM(),
      system: SYSTEM,
      keepRecentTurns: KEEP,
      tokenBaseline: { measuredInputTokens: 130_000, measuredAtMessageCount: messages.length },
    })
    expect(triggered.compacted).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// D5 STALE-BASELINE-ACROSS-COMPACTION (jun-7 audit R-concurrency).
// A baseline measured against a pre-compaction prefix becomes STALE once a
// compaction replaces that prefix: its `measuredAtMessageCount` index now points
// at different content. While the transcript is shorter than the index the
// `triggerTokenCount` out-of-range fail-safe hides it — but once it REGROWS past
// the index the fail-safe stops firing and the stale 150k baseline forces a
// premature compaction on a tiny transcript. `markBaselineStaleIfShrunk` (wired
// in prepareTurnContext on every shrinking compaction) closes this.
// ───────────────────────────────────────────────────────────────────────────

describe("D5 stale baseline is invalidated on a shrinking compaction", () => {
  const mk = (i: number): Message => ({
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `m${i} ${"x".repeat(80)}` }],
  })

  test("REPRODUCE the bug: an in-range stale baseline over-counts a tiny transcript", () => {
    const small = Array.from({ length: 45 }, (_, i) => mk(i)) // ~900 est tokens
    const stale: TokenBaseline = { measuredInputTokens: 150_000, measuredAtMessageCount: 40 }
    // 40 <= 45 ⇒ the out-of-range fail-safe does NOT fire, so the stale baseline
    // is used: 150_000 + estimate(suffix) ≫ the real ~900-token count.
    expect(triggerTokenCount(small, stale)).toBeGreaterThan(120_000)
    expect(estimateTokens(small)).toBeLessThan(5_000)
  })

  test("markBaselineStaleIfShrunk clears current when the transcript shrank (the fix)", () => {
    const box: { current?: TokenBaseline; sendCount?: number } = {
      current: { measuredInputTokens: 150_000, measuredAtMessageCount: 40 },
      sendCount: 42,
    }
    // A proactive compaction shrank 42 → 8 messages.
    markBaselineStaleIfShrunk(box, 42, 8)
    expect(box.current).toBeUndefined() // stale baseline dropped
  })

  test("markBaselineStaleIfShrunk is a NO-OP when the transcript grew or held steady", () => {
    const keep: TokenBaseline = { measuredInputTokens: 150_000, measuredAtMessageCount: 40 }
    const grew = { current: { ...keep }, sendCount: 42 }
    markBaselineStaleIfShrunk(grew, 42, 50) // grew ⇒ no compaction replaced the prefix
    expect(grew.current).toEqual(keep)
    const same = { current: { ...keep }, sendCount: 42 }
    markBaselineStaleIfShrunk(same, 42, 42)
    expect(same.current).toEqual(keep)
  })

  test("LIFECYCLE: invalidated baseline ⇒ a regrown tiny transcript does NOT over-trigger", () => {
    // Turn N captured a baseline against a big prefix.
    const box: { current?: TokenBaseline; sendCount?: number } = {
      current: { measuredInputTokens: 150_000, measuredAtMessageCount: 40 },
      sendCount: 42,
    }
    // Turn N+1 compacted 42 → 8 (prefix replaced) ⇒ invalidate.
    markBaselineStaleIfShrunk(box, 42, 8)
    // Turns later the transcript regrew to 45 small messages.
    const regrown = Array.from({ length: 45 }, (_, i) => mk(i))
    // With the baseline cleared the trigger is the legacy chars/4 estimate —
    // NOT the stale 150k — so no premature compaction. Red-on-injection: drop the
    // invalidation and this reverts to >120k (the bug above).
    expect(triggerTokenCount(regrown, box.current)).toBe(estimateTokens(regrown))
    expect(triggerTokenCount(regrown, box.current)).toBeLessThan(5_000)
  })
})
