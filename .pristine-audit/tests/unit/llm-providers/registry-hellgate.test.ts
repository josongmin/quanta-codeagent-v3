/**
 * ★ CONTRACT — ADR-0139 §registry:
 *   - Selection precedence (explicit → bedrock env → vertex env → foundry env →
 *     default) is DETERMINISTIC and BYTE-STABLE.
 *   - Unknown explicit id returns a factory that throws lazily on first call
 *     (not at resolve time) so status panels can surface "you asked for X".
 *   - Env access is via the supplied `env` arg only — no `process.env` leak.
 *   - Trim whitespace on explicit id (CLI flag parses often leave leading
 *     spaces).
 */
import { describe, expect, test } from "bun:test"
import { ProviderError } from "@/llm/providers/provider-port"
import { PROVIDER_ENV_KEYS, resolveProvider } from "@/llm/providers/registry"

describe("resolveProvider — precedence hellgate", () => {
  test("HELL-A1: explicit 'default' wins over all envs", () => {
    const env = {
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example",
    }
    expect(resolveProvider("default", env).id).toBe("default")
  })

  test("HELL-A2: explicit 'bedrock' wins over vertex env", () => {
    const env = { ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example" }
    expect(resolveProvider("bedrock", env).id).toBe("bedrock")
  })

  test("HELL-A3: explicit 'vertex' resolves", () => {
    expect(resolveProvider("vertex").id).toBe("vertex")
  })

  test("HELL-A4: explicit 'foundry' resolves", () => {
    expect(resolveProvider("foundry").id).toBe("foundry")
  })

  test("HELL-A5: explicit id is trimmed", () => {
    expect(resolveProvider("  bedrock  ").id).toBe("bedrock")
  })

  test("HELL-B1: precedence — bedrock beats vertex+foundry", () => {
    const env = {
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example",
    }
    expect(resolveProvider(undefined, env).id).toBe("bedrock")
  })

  test("HELL-B2: precedence — vertex beats foundry when bedrock absent", () => {
    const env = {
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example",
    }
    expect(resolveProvider(undefined, env).id).toBe("vertex")
  })

  test("HELL-B3: precedence — foundry selected when only foundry url set", () => {
    const env = { ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example" }
    expect(resolveProvider(undefined, env).id).toBe("foundry")
  })

  test("HELL-B4: empty bag → default", () => {
    expect(resolveProvider(undefined, {}).id).toBe("default")
  })

  test("HELL-B5: no args at all → default", () => {
    expect(resolveProvider().id).toBe("default")
  })

  test("HELL-B6: empty-string bag values DO NOT count as set", () => {
    const env = {
      ANTHROPIC_BEDROCK_BASE_URL: "",
      ANTHROPIC_VERTEX_BASE_URL: "",
    }
    expect(resolveProvider(undefined, env).id).toBe("default")
  })

  test("HELL-C1: empty-string explicit falls through to bag", () => {
    const env = { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" }
    expect(resolveProvider("", env).id).toBe("bedrock")
  })

  test("HELL-D1: unknown explicit id returns lazy-throw factory (NOT throwing at resolve)", () => {
    const resolved = resolveProvider("totally-bogus")
    expect(resolved.id).toBe("totally-bogus")
    // Calling the factory throws — but resolveProvider itself did not.
    expect(() =>
      resolved.factory({
        providerId: "default",
        model: "claude-sonnet-4-6",
        auth: { apiKey: "sk-test" },
      }),
    ).toThrow(ProviderError)
  })

  test("HELL-D2: unknown id factory throws provider-unsupported", () => {
    const resolved = resolveProvider("not-a-provider")
    try {
      resolved.factory({
        providerId: "default",
        model: "m",
        auth: { apiKey: "k" },
      })
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-unsupported")
    }
  })

  test("HELL-E1: PROVIDER_ENV_KEYS exports the canonical names", () => {
    expect(PROVIDER_ENV_KEYS.bedrock).toBe("ANTHROPIC_BEDROCK_BASE_URL")
    expect(PROVIDER_ENV_KEYS.vertex).toBe("ANTHROPIC_VERTEX_BASE_URL")
    expect(PROVIDER_ENV_KEYS.foundry).toBe("ANTHROPIC_FOUNDRY_BASE_URL")
  })

  test("HELL-E2: factory is callable for each known id", () => {
    expect(typeof resolveProvider("default").factory).toBe("function")
    expect(typeof resolveProvider("bedrock").factory).toBe("function")
    expect(typeof resolveProvider("vertex").factory).toBe("function")
    expect(typeof resolveProvider("foundry").factory).toBe("function")
  })
})
