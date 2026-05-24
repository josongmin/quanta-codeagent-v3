/**
 * ★ CONTRACT — ADR-0139 §vertex-adapter:
 *   - providerId === "vertex".
 *   - Construction requires BOTH `gcpProjectId` AND `gcpLocation`; either
 *     missing → ProviderError("provider-misconfigured") with "auth-failed"
 *     in the message (closed ProviderErrorCode union; auth failure is modeled
 *     under `provider-misconfigured`).
 *   - Wrong providerId → ProviderError("provider-misconfigured").
 *   - stream() lazily imports @anthropic-ai/vertex-sdk; absent ⇒
 *     ProviderError("provider-missing-dependency").
 */
import { describe, expect, test } from "bun:test"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { VertexProviderAdapter } from "@/llm/providers/vertex-adapter"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "vertex",
  model: "claude-sonnet-4@20250514",
  auth: { gcpProjectId: "my-proj", gcpLocation: "us-east5" },
  ...over,
})

describe("VertexProviderAdapter — hellgate", () => {
  test("HELL-A1: providerId surface fixed to 'vertex'", () => {
    const a = new VertexProviderAdapter(base())
    expect(a.providerId).toBe("vertex")
  })

  test("HELL-A2: telemetry fields populated", () => {
    const a = new VertexProviderAdapter(base())
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("GCP Vertex")
  })

  test("HELL-A3: model echoed verbatim", () => {
    const a = new VertexProviderAdapter(base({ model: "claude-opus-4@x" }))
    expect(a.model).toBe("claude-opus-4@x")
  })

  test("HELL-A4: constructs with explicit access token", () => {
    expect(
      () =>
        new VertexProviderAdapter(
          base({
            auth: { gcpProjectId: "p", gcpLocation: "l", gcpAccessToken: "ya29…" },
          }),
        ),
    ).not.toThrow()
  })

  test("HELL-A5: constructs without access token (ADC fallback)", () => {
    expect(
      () =>
        new VertexProviderAdapter(base({ auth: { gcpProjectId: "p", gcpLocation: "l" } })),
    ).not.toThrow()
  })

  test("HELL-B1: missing gcpProjectId → ProviderError(misconfigured, 'auth-failed')", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpLocation: "us-east5" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-misconfigured")
      expect(err.message).toContain("auth-failed")
      expect(err.message).toContain("gcpProjectId")
    }
  })

  test("HELL-B2: missing gcpLocation → ProviderError(misconfigured, 'auth-failed')", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "my-proj" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-misconfigured")
      expect(err.message).toContain("auth-failed")
      expect(err.message).toContain("gcpLocation")
    }
  })

  test("HELL-B3: empty-string gcpProjectId is rejected", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "", gcpLocation: "l" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B4: empty-string gcpLocation is rejected", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "p", gcpLocation: "" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B5: wrong providerId → ProviderError(misconfigured)", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      new VertexProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C1: stream() returns an AsyncIterable", () => {
    const a = new VertexProviderAdapter(base())
    const iter = a.stream({ messages: [], tools: [] })
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  test("HELL-C2: first iteration throws provider-missing-dependency (SDK absent in Phase 1)", async () => {
    const a = new VertexProviderAdapter(base())
    try {
      for await (const _ev of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-missing-dependency")
      expect(err.providerId).toBe("vertex")
    }
  })
})
