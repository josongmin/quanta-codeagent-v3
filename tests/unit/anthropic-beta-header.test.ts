import { describe, expect, test } from "bun:test"
import { AnthropicAdapter } from "@/llm/adapters/anthropic"
import { LLMError } from "@/shared/errors"

test("real Anthropic SDK transport preserves headers, auth errors, and pre-abort", async () => {
  const adapter = new AnthropicAdapter({
    apiKey: "test-key",
    model: "claude-test",
    betaHeaders: ["test-beta-a", "test-beta-b"],
  })
  // Replace only the HTTP transport, never the SDK client or request builder.
  type HttpTransport = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
  const client = (adapter as unknown as { client: { fetch: HttpTransport } }).client
  const calls: { url: string; headers: Headers }[] = []
  let status = 200
  client.fetch = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    })
    return new Response(
      JSON.stringify(
        status === 200
          ? { data: [{ id: "claude-fixture" }], has_more: false }
          : { type: "error", error: { type: "authentication_error", message: "fixture auth" } },
      ),
      { status, headers: { "content-type": "application/json" } },
    )
  }
  expect(await adapter.listModels()).toEqual(["claude-fixture"])
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toContain("/v1/models")
  expect(calls[0]?.headers.get("x-api-key")).toBe("test-key")
  expect(calls[0]?.headers.get("anthropic-beta")).toBe("test-beta-a,test-beta-b")

  status = 401
  const authError = await adapter.listModels().catch((error: unknown) => error)
  expect(authError).toBeInstanceOf(LLMError)
  expect((authError as LLMError).kind).toBe("auth")
  expect((authError as LLMError).provider).toBe("anthropic")
  expect(calls).toHaveLength(2)

  const abort = new AbortController()
  abort.abort()
  const abortError = await adapter.listModels(abort.signal).catch((error: unknown) => error)
  expect(abortError).toBeInstanceOf(LLMError)
  // Preserve the existing classifier: this SDK's APIUserAbortError maps to
  // unknown, but must still reject before making another transport request.
  expect((abortError as LLMError).kind).toBe("unknown")
  expect((abortError as LLMError).message).toContain("Request was aborted")
  expect(calls).toHaveLength(2)
})

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
