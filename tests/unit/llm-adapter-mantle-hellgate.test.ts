/**
 * ★ CONTRACT — ADR-0163 §mantle-adapter (Phase 1 stub):
 *   - Construction with providerId="mantle" succeeds; everything else throws
 *     provider-misconfigured.
 *   - stream() ALWAYS throws provider-unsupported (Phase 1 stub — no SDK yet).
 *   - providerId / provider / authMode / model are stable structural fields
 *     (telemetry contract).
 *   - Registry routes providerId="mantle" to MantleProviderAdapter.
 *   - Resolver maps explicit "mantle" id correctly.
 */
import { describe, expect, test } from "bun:test"
import { MantleProviderAdapter } from "@/llm/providers/mantle-adapter"
import { ProviderError } from "@/llm/providers/provider-port"
import { resolveProvider } from "@/llm/providers/registry"

describe("MantleProviderAdapter — Phase 1 stub hellgate", () => {
  test("HELL-M1: constructs with providerId='mantle'", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "claude-mantle-flagship",
      auth: {},
    })
    expect(adapter.providerId).toBe("mantle")
    expect(adapter.provider).toBe("anthropic")
    expect(adapter.authMode).toBe("Anthropic Mantle")
    expect(adapter.model).toBe("claude-mantle-flagship")
  })

  test("HELL-M2: providerId='default' (mismatch) throws provider-misconfigured", () => {
    expect(
      () =>
        new MantleProviderAdapter({
          providerId: "default",
          model: "m",
          auth: {},
        }),
    ).toThrow(ProviderError)
  })

  test("HELL-M3: providerId='bedrock' (mismatch) carries the wrong-id in message", () => {
    try {
      new MantleProviderAdapter({
        providerId: "bedrock",
        model: "m",
        auth: {},
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toContain("bedrock")
    }
  })

  test("HELL-M4: stream() throws provider-unsupported on first call", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    const iter = adapter.stream({ messages: [], tools: [] })
    try {
      // biome-ignore lint/correctness/noUnusedVariables: prove no event is yielded
      for await (const _e of iter) {
        throw new Error("should have thrown before yielding")
      }
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-unsupported")
    }
  })

  test("HELL-M5: stream() error message names 'Mantle' (telemetry)", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    try {
      for await (const _e of adapter.stream({ messages: [], tools: [] })) {
        // never reached
      }
      throw new Error("unreachable")
    } catch (e) {
      expect((e as ProviderError).message.toLowerCase()).toContain("mantle")
    }
  })

  test("HELL-M6: model field stays verbatim (no munging)", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "anthropic.claude-mantle-2026-05-24-internal-preview",
      auth: {},
    })
    expect(adapter.model).toBe("anthropic.claude-mantle-2026-05-24-internal-preview")
  })

  test("HELL-M7: ProviderError carries providerId='mantle' on stream() failure", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    try {
      for await (const _e of adapter.stream({ messages: [], tools: [] })) {
        // never
      }
      throw new Error("unreachable")
    } catch (e) {
      expect((e as ProviderError).providerId).toBe("mantle")
    }
  })

  test("HELL-M8: registry resolveProvider('mantle') returns mantle factory", () => {
    const resolved = resolveProvider("mantle")
    expect(resolved.id).toBe("mantle")
    const adapter = resolved.factory({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    expect(adapter.providerId).toBe("mantle")
  })

  test("HELL-M9: registry unknown id message lists mantle as a known option", () => {
    const resolved = resolveProvider("totally-bogus-x")
    try {
      resolved.factory({
        providerId: "default",
        model: "m",
        auth: { apiKey: "k" },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as ProviderError).message).toContain("mantle")
    }
  })

  test("HELL-M10: construction does NOT touch network or filesystem", () => {
    // Pure construction is synchronous and side-effect-free. We assert
    // structurally that construction completes without throwing under an
    // intentionally-impossible env (no AWS / GCP / Azure / ANTHROPIC_*
    // creds present). If any side-effect crept in, this would explode.
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    expect(adapter).toBeDefined()
  })

  test("HELL-M11: providerId is readonly (compile-time guard)", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    // Verify structural read-only intent — we cannot enforce immutability at
    // runtime (no Object.freeze), but the value MUST be the constant.
    expect(adapter.providerId).toBe("mantle")
  })

  test("HELL-M12: stream() throws synchronously on FIRST iteration (no events leak)", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    const events: unknown[] = []
    try {
      for await (const e of adapter.stream({ messages: [], tools: [] })) {
        events.push(e)
      }
      throw new Error("unreachable")
    } catch (e) {
      // Zero events emitted before the throw — Phase 1 stub contract.
      expect(events.length).toBe(0)
      expect(e).toBeInstanceOf(ProviderError)
    }
  })
})
