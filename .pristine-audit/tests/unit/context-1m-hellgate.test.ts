/**
 * Hellgate — 1M-context resolution (gap-other-agent GAP 3).
 *
 * Claude activates the 1M-token beta via a `[1m]` model suffix → the
 * `context-1m-2025-08-07` beta header + the `-1m` window variant. quanta had the
 * `-1m` window entries (provider-metadata) but NO resolver to (a) strip the
 * suffix, (b) decide eligibility, (c) emit the beta header + window key.
 *
 * `resolveContext1M(model, env)` is the essential pure function. Eligibility is
 * DERIVED from the window table (a model is 1M-capable iff its `-1m` variant
 * exists), so there is no parallel hardcoded list to drift.
 *
 * Invariants:
 *   1. Byte-identical OFF: plain model, no knob ⇒ active:false, windowKey=model,
 *      no betaHeader.
 *   2. `[1m]` suffix on an ELIGIBLE model ⇒ active, suffix stripped, beta header,
 *      `-1m` windowKey.
 *   3. `QUANTA_CONTEXT_1M` knob activates an eligible model without the suffix.
 *   4. INELIGIBLE model (opus / gpt) ⇒ never active even with suffix/knob; suffix
 *      still stripped from the returned model id.
 */
import { describe, expect, test } from "bun:test"
import { CONTEXT_1M_BETA, resolveContext1M } from "@/llm/context-1m"

const off: Record<string, string | undefined> = {}
const on = { QUANTA_CONTEXT_1M: "1" }

describe("resolveContext1M — byte-identical OFF", () => {
  test("plain eligible model, no knob ⇒ inactive, window=model", () => {
    expect(resolveContext1M("claude-sonnet-4-5", off)).toEqual({
      model: "claude-sonnet-4-5",
      active: false,
      windowKey: "claude-sonnet-4-5",
    })
  })
})

describe("resolveContext1M — suffix activation", () => {
  test("[1m] suffix on eligible ⇒ active + beta + -1m window", () => {
    expect(resolveContext1M("claude-sonnet-4-5[1m]", off)).toEqual({
      model: "claude-sonnet-4-5",
      active: true,
      betaHeader: CONTEXT_1M_BETA,
      windowKey: "claude-sonnet-4-5-1m",
    })
    expect(resolveContext1M("claude-sonnet-4-6[1m]", off).active).toBe(true)
  })
})

describe("resolveContext1M — knob activation", () => {
  test("QUANTA_CONTEXT_1M activates eligible model without suffix", () => {
    const r = resolveContext1M("claude-sonnet-4-5", on)
    expect(r.active).toBe(true)
    expect(r.betaHeader).toBe(CONTEXT_1M_BETA)
    expect(r.windowKey).toBe("claude-sonnet-4-5-1m")
  })
})

describe("resolveContext1M — ineligible never activates", () => {
  test("opus / gpt: suffix stripped, but inactive (no -1m variant)", () => {
    const opus = resolveContext1M("claude-opus-4-8[1m]", on)
    expect(opus).toEqual({ model: "claude-opus-4-8", active: false, windowKey: "claude-opus-4-8" })
    expect(resolveContext1M("gpt-5", on).active).toBe(false)
    expect(resolveContext1M("gpt-5[1m]", off).active).toBe(false)
  })
})
