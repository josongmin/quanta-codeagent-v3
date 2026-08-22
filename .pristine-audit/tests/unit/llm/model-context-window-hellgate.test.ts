/**
 * D4 (jun-7 naive-impl hardening) hellgate — model→context-window SSOT.
 *
 * Before D4 the compaction threshold was a single model-blind `120_000`
 * constant and the usage snapshot hardcoded `max:0`. This pins the new
 * `resolveModelWindow` SSOT:
 *   1. EXACT id lookup returns the table value;
 *   2. provider-FAMILY fallback handles dated/suffixed slugs;
 *   3. an UNKNOWN model id returns `undefined` (caller → legacy 120k path).
 *
 * red-on-injection: reverting `resolveModelWindow` to always-`undefined` (the
 * pre-D4 model-blind behavior) makes the exact + family assertions RED while
 * the unknown-model assertion (the byte-identical fallback) stays GREEN.
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL } from "@/llm/factory"
import {
  MODEL_CONTEXT_WINDOWS,
  type ModelWindow,
  resolveModelWindow,
} from "@/llm/provider-metadata"

describe("D4 resolveModelWindow — model→context-window SSOT", () => {
  test("exact id lookup: Anthropic 200k family", () => {
    const w = resolveModelWindow("claude-sonnet-4-6")
    expect(w).toEqual({ contextWindow: 200_000, maxOutput: 64_000 })
  })

  test("exact id lookup: Anthropic 1M beta context", () => {
    const w = resolveModelWindow("claude-sonnet-4-6-1m")
    expect(w?.contextWindow).toBe(1_000_000)
  })

  test("exact id lookup: OpenAI gpt-5 = 400k window", () => {
    const w = resolveModelWindow("gpt-5")
    expect(w).toEqual({ contextWindow: 400_000, maxOutput: 128_000 })
  })

  test("exact id lookup: gpt-4o = 128k window", () => {
    expect(resolveModelWindow("gpt-4o")?.contextWindow).toBe(128_000)
  })

  test("family fallback: dated/suffixed claude-opus slug resolves to 200k", () => {
    // Not an exact key — must hit the `claude-opus` family fallback.
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4-8-20260101"]).toBeUndefined()
    const w = resolveModelWindow("claude-opus-4-8-20260101")
    expect(w).toEqual({ contextWindow: 200_000, maxOutput: 32_000 })
  })

  test("family fallback: unknown gpt-5 point release resolves to 400k", () => {
    expect(MODEL_CONTEXT_WINDOWS["gpt-5-2026-99-99"]).toBeUndefined()
    expect(resolveModelWindow("gpt-5-2026-99-99")?.contextWindow).toBe(400_000)
  })

  test("family fallback: DATED claude-3-7-sonnet keeps its 64k output (not the claude-3 8192)", () => {
    // `claude-3-7-sonnet-20250219` / `-latest` are real Anthropic slugs that miss
    // the `claude-sonnet` needle (the `3-7` infix) and must NOT fall through to
    // the broader `claude-3` family (8192) — 3.7 Sonnet has a 64k output budget,
    // so the derived threshold differs by ~56k. Red-on-injection: remove the
    // `claude-3-7-sonnet` fallback entry ⇒ maxOutput resolves to 8192.
    expect(MODEL_CONTEXT_WINDOWS["claude-3-7-sonnet-20250219"]).toBeUndefined()
    for (const id of ["claude-3-7-sonnet-20250219", "claude-3-7-sonnet-latest"]) {
      expect(resolveModelWindow(id)).toEqual({ contextWindow: 200_000, maxOutput: 64_000 })
    }
    // The dated 3.5 Sonnet legitimately keeps the claude-3 default (8192) — its
    // real output budget IS 8192, so the broader fallback is correct for it.
    expect(resolveModelWindow("claude-3-5-sonnet-20241022")?.maxOutput).toBe(8_192)
  })

  test("UNKNOWN model id → undefined (legacy 120k fallback path)", () => {
    expect(resolveModelWindow("mystery-llm-9000")).toBeUndefined()
    expect(resolveModelWindow("")).toBeUndefined()
    expect(resolveModelWindow("unknown")).toBeUndefined()
  })

  test("every table value is a positive window with output reserve < window", () => {
    for (const [id, w] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      const win: ModelWindow = w
      expect(win.contextWindow, id).toBeGreaterThan(0)
      expect(win.maxOutput, id).toBeGreaterThan(0)
      // The derived compaction threshold subtracts maxOutput + margin; the
      // window MUST exceed the reserve or the threshold would go negative.
      expect(win.maxOutput, id).toBeLessThan(win.contextWindow)
      // The derived threshold (window − maxOutput − 13000 safety margin) must
      // be positive AND meaningfully above the legacy 120k floor would be too
      // aggressive — at minimum the threshold must be positive so compaction
      // does not fire every turn on a known model.
      expect(win.contextWindow - win.maxOutput - 13_000, id).toBeGreaterThan(0)
    }
  })

  // RFC §6.4 — SSOT drift guard. Every model the repo SHIPS as a provider
  // default MUST resolve to a window (exact or family). If a new `DEFAULT_MODEL`
  // lands whose family is not covered, this fails so the table is kept in sync
  // (a miss would silently fall back to the 120k legacy threshold for the
  // primary model — the exact model-blindness D4 closes).
  test("drift guard: every DEFAULT_MODEL resolves to a window", () => {
    for (const [provider, model] of Object.entries(DEFAULT_MODEL)) {
      const w = resolveModelWindow(model)
      expect(w, `${provider} default model "${model}" must resolve`).toBeDefined()
    }
  })
})
