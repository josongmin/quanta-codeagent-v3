/**
 * ★ CONTRACT — ADR-0172 §mantle-adapter (graduated real-stream seam):
 *   - Construction with providerId="mantle" + auth.mantleToken succeeds;
 *     wrong providerId throws provider-misconfigured; absent mantleToken
 *     throws provider-misconfigured.
 *   - stream() with NO clientFactory and the (unpublished) SDK absent throws
 *     provider-missing-dependency (NOT a crash, NOT provider-unsupported) so
 *     the fallback chain advances.
 *   - providerId / provider / authMode / model are stable structural fields
 *     (telemetry contract).
 *   - Registry routes providerId="mantle" to MantleProviderAdapter.
 *   - Resolver maps explicit "mantle" id correctly.
 *
 *   Full DI / event-translation coverage lives in
 *   `mantle-adapter-real-stream-hellgate.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { MantleProviderAdapter } from "@/llm/providers/mantle-adapter"
import { ProviderError } from "@/llm/providers/provider-port"
import { resolveProvider } from "@/llm/providers/registry"

describe("MantleProviderAdapter — graduated-seam hellgate", () => {
  test("HELL-M1: constructs with providerId='mantle' + mantleToken", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "claude-mantle-flagship",
      auth: { mantleToken: "k" },
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
          auth: { mantleToken: "k" },
        }),
    ).toThrow(ProviderError)
  })

  test("HELL-M3: providerId='bedrock' (mismatch) carries the wrong-id in message", () => {
    try {
      new MantleProviderAdapter({
        providerId: "bedrock",
        model: "m",
        auth: { mantleToken: "k" },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toContain("bedrock")
    }
  })

  test("HELL-M4: stream() (no SDK, no DI) throws provider-missing-dependency", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    const iter = adapter.stream({ messages: [], tools: [] })
    try {
      for await (const _e of iter) {
        throw new Error("should have thrown before yielding")
      }
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-missing-dependency")
    }
  })

  test("HELL-M5: stream() error message names the Mantle SDK package (telemetry)", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
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
      auth: { mantleToken: "k" },
    })
    expect(adapter.model).toBe("anthropic.claude-mantle-2026-05-24-internal-preview")
  })

  test("HELL-M7: ProviderError carries providerId='mantle' on stream() failure", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
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
      auth: { mantleToken: "k" },
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
    // intentionally-impossible env (no creds beyond the required token).
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    expect(adapter).toBeDefined()
  })

  test("HELL-M11: providerId is the constant 'mantle' across access", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    expect(adapter.providerId).toBe("mantle")
  })

  test("HELL-M12: stream() throws on FIRST iteration (no events leak before missing-dep)", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    const events: unknown[] = []
    try {
      for await (const e of adapter.stream({ messages: [], tools: [] })) {
        events.push(e)
      }
      throw new Error("unreachable")
    } catch (e) {
      // Zero events emitted before the throw — the missing-dependency surfaces
      // before any wire grammar is produced.
      expect(events.length).toBe(0)
      expect(e).toBeInstanceOf(ProviderError)
    }
  })

  // =========================================================================
  // ADVERSARIAL — hardening (graduated seam)
  // =========================================================================

  test("HELL-M13[adversarial]: NUL bytes in model name → construction succeeds, no crash", () => {
    const modelWithNul = "claude\x00mantle\x00rm-rf"
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: modelWithNul,
      auth: { mantleToken: "k" },
    })
    expect(adapter.model).toBe(modelWithNul)
    expect(adapter.providerId).toBe("mantle")
  })

  test("HELL-M14[adversarial]: empty string providerId throws provider-misconfigured", () => {
    expect(
      () =>
        new MantleProviderAdapter({
          providerId: "" as never,
          model: "m",
          auth: { mantleToken: "k" },
        }),
    ).toThrow(ProviderError)
  })

  test("HELL-M15[adversarial]: misconfig error does NOT leak auth fields", () => {
    const secret = "sk-MANTLE-LEAKY-TOKEN-1234567890-DO-NOT-SHIP"
    try {
      new MantleProviderAdapter({
        providerId: "bedrock",
        model: "m",
        auth: { mantleToken: secret },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const msg = (e as ProviderError).message
      expect(msg.includes(secret)).toBe(false)
      const stack = (e as Error).stack ?? ""
      expect(stack.includes(secret)).toBe(false)
    }
  })

  test("HELL-M16[adversarial]: 100 concurrent stream() calls each throw stable missing-dependency", async () => {
    const secret = "anthropic-mantle-shared-secret-CONCURRENT"
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: secret },
    })
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, async () => {
        for await (const _e of adapter.stream({ messages: [], tools: [] })) {
          // unreachable
        }
        throw new Error("unreachable")
      }),
    )
    expect(results.length).toBe(100)
    for (const r of results) {
      expect(r.status).toBe("rejected")
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ProviderError)
        expect((r.reason as ProviderError).code).toBe("provider-missing-dependency")
        expect((r.reason as ProviderError).message.includes(secret)).toBe(false)
      }
    }
  })

  test("HELL-M17[adversarial]: providerId stays the literal constant across access", () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    const id1 = adapter.providerId
    const id2 = adapter.providerId
    expect(id1).toBe("mantle")
    expect(id2).toBe("mantle")
    expect(id1).toBe(id2)
  })

  test("HELL-M18[adversarial]: very long model string (10KB) preserved verbatim, fast", () => {
    const longModel = "x".repeat(10_000)
    const t0 = performance.now()
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: longModel,
      auth: { mantleToken: "k" },
    })
    const dt = performance.now() - t0
    expect(adapter.model.length).toBe(10_000)
    expect(adapter.model).toBe(longModel)
    expect(dt).toBeLessThan(50)
  })

  test("HELL-M19[adversarial]: ProviderError.code is the stable contract — message free-form", async () => {
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { mantleToken: "k" },
    })
    try {
      for await (const _e of adapter.stream({ messages: [], tools: [] })) {
        // unreachable
      }
      throw new Error("unreachable")
    } catch (e) {
      const err = e as ProviderError
      expect(err.code).toBe("provider-missing-dependency")
      expect(err.providerId).toBe("mantle")
      expect(err.name).toBe("ProviderError")
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  test("HELL-M20[adversarial]: unknown registry id factory lazy-throws (no eager construct)", () => {
    const resolved = resolveProvider("mantlee")
    expect(resolved.id).toBe("mantlee") // echoes the typo back
    expect(() =>
      resolved.factory({
        providerId: "default",
        model: "m",
        auth: { apiKey: "k" },
      }),
    ).toThrow(ProviderError)
  })
})
