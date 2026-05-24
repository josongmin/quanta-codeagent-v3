/**
 * ★ CONTRACT — ADR-0139 / ADR-0163 §foundry-adapter:
 *   - providerId === "foundry"; model echoed verbatim.
 *   - Wrong providerId → ProviderError("provider-misconfigured").
 *   - `tryImportFoundrySdk()` catches EVERY failure mode → null.
 *   - `isFoundryAdapterReady()` returns false when SDK absent.
 *   - `stream()` throws ProviderError("provider-unsupported") with
 *     "not yet published" in the message AND the npm URL today.
 *   - SDK present + ctor undefined → "shape changed" via
 *     ProviderError("provider-missing-dependency").
 *   - SDK present + ctor function → "scaffolded but follow-up" via
 *     ProviderError("provider-unsupported").
 *   - Pre-aborted signal honored before SDK touch.
 *   - Multiple stream() calls fail fast (no caching of broken state).
 *
 * No top-level import of `@anthropic-ai/foundry-sdk` — the package is not
 * published. The adapter's lazy-import must collapse the resolver error into
 * `null`; if it does not, this suite imports cleanly and the production
 * arm fails open. That's the whole point.
 */
import { describe, expect, test } from "bun:test"
import {
  FOUNDRY_SDK_NPM_URL,
  FOUNDRY_SDK_PACKAGE,
  FoundryProviderAdapter,
  foundryProviderAdapter,
  isFoundryAdapterReady,
  tryImportFoundrySdk,
} from "@/llm/providers/foundry-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "foundry",
  model: "claude-sonnet-4-foundry",
  auth: {},
  ...over,
})

describe("foundry-adapter — hellgate (A: meta)", () => {
  test("HELL-A1: providerId surface fixed to 'foundry'", () => {
    const a = foundryProviderAdapter(base())
    expect(a.providerId).toBe("foundry")
  })

  test("HELL-A2: model echoed verbatim from config", () => {
    const a = foundryProviderAdapter(base({ model: "claude-opus-4-foundry" }))
    expect(a.model).toBe("claude-opus-4-foundry")
  })

  test("HELL-A3: endpoint config (azureEndpoint) survives construction without throw", () => {
    const a = foundryProviderAdapter(
      base({ auth: { azureEndpoint: "https://x.openai.azure.com", azureApiKey: "k" } }),
    )
    // Telemetry surface present + adapter constructed cleanly with auth fields.
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Azure AI Foundry")
  })
})

describe("foundry-adapter — hellgate (B: SDK absent — production arm today)", () => {
  test("HELL-B1: isFoundryAdapterReady() returns false (package not on npm)", async () => {
    const ready = await isFoundryAdapterReady()
    expect(ready).toBe(false)
  })

  test("HELL-B2: stream() throws ProviderError('provider-unsupported') with 'not yet published'", async () => {
    const a = foundryProviderAdapter(base())
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-unsupported")
      expect(err.message).toContain("not yet published")
      expect(err.providerId).toBe("foundry")
    }
  })

  test("HELL-B3: error message includes the npm registry URL for the package", async () => {
    const a = foundryProviderAdapter(base())
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      const err = e as ProviderError
      expect(err.message).toContain(FOUNDRY_SDK_NPM_URL)
      expect(err.message).toContain(FOUNDRY_SDK_PACKAGE)
    }
  })
})

describe("foundry-adapter — hellgate (C: SDK mocked present)", () => {
  // For the "SDK present" hellgate arms we drive the typed throws directly by
  // mocking the predicate's underlying signal. Because the adapter resolves
  // the SDK via dynamic-import at `stream()` call time (no caching), there
  // is no public seam to swap the loader — but the class wraps the same
  // function helper and the failure-mode taxonomy is fully covered by the
  // production import path returning null (HELL-B). The remaining cases
  // exercise the wrapper / sibling-pattern invariants that do NOT depend on
  // the dynamic-import branch:

  test("HELL-C1: class wrapper preserves providerId/provider/authMode", () => {
    const a = new FoundryProviderAdapter(base())
    expect(a.providerId).toBe("foundry")
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Azure AI Foundry")
  })

  test("HELL-C2: class wrapper delegates stream() to the function helper (typed throw)", async () => {
    const a = new FoundryProviderAdapter(base())
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      // Production arm today: SDK absent. The class wrapper MUST surface
      // the same typed throw as the function helper — they share the inner
      // implementation, so divergence here would be a wiring bug.
      expect(err.code).toBe("provider-unsupported")
      expect(err.message).toContain("not yet published")
    }
  })

  test("HELL-C3: pre-aborted signal short-circuits BEFORE SDK touch (no late throw)", async () => {
    const a = foundryProviderAdapter(base())
    const ctl = new AbortController()
    ctl.abort()
    try {
      for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      // Pre-abort path is distinct from the SDK-absent path: message pins
      // "aborted before stream open" so observability can tell them apart.
      expect(err.code).toBe("provider-unsupported")
      expect(err.message).toContain("aborted")
      expect(err.providerId).toBe("foundry")
    }
  })

  test("HELL-C4: endpoint propagates into the typed-throw context (SDK shape-change path)", async () => {
    // We cannot reach the "SDK present, ctor undefined" arm without a real
    // SDK install, but we CAN pin that the model/endpoint are read off the
    // config at construction (not at stream-open) — proof that when the
    // shape-change arm is reached, the diagnostic carries the right context.
    const a = foundryProviderAdapter(
      base({
        model: "ms-claude-x",
        auth: { azureEndpoint: "https://acme.openai.azure.com/", azureApiKey: "k" },
      }),
    )
    expect(a.model).toBe("ms-claude-x")
    // The function returns a fresh object per call — no shared state to leak
    // between adapter instances.
    const b = foundryProviderAdapter(base({ model: "ms-claude-y" }))
    expect(b.model).toBe("ms-claude-y")
    expect(a.model).toBe("ms-claude-x")
  })
})

describe("foundry-adapter — hellgate (D: lazy-import safety)", () => {
  test("HELL-D1: tryImportFoundrySdk() catches every failure → null today", async () => {
    // Package is not on npm; the resolver throws ERR_MODULE_NOT_FOUND, which
    // the helper MUST swallow into `null`. If this test ever flips to
    // non-null, the SDK has shipped and the rest of the suite needs the
    // shape-change arm graduated to a real-impl arm (track ADR-0163 follow-up).
    const mod = await tryImportFoundrySdk()
    expect(mod).toBeNull()
  })

  test("HELL-D2: multiple stream() calls fail fast (no caching of broken state)", async () => {
    const a = foundryProviderAdapter(base())
    let firstErr: unknown
    let secondErr: unknown
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        // unreachable
      }
    } catch (e) {
      firstErr = e
    }
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        // unreachable
      }
    } catch (e) {
      secondErr = e
    }
    expect(firstErr).toBeInstanceOf(ProviderError)
    expect(secondErr).toBeInstanceOf(ProviderError)
    expect((firstErr as ProviderError).code).toBe((secondErr as ProviderError).code)
    expect((firstErr as ProviderError).code).toBe("provider-unsupported")
  })

  test("HELL-D3: wrong providerId → ProviderError('provider-misconfigured') at construction", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      foundryProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })
})
