/**
 * jun-26 bench reasoning-summary default-ON.
 *
 * gpt-5.5 is a reasoning model: without `reasoning.summary:"auto"` it reasons
 * SILENTLY (zero bytes on the wire) and the LLM stream idle-timeout fires
 * mid-reasoning → the SAME request is retried → silent reasoning again →
 * infinite stall. Proven via raw-SSE capture. The fix: BENCH defaults
 * `reasoningSummary` ON (a CODE default, so it rides the rsynced bench source to
 * the full-remote box with NO env forwarding) while staying overridable — an
 * explicit `QUANTA_REASONING_SUMMARY=0`/off (operator turning it OFF) still wins.
 *
 * `resolveBenchReasoningSummary` is the seam: bench passes its result as
 * `opts.reasoningSummary` into `tryCreateLLM`, so the factory's
 * `resolveReasoningSummary` (opts ?? gateOn) short-circuits to it.
 */
import { describe, expect, it } from "bun:test"
import { resolveBenchReasoningSummary } from "@/apps/bench/reasoning-summary"
import { resolveReasoningSummary } from "@/llm/factory"

describe("resolveBenchReasoningSummary — bench default-ON, env-overridable", () => {
  it("no env set ⇒ true (default-ON for bench so reasoning models stream)", () => {
    expect(resolveBenchReasoningSummary({})).toBe(true)
  })

  it("explicit truthy (1/on/true/yes) ⇒ true", () => {
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "1" })).toBe(true)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "on" })).toBe(true)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "true" })).toBe(true)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "yes" })).toBe(true)
  })

  it("explicit OFF (0/off/false/no) ⇒ false — operator override beats the default", () => {
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "0" })).toBe(false)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "off" })).toBe(false)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "false" })).toBe(false)
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "no" })).toBe(false)
  })

  it("unrecognized value ⇒ default-ON (lenient, matches readBool)", () => {
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "maybe" })).toBe(true)
  })

  it("empty string is NOT an opt-out ⇒ stays default-ON", () => {
    expect(resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "" })).toBe(true)
  })
})

describe("factory seam — bench default flows through resolveReasoningSummary", () => {
  it("bench opts.reasoningSummary=true short-circuits the factory to true (no env)", () => {
    const bench = resolveBenchReasoningSummary({})
    expect(resolveReasoningSummary({ model: "gpt-5.5", reasoningSummary: bench }, {})).toBe(true)
  })

  it("bench opts.reasoningSummary=false (operator =0) flows to false in the factory", () => {
    const bench = resolveBenchReasoningSummary({ QUANTA_REASONING_SUMMARY: "0" })
    expect(resolveReasoningSummary({ model: "gpt-5.5", reasoningSummary: bench }, {})).toBe(false)
  })

  it("NON-bench path is unaffected: no opts + no env ⇒ stays OFF (byte-identical)", () => {
    expect(resolveReasoningSummary({ model: "gpt-5.5" }, {})).toBe(false)
  })
})
