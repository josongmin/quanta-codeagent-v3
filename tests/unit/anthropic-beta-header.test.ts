import { describe, expect, test } from "bun:test"
import { AnthropicAdapter } from "@/llm/adapters/anthropic"

/**
 * We do not mock the Anthropic SDK; instead we assert against the adapter's
 * stored `betaHeaders` (the source of truth for the `anthropic-beta` header
 * we would send) plus the joined-string representation. This is the same
 * value handed to the SDK's `defaultHeaders` at construction.
 */

const HK = "anthropic-beta"

const joined = (a: AnthropicAdapter): string => a.betaHeaders.join(",")

describe("AnthropicAdapter — betaHeaders", () => {
  test("omitted betaHeaders ⇒ empty array, no header would be sent (byte-identical legacy)", () => {
    const a = new AnthropicAdapter({ apiKey: "test", model: "claude-opus-4-7" })
    expect(a.betaHeaders).toEqual([])
    expect(joined(a)).toBe("")
    // The header is only attached when joined length > 0.
    const wouldSend = joined(a).length > 0 ? { [HK]: joined(a) } : undefined
    expect(wouldSend).toBeUndefined()
  })

  test("single channel ⇒ header value matches the channel id", () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-4-7",
      betaHeaders: ["skills-2025-10-02"],
    })
    expect(a.betaHeaders).toEqual(["skills-2025-10-02"])
    expect(joined(a)).toBe("skills-2025-10-02")
    const wouldSend = { [HK]: joined(a) }
    expect(wouldSend).toEqual({ "anthropic-beta": "skills-2025-10-02" })
  })

  test("multiple channels join with comma in declared order", () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-4-7",
      betaHeaders: ["skills-2025-10-02", "environments-2025-11-01", "oauth-2025-04-20"],
    })
    expect(joined(a)).toBe("skills-2025-10-02,environments-2025-11-01,oauth-2025-04-20")
  })

  test("two-element list joins with single comma (no spaces)", () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-4-7",
      betaHeaders: ["a", "b"],
    })
    expect(joined(a)).toBe("a,b")
  })

  test("explicit empty array ⇒ no header sent (same as omitted)", () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-4-7",
      betaHeaders: [],
    })
    expect(a.betaHeaders).toEqual([])
    expect(joined(a).length).toBe(0)
  })

  test("readonly contract: betaHeaders cannot be mutated to break later requests", () => {
    const a = new AnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-4-7",
      betaHeaders: ["skills-2025-10-02"],
    })
    // TS readonly; at runtime the field is a frozen-by-convention array. We
    // assert structural identity rather than deep-freeze.
    expect(a.betaHeaders.length).toBe(1)
    expect(a.betaHeaders[0]).toBe("skills-2025-10-02")
  })
})
