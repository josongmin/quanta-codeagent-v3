/**
 * ★ CONTRACT — ADR-0139 / ADR-0172 §foundry-adapter (real-stream baseline):
 *
 *   ADR-0163 originally shipped a typed-stub here because the SDK was not yet
 *   published. ADR-0172 graduated the adapter to a real stream now that
 *   `@anthropic-ai/foundry-sdk@0.2.3` is on npm. The legacy "SDK absent" /
 *   "not yet published" arms are GONE — their contract is preserved by
 *   {@link tryImportFoundrySdk}'s graceful-null discipline (a future
 *   uninstall still collapses to `null`, never an unhandled
 *   ERR_MODULE_NOT_FOUND).
 *
 *   This file pins the SHAPE invariants that the real-stream impl shares
 *   with the legacy stub:
 *     - providerId === "foundry" / provider === "anthropic" / authMode label.
 *     - Wrong providerId → ProviderError("provider-misconfigured").
 *     - Resource AND baseURL both set → ProviderError("provider-misconfigured").
 *     - Neither apiKey nor azureADTokenProvider → ProviderError(misconfigured).
 *     - `tryImportFoundrySdk()` returns a module today (SDK published) and
 *       NEVER throws.
 *     - `isFoundryAdapterReady()` returns true today.
 *     - `foundryProviderAdapter(cfg)` returns a fresh instance per call.
 *     - Pre-aborted signal short-circuits BEFORE SDK touch.
 *     - `KNOWN_PUBLISHED_VERSION` is a stable string (re-exported for
 *       foundry-watch drift detection).
 *
 *   The full stream / DI / event-translation coverage lives in
 *   `foundry-real-stream-hellgate.test.ts` (ADR-0172 §hellgate).
 */
import { describe, expect, test } from "bun:test"
import {
  FOUNDRY_SDK_NPM_URL,
  FOUNDRY_SDK_PACKAGE,
  FoundryProviderAdapter,
  foundryProviderAdapter,
  isFoundryAdapterReady,
  KNOWN_PUBLISHED_VERSION,
  tryImportFoundrySdk,
} from "@/llm/providers/foundry-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { LLMError } from "@/shared"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "foundry",
  model: "claude-sonnet-4-foundry",
  // Default to apiKey-only auth so misconfig arms can override explicitly.
  auth: { azureApiKey: "k-test" },
  ...over,
})

describe("foundry-adapter — hellgate (A: meta surface)", () => {
  test("HELL-A1: providerId surface fixed to 'foundry'", () => {
    const a = foundryProviderAdapter(base())
    expect(a.providerId).toBe("foundry")
  })

  test("HELL-A2: model echoed verbatim from config", () => {
    const a = foundryProviderAdapter(base({ model: "claude-opus-4-foundry" }))
    expect(a.model).toBe("claude-opus-4-foundry")
  })

  test("HELL-A3: telemetry fields populated (provider / authMode)", () => {
    const a = foundryProviderAdapter(
      base({
        auth: {
          azureEndpoint: "https://x.openai.azure.com",
          azureApiKey: "k",
        },
      }),
    )
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Azure AI Foundry")
  })

  test("HELL-A4: endpoint synthesises from resource name when no baseURL", () => {
    const a = foundryProviderAdapter(base({ auth: { azureResource: "acme", azureApiKey: "k" } }))
    expect(a.endpoint).toContain("acme.services.ai.azure.com")
  })

  test("HELL-A5: endpoint reflects explicit baseURL override", () => {
    const a = foundryProviderAdapter(
      base({ auth: { azureEndpoint: "https://custom.example/anthropic", azureApiKey: "k" } }),
    )
    expect(a.endpoint).toBe("https://custom.example/anthropic")
  })
})

describe("foundry-adapter — hellgate (B: misconfig)", () => {
  test("HELL-B1: wrong providerId → ProviderError('provider-misconfigured')", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      foundryProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B2: resource AND baseURL both set → ProviderError(misconfigured)", () => {
    try {
      foundryProviderAdapter(
        base({
          auth: {
            azureResource: "acme",
            azureEndpoint: "https://acme.example/",
            azureApiKey: "k",
          },
        }),
      )
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toMatch(/mutually exclusive|not both|EITHER/i)
    }
  })

  test("HELL-B3: no apiKey and no azureADTokenProvider → ProviderError(misconfigured)", () => {
    try {
      foundryProviderAdapter(base({ auth: { azureResource: "acme" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toMatch(/azureApiKey|azureADTokenProvider/)
    }
  })

  test("HELL-B4: azureADTokenProvider alone (no apiKey) constructs cleanly", () => {
    expect(() =>
      foundryProviderAdapter(
        base({
          auth: {
            azureResource: "acme",
            azureADTokenProvider: async () => "fake-bearer",
          },
        }),
      ),
    ).not.toThrow()
  })
})

describe("foundry-adapter — hellgate (C: lazy-import safety)", () => {
  test("HELL-C1: tryImportFoundrySdk() returns module today (SDK published)", async () => {
    const mod = await tryImportFoundrySdk()
    // SDK is installed; loader returns the module. The graceful-null
    // contract is preserved (a future uninstall would flip to null) — see
    // the file header for the rationale.
    expect(mod).not.toBeNull()
  })

  test("HELL-C2: isFoundryAdapterReady() returns true today", async () => {
    const ready = await isFoundryAdapterReady()
    expect(ready).toBe(true)
  })

  test("HELL-C3: KNOWN_PUBLISHED_VERSION is a non-empty semver string", () => {
    expect(typeof KNOWN_PUBLISHED_VERSION).toBe("string")
    expect(KNOWN_PUBLISHED_VERSION.length).toBeGreaterThan(0)
    // pin the major-minor shape so a stray edit cannot silently break the
    // foundry-watch drift signal
    expect(KNOWN_PUBLISHED_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("HELL-C4: package coordinates exported verbatim for watcher SSOT", () => {
    expect(FOUNDRY_SDK_PACKAGE).toBe("@anthropic-ai/foundry-sdk")
    expect(FOUNDRY_SDK_NPM_URL).toBe(`https://registry.npmjs.org/${FOUNDRY_SDK_PACKAGE}`)
  })
})

describe("foundry-adapter — hellgate (D: function / class parity)", () => {
  test("HELL-D1: function-style returns FoundryProviderAdapter instance", () => {
    const a = foundryProviderAdapter(base())
    expect(a).toBeInstanceOf(FoundryProviderAdapter)
  })

  test("HELL-D2: class wrapper preserves providerId/provider/authMode", () => {
    const a = new FoundryProviderAdapter(base())
    expect(a.providerId).toBe("foundry")
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Azure AI Foundry")
  })

  test("HELL-D3: fresh instance per call (no shared state across constructions)", () => {
    const a = foundryProviderAdapter(base({ model: "ms-claude-x" }))
    const b = foundryProviderAdapter(base({ model: "ms-claude-y" }))
    expect(a.model).toBe("ms-claude-x")
    expect(b.model).toBe("ms-claude-y")
    expect(a).not.toBe(b)
  })

  test("HELL-D4: pre-aborted signal short-circuits BEFORE SDK touch", async () => {
    const a = foundryProviderAdapter(base())
    const ctl = new AbortController()
    ctl.abort()
    try {
      for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      // L6 M10a: a caller abort is a typed `aborted` outcome, not a
      // provider-capability failure (was wrongly ProviderError/provider-unsupported).
      expect(e).toBeInstanceOf(LLMError)
      const err = e as LLMError
      expect(err.kind).toBe("aborted")
      expect(err.message).toContain("aborted")
    }
  })
})
