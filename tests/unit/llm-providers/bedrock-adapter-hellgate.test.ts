/**
 * ★ CONTRACT — ADR-0139 §bedrock-adapter:
 *   - providerId === "bedrock".
 *   - Construction succeeds with EMPTY auth (SDK default cred chain).
 *   - Wrong providerId → ProviderError("provider-misconfigured").
 *   - stream() lazily imports @anthropic-ai/bedrock-sdk; absent ⇒
 *     ProviderError("provider-missing-dependency"). The optional dep is NOT
 *     installed in this repo (Phase 1) so the missing-dep path is the live
 *     path here.
 *   - exactOptional credentials: only supplied keys are forwarded (no
 *     `undefined` shadowed onto the SDK options).
 */
import { describe, expect, test } from "bun:test"
import { BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  auth: {},
  ...over,
})

describe("BedrockProviderAdapter — hellgate", () => {
  test("HELL-A1: providerId surface fixed to 'bedrock'", () => {
    const a = new BedrockProviderAdapter(base())
    expect(a.providerId).toBe("bedrock")
  })

  test("HELL-A2: telemetry fields populated", () => {
    const a = new BedrockProviderAdapter(base())
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("AWS Bedrock")
  })

  test("HELL-A3: model echoed verbatim", () => {
    const a = new BedrockProviderAdapter(base({ model: "custom-model" }))
    expect(a.model).toBe("custom-model")
  })

  test("HELL-A4: constructs with empty auth (default cred chain)", () => {
    expect(() => new BedrockProviderAdapter(base({ auth: {} }))).not.toThrow()
  })

  test("HELL-A5: constructs with full static AWS creds", () => {
    expect(
      () =>
        new BedrockProviderAdapter(
          base({
            auth: {
              awsAccessKeyId: "AKIA…",
              awsSecretAccessKey: "secret",
              awsSessionToken: "session",
              awsRegion: "us-west-2",
            },
          }),
        ),
    ).not.toThrow()
  })

  test("HELL-B1: wrong providerId → ProviderError(misconfigured)", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      new BedrockProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C1: stream() returns an AsyncIterable", () => {
    const a = new BedrockProviderAdapter(base())
    const iter = a.stream({ messages: [], tools: [] })
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  test("HELL-C2: first iteration throws provider-missing-dependency (SDK absent in Phase 1)", async () => {
    const a = new BedrockProviderAdapter(base())
    try {
      for await (const _ev of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-missing-dependency")
      expect(err.providerId).toBe("bedrock")
    }
  })
})
