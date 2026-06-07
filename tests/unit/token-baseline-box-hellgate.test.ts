/**
 * ★ HELLGATE — S2 (jun-7 FINAL) `TokenBaselineBox` class.
 *
 * The bare `{ current?, sendCount? }` box accreted FOUR scattered correctness
 * patches across 8 audit rounds; S2 consolidates them into ONE owner. This
 * battery exercises all FOUR invariants the class now OWNS, each with a
 * red-on-injection note (what breaks if the guard is dropped):
 *
 *   (1) capture — provider-aware cache-bucket arithmetic + empty-model guard +
 *       the `>= sentEstimate` exactness gate.
 *   (2) invalidateOnShrink — length-based stale clear after a shrinking compaction.
 *   (3) invalidateOnContentChange — microcompact replaces tool_result CONTENT
 *       while keeping the COUNT (the length check structurally misses it).
 *   (4) trigger — the in-range fail-safe + suffix-estimate anchored on the
 *       authoritative baseline.
 *
 * The class WRAPS the shared mutable box the loop allocates once per session, so
 * we construct a plain `{ current?, sendCount? }` and `TokenBaselineBox.wrap` it.
 */
import { describe, expect, test } from "bun:test"
import { TokenBaselineBox, type TokenBaselineBoxState } from "@/agent"
import type { Message } from "@/llm"

const ANTHROPIC = "claude-opus-4-8"
const OPENAI = "gpt-5"

const mkBox = (sendCount?: number): TokenBaselineBoxState => ({ sendCount, current: undefined })

const userMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

// ── (1) capture — provider-aware cache arithmetic + exactness gate ──────────
describe("TokenBaselineBox.capture — invariant (1): provider cache buckets", () => {
  test("anthropic cache-HIT: inputTokens(200)+cacheRead(149800) ⇒ 150k captured", () => {
    const box = mkBox(10)
    TokenBaselineBox.wrap(box).capture(
      { inputTokens: 200, cacheReadTokens: 149_800, model: ANTHROPIC },
      120_000,
    )
    expect(box.current).toEqual({ measuredInputTokens: 150_000, measuredAtMessageCount: 10 })
  })

  test("anthropic cache-creation bucket also summed", () => {
    const box = mkBox(7)
    TokenBaselineBox.wrap(box).capture(
      { inputTokens: 1_000, cacheCreationTokens: 130_000, model: ANTHROPIC },
      120_000,
    )
    expect(box.current).toEqual({ measuredInputTokens: 131_000, measuredAtMessageCount: 7 })
  })

  test("OpenAI does NOT add cacheRead (prompt_tokens already includes it)", () => {
    // Red-on-injection: drop the openai branch ⇒ records 190_000 (~2x the real
    // prompt) ⇒ premature compaction discarding history.
    const box = mkBox(4)
    TokenBaselineBox.wrap(box).capture(
      { inputTokens: 100_000, cacheReadTokens: 90_000, model: OPENAI },
      50_000,
    )
    expect(box.current).toEqual({ measuredInputTokens: 100_000, measuredAtMessageCount: 4 })
  })

  test("EMPTY model id does NOT add cache buckets (the empty-model double-count guard)", () => {
    // `providerOf("")` defaults to "anthropic"; without the `model !== ""` guard
    // an OpenAI-shaped cache-hit (100k incl. 90k cached) double-counts to 190k.
    // Red-on-injection: drop `usage.model !== ""` ⇒ this records 190_000.
    const box = mkBox(4)
    TokenBaselineBox.wrap(box).capture(
      { inputTokens: 100_000, cacheReadTokens: 90_000, model: "" },
      50_000,
    )
    expect(box.current).toEqual({ measuredInputTokens: 100_000, measuredAtMessageCount: 4 })
  })

  test("below the estimate ⇒ NOT captured (the exactness gate) ⇒ legacy chars/4", () => {
    const box = mkBox(10)
    TokenBaselineBox.wrap(box).capture({ inputTokens: 200, model: ANTHROPIC }, 120_000)
    expect(box.current).toBeUndefined()
  })

  test("no sendCount recorded yet ⇒ no capture", () => {
    const box = mkBox(undefined)
    TokenBaselineBox.wrap(box).capture({ inputTokens: 130_000, model: ANTHROPIC }, 120_000)
    expect(box.current).toBeUndefined()
  })

  test("non-finite authoritative input ignored (fail-safe)", () => {
    const box = mkBox(3)
    TokenBaselineBox.wrap(box).capture(
      { inputTokens: Number.NaN, cacheReadTokens: 149_800, model: ANTHROPIC },
      120_000,
    )
    expect(box.current).toBeUndefined()
  })
})

