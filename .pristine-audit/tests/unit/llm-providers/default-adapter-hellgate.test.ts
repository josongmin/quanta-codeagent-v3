/**
 * ★ CONTRACT — ADR-0139 §default-adapter:
 *   - providerId === "default" (telemetry badge).
 *   - Construction requires `providerId === "default"` + non-empty `apiKey`.
 *   - Mismatched providerId → ProviderError("provider-misconfigured").
 *   - Missing apiKey → ProviderError("provider-misconfigured").
 *   - Stream delegates to the legacy AnthropicAdapter (we verify the surface
 *     exists; full streaming is exercised by tests/unit/adapters/anthropic*).
 */
import { describe, expect, test } from "bun:test"
import { DefaultProviderAdapter } from "@/llm/providers/default-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "default",
  model: "claude-sonnet-4-6",
  auth: { apiKey: "sk-test" },
  ...over,
})

describe("DefaultProviderAdapter — hellgate", () => {
  test("HELL-A1: providerId surface fixed to 'default'", () => {
    const a = new DefaultProviderAdapter(base())
    expect(a.providerId).toBe("default")
  })

  test("HELL-A2: telemetry fields populated (provider/authMode)", () => {
    const a = new DefaultProviderAdapter(base())
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Anthropic BYOK")
  })

  test("HELL-A3: model echoed verbatim", () => {
    const a = new DefaultProviderAdapter(base({ model: "claude-opus-4-7" }))
    expect(a.model).toBe("claude-opus-4-7")
  })

  test("HELL-B1: wrong providerId → ProviderError(misconfigured)", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      new DefaultProviderAdapter(base({ providerId: "bedrock" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B2: missing apiKey → ProviderError(misconfigured)", () => {
    try {
      new DefaultProviderAdapter(base({ auth: {} }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B3: empty-string apiKey → ProviderError(misconfigured)", () => {
    try {
      new DefaultProviderAdapter(base({ auth: { apiKey: "" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C1: stream() returns an AsyncIterable", () => {
    const a = new DefaultProviderAdapter(base())
    const iter = a.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    })
    expect(iter).toBeDefined()
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })
})
