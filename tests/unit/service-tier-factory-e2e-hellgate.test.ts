/**
 * Hellgate e2e — service_tier factory→Anthropic-adapter threading (GAP 5, R4 audit).
 *
 * The codec unit test proves `service_tier` lands in the request body; the
 * resolver test proves env→value mapping. This closes the symmetric gap the 1M
 * e2e already had: that `createLLM("anthropic", …)` actually THREADS the resolved
 * tier onto the adapter (the public `serviceTier`, mirroring the betaHeaders e2e).
 * The codec then normalizes the raw intent → auto|standard_only at request time.
 */
import { describe, expect, test } from "bun:test"
import { createLLM } from "@/llm"
import type { AnthropicAdapter } from "@/llm/adapters/anthropic"

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" }
const tierOf = (env: Record<string, string | undefined>): string | undefined =>
  (
    createLLM(
      "anthropic",
      { model: "claude-sonnet-4-5" },
      { ...KEY, ...env },
    ) as unknown as AnthropicAdapter
  ).serviceTier

describe("service_tier factory e2e — Anthropic provider", () => {
  test("QUANTA_SERVICE_TIER threads onto the adapter", () => {
    expect(tierOf({ QUANTA_SERVICE_TIER: "standard" })).toBe("standard")
  })
  test("QUANTA_FAST resolves to a priority intent (codec maps → auto)", () => {
    expect(tierOf({ QUANTA_FAST: "1" })).toBe("priority")
  })
  test("byte-identical OFF: no env ⇒ adapter serviceTier undefined (no key sent)", () => {
    expect(tierOf({})).toBeUndefined()
  })
})