// ── (2) invalidateOnShrink — length-based stale clear ───────────────────────
describe("TokenBaselineBox.invalidateOnShrink — invariant (2)", () => {
  test("clears current when the transcript shrank (prefix replaced by compaction)", () => {
    const box = mkBox(42)
    box.current = { measuredInputTokens: 150_000, measuredAtMessageCount: 42 }
    TokenBaselineBox.wrap(box).invalidateOnShrink(42, 8)
    // Red-on-injection: drop the shrink clear ⇒ a stale 150k baseline survives
    // and forces a premature compaction once the tiny transcript regrows.
    expect(box.current).toBeUndefined()
  })

  test("NO-OP when the transcript grew or held steady (no prefix replacement)", () => {
    const grew = mkBox(42)
    grew.current = { measuredInputTokens: 9_000, measuredAtMessageCount: 42 }
    TokenBaselineBox.wrap(grew).invalidateOnShrink(42, 50)
    expect(grew.current).toEqual({ measuredInputTokens: 9_000, measuredAtMessageCount: 42 })

    const same = mkBox(42)
    same.current = { measuredInputTokens: 9_000, measuredAtMessageCount: 42 }
    TokenBaselineBox.wrap(same).invalidateOnShrink(42, 42)
    expect(same.current).toEqual({ measuredInputTokens: 9_000, measuredAtMessageCount: 42 })
  })
})

// ── (3) invalidateOnContentChange — microcompact (count-stable) ─────────────
describe("TokenBaselineBox.invalidateOnContentChange — invariant (3)", () => {
  test("clears current after a content-only shrink the length check cannot see", () => {
    const box = mkBox(20)
    box.current = { measuredInputTokens: 180_000, measuredAtMessageCount: 20 }
    // A microcompact replaced a fat tool_result with a spill reference: the
    // message COUNT is unchanged (20 → 20) so invalidateOnShrink would NO-OP,
    // but the prefix-measured 180k baseline is now stale.
    TokenBaselineBox.wrap(box).invalidateOnShrink(20, 20) // count-stable ⇒ no-op
    expect(box.current).not.toBeUndefined()
    TokenBaselineBox.wrap(box).invalidateOnContentChange()
    // Red-on-injection: drop invalidateOnContentChange ⇒ the stale 180k baseline
    // survives a content shrink ⇒ premature tier-2 compaction on a now-small set.
    expect(box.current).toBeUndefined()
  })
})

// ── (4) trigger — in-range fail-safe + suffix estimate ──────────────────────
describe("TokenBaselineBox.trigger — invariant (4)", () => {
  test("anchors on authoritative baseline + chars/4 of ONLY the appended suffix", () => {
    const box = mkBox(2)
    box.current = { measuredInputTokens: 100_000, measuredAtMessageCount: 2 }
    // 2 measured messages + 1 appended (40 chars ⇒ ceil(40/4)=10 tokens).
    const messages = [userMsg("a"), userMsg("b"), userMsg("c".repeat(40))]
    expect(TokenBaselineBox.wrap(box).trigger(messages)).toBe(100_010)
  })

  test("fail-safe: out-of-range measuredAtMessageCount ⇒ legacy chars/4 over the whole set", () => {
    const box = mkBox(99)
    // index 99 no longer maps onto a 3-message transcript (history replaced).
    box.current = { measuredInputTokens: 500_000, measuredAtMessageCount: 99 }
    const messages = [userMsg("a"), userMsg("b"), userMsg("c")]
    // Red-on-injection: drop the `> messages.length` guard ⇒ trigger returns a
    // huge stale 500k value ⇒ a tiny transcript compacts prematurely.
    const v = TokenBaselineBox.wrap(box).trigger(messages)
    expect(v).toBeLessThan(1_000)
  })

  test("no baseline ⇒ pure chars/4 estimate", () => {
    const box = mkBox(3)
    const messages = [userMsg("hello world")]
    expect(TokenBaselineBox.wrap(box).trigger(messages)).toBe(Math.ceil("hello world".length / 4))
  })
})

// ── recordSendCount / currentBaseline pass-throughs ─────────────────────────
describe("TokenBaselineBox — recordSendCount + currentBaseline", () => {
  test("recordSendCount sets the box send count; capture then pairs it", () => {
    const box = mkBox(undefined)
    const view = TokenBaselineBox.wrap(box)
    view.capture({ inputTokens: 130_000, model: ANTHROPIC }, 120_000)
    expect(box.current).toBeUndefined() // no sendCount yet
    view.recordSendCount(5)
    view.capture({ inputTokens: 130_000, model: ANTHROPIC }, 120_000)
    expect(box.current).toEqual({ measuredInputTokens: 130_000, measuredAtMessageCount: 5 })
    expect(view.currentBaseline()).toEqual({
      measuredInputTokens: 130_000,
      measuredAtMessageCount: 5,
    })
  })
})
