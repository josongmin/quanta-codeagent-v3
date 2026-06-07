/**
 * Hellgate — Anthropic service_tier plumbing (gap-other-agent GAP 5).
 *
 * quanta resolved `service_tier` for the OpenAI Responses surface only; the
 * Anthropic Messages codec dropped the knob (grep 0). This wires it through with
 * the ANTHROPIC vocabulary (`auto` | `standard_only`) — NOT the OpenAI one — and
 * keeps the OFF path byte-identical.
 *
 * Invariants:
 *   1. No serviceTier ⇒ request has NO `service_tier` key (byte-identical).
 *   2. A valid tier ⇒ `service_tier` present with the Anthropic value.
 *   3. normalizeAnthropicServiceTier maps intents to Anthropic's closed set and
 *      DROPS anything not mappable (never sends an invalid tier).
 */
import { describe, expect, test } from "bun:test"
import {
  buildAnthropicMessagesRequest,
  normalizeAnthropicServiceTier,
} from "@/llm/anthropic-messages-codec"
import type { StreamInput } from "@/llm"

const input = (): StreamInput =>
  ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  }) as unknown as StreamInput

const reqOf = (serviceTier?: string) =>
  buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input(), "5m", serviceTier) as unknown as Record<
    string,
    unknown
  >

describe("anthropic service_tier — byte-identical OFF path", () => {
  test("no serviceTier ⇒ no service_tier key", () => {
    expect("service_tier" in reqOf()).toBe(false)
    expect("service_tier" in reqOf(undefined)).toBe(false)
  })
})

describe("anthropic service_tier — present when set", () => {
  test("standard_only / auto pass through verbatim", () => {
    expect(reqOf("standard_only").service_tier).toBe("standard_only")
    expect(reqOf("auto").service_tier).toBe("auto")
  })
})

describe("normalizeAnthropicServiceTier — closed Anthropic vocab", () => {
  test("priority/fast/auto intents ⇒ auto", () => {
    for (const v of ["auto", "priority", "fast", "AUTO", " priority "]) {
      expect(normalizeAnthropicServiceTier(v)).toBe("auto")
    }
  })
  test("standard intents ⇒ standard_only", () => {
    for (const v of ["standard", "standard_only", "STANDARD_ONLY"]) {
      expect(normalizeAnthropicServiceTier(v)).toBe("standard_only")
    }
  })
  test("non-Anthropic / garbage ⇒ undefined (never sent)", () => {
    for (const v of ["flex", "batch", "scale", "default", "", "  ", "nonsense", undefined]) {
      expect(normalizeAnthropicServiceTier(v)).toBeUndefined()
    }
  })
})
