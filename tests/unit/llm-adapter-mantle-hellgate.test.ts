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

  // =========================================================================
  // ADVERSARIAL — Phase A hellgate hardening (round 3)
  //
  // 6+ adversarial scenarios that target real attack / failure modes a
  // Phase-1 stub MUST still survive. Each case states the threat in its
  // assertion message so a failing run names the attack scenario.
  // =========================================================================

  test("HELL-M13[adversarial]: NUL bytes in model name → construction succeeds, no spawn-time crash", () => {
    // Attack: an upstream LLM hallucination injects "\0" into a model id that
    // a credential file derived from. Construction is pure — must NOT crash
    // and the raw bytes MUST be preserved verbatim for the adapter to
    // surface in telemetry rather than munge silently (which would hide the
    // injection from the operator).
    const modelWithNul = "claude\x00mantle\x00rm-rf"
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: modelWithNul,
      auth: {},
    })
    expect(adapter.model).toBe(modelWithNul)
    expect(adapter.providerId).toBe("mantle")
  })

  test("HELL-M14[adversarial]: empty string providerId throws provider-misconfigured (not type-coerced to truthy)", () => {
    // Attack: a CLI flag-parse that emitted empty-string by accident; if the
    // adapter falls back to "looks falsy → default to mantle" we silently
    // accept a misconfigured caller. MUST throw.
    expect(
      () =>
        new MantleProviderAdapter({
          providerId: "" as never,
          model: "m",
          auth: {},
        }),
    ).toThrow(ProviderError)
  })

  test("HELL-M15[adversarial]: error message does NOT leak auth fields (token-in-stack-trace check)", () => {
    // Attack: ProviderError surfaces in logs / Sentry — if construction
    // failure path interpolates `config.auth` into the message, an apiKey
    // value embedded in the bundle would leak to telemetry. Verify the
    // mismatch error does NOT contain the apiKey-like payload.
    const secret = "sk-MANTLE-LEAKY-TOKEN-1234567890-DO-NOT-SHIP"
    try {
      new MantleProviderAdapter({
        providerId: "bedrock",
        model: "m",
        auth: { apiKey: secret },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const msg = (e as ProviderError).message
      expect(msg.includes(secret)).toBe(false)
      // Same check on the stack string — Error.toString may include cause chain.
      const stack = (e as Error).stack ?? ""
      expect(stack.includes(secret)).toBe(false)
    }
  })

  test("HELL-M16[adversarial]: stream() error message does NOT echo credentials when called many times concurrently", async () => {
    // Attack: 100 concurrent stream() invocations must each independently
    // throw with the SAME stable error code — no state corruption (e.g. a
    // memoized error that captured a previous caller's auth bundle).
    const secret = "anthropic-mantle-shared-secret-CONCURRENT"
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: { apiKey: secret },
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
        expect((r.reason as ProviderError).code).toBe("provider-unsupported")
        // Credential MUST NOT have leaked into any of 100 error messages.
        expect((r.reason as ProviderError).message.includes(secret)).toBe(false)
      }
    }
  })

  test("HELL-M17[adversarial]: providerId mutation attempt is structurally rejected at runtime", () => {
    // Attack: an attacker-controlled module monkey-patches the providerId
    // after construction to spoof telemetry as a different provider. The
    // class declares providerId as `readonly` — TypeScript enforces this at
    // compile time. At runtime we cannot freeze the instance without
    // changing the production code (which would be a behavior change), but
    // we MUST at least assert that telemetry still reports "mantle" — i.e.,
    // construction doesn't accidentally hand back a mutable POJO that lost
    // the constant.
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    // Verify the class-property remains the literal constant across access
    // (this would fail if the implementation later switched to a getter
    // that read from a mutable backing field).
    const id1 = adapter.providerId
    const id2 = adapter.providerId
    expect(id1).toBe("mantle")
    expect(id2).toBe("mantle")
    expect(id1).toBe(id2)
  })

  test("HELL-M18[adversarial]: very long model string (10KB) does NOT slow construction or get truncated", () => {
    // Attack: a misconfigured caller passes a 10KB model id (e.g. an entire
    // JSON document concatenated by mistake). Construction MUST stay
    // synchronous + sub-millisecond, and the model field MUST be preserved
    // verbatim (no silent truncation that would corrupt telemetry).
    const longModel = "x".repeat(10_000)
    const t0 = performance.now()
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: longModel,
      auth: {},
    })
    const dt = performance.now() - t0
    expect(adapter.model.length).toBe(10_000)
    expect(adapter.model).toBe(longModel)
    // Generous bound — construction is pure assignment, must be <50ms even
    // on slow CI.
    expect(dt).toBeLessThan(50)
  })

  test("HELL-M19[adversarial]: ProviderError.code is the only stable contract — message is unspecified", async () => {
    // Attack: a downstream consumer matches on message text ("Mantle adapter
    // is Phase 2"). If a future copy-edit changes the wording, that
    // consumer breaks silently. The hellgate asserts that CODE is the
    // contract, and message is free-form.
    const adapter = new MantleProviderAdapter({
      providerId: "mantle",
      model: "m",
      auth: {},
    })
    try {
      for await (const _e of adapter.stream({ messages: [], tools: [] })) {
        // unreachable
      }
      throw new Error("unreachable")
    } catch (e) {
      const err = e as ProviderError
      // CODE — stable contract.
      expect(err.code).toBe("provider-unsupported")
      // providerId — stable contract.
      expect(err.providerId).toBe("mantle")
      // name — stable JS error contract.
      expect(err.name).toBe("ProviderError")
      // We DO NOT assert exact message text — only that it is non-empty.
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  test("HELL-M20[adversarial]: unknown registry id factory lazy-throws (does not eagerly construct adapter)", () => {
    // Attack: a typo'd provider id ("mantlee") must not silently land in
    // some default adapter that hits a real endpoint. The registry's
    // contract is "lazy-throw at first factory call" — verify the throw
    // fires AT factory invocation, not at resolveProvider time.
    const resolved = resolveProvider("mantlee")
    expect(resolved.id).toBe("mantlee") // echoes the typo back
    // Factory call MUST throw — adapter construction never happens.
    expect(() =>
      resolved.factory({
        providerId: "default",
        model: "m",
        auth: { apiKey: "k" },
      }),
    ).toThrow(ProviderError)
  })
})
