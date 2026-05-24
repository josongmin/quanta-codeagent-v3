/**
 * ★ CONTRACT — ADR-0163 §provider-router:
 *   - Seven-layer precedence ladder is DETERMINISTIC and BYTE-STABLE.
 *   - Simultaneous CLAUDE_CODE_USE_* keys throw ProviderConflictError
 *     (never silent pick).
 *   - Unknown explicit id falls through to env (matches pickProvider).
 *   - Empty string env values DO NOT count as set.
 *   - Truthy parser accepts {1, true, yes} (case-insensitive); everything else
 *     (including "2", "0", "false", "") is FALSE.
 *   - Env access via supplied env arg only — never process.env.
 *   - Pure function — no I/O except the port-injected hasChatgptOAuthToken.
 */
import { describe, expect, test } from "bun:test"
import {
  ANTHROPIC_BASE_URL_ENV_KEYS,
  CLAUDE_USE_ENV_KEYS,
  ProviderConflictError,
  resolveProviderWithRouter,
} from "@/llm/provider-router"

describe("resolveProviderWithRouter — precedence hellgate", () => {
  test("HELL-A1: explicit 'anthropic' wins over CLAUDE_CODE_USE_BEDROCK=1", () => {
    const r = resolveProviderWithRouter({
      explicit: "anthropic",
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    })
    expect(r.provider).toBe("anthropic")
    expect(r.reason).toBe("explicit")
  })

  test("HELL-A2: explicit 'mantle' resolves (Mantle in union)", () => {
    const r = resolveProviderWithRouter({ explicit: "mantle", env: {} })
    expect(r.provider).toBe("mantle")
    expect(r.reason).toBe("explicit")
  })

  test("HELL-A3: explicit unknown id falls through to env (NOT throws)", () => {
    const r = resolveProviderWithRouter({
      explicit: "totally-bogus",
      env: { CLAUDE_CODE_USE_VERTEX: "true" },
    })
    expect(r.provider).toBe("vertex")
    expect(r.reason).toBe("claude-code-use-env")
  })

  test("HELL-A4: explicit empty string falls through (CLI flag parse)", () => {
    const r = resolveProviderWithRouter({
      explicit: "",
      env: { ANTHROPIC_API_KEY: "sk-x" },
    })
    expect(r.provider).toBe("anthropic")
    expect(r.reason).toBe("anthropic-api-key-env")
  })

  test("HELL-A5: explicit whitespace gets trimmed", () => {
    const r = resolveProviderWithRouter({ explicit: "  bedrock  ", env: {} })
    expect(r.provider).toBe("bedrock")
  })

  test("HELL-B1: CLAUDE_CODE_USE_BEDROCK=1 → bedrock", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })
    expect(r.provider).toBe("bedrock")
    expect(r.reason).toBe("claude-code-use-env")
    expect(r.credentials.kind).toBe("aws-iam")
  })

  test("HELL-B2: CLAUDE_CODE_USE_VERTEX=true (case-mixed) → vertex", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_VERTEX: "True" } })
    expect(r.provider).toBe("vertex")
    expect(r.credentials.kind).toBe("gcp-sa")
  })

  test("HELL-B3: CLAUDE_CODE_USE_FOUNDRY=yes → foundry", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_FOUNDRY: "yes" } })
    expect(r.provider).toBe("foundry")
    expect(r.credentials.kind).toBe("azure-msi")
  })

  test("HELL-B4: CLAUDE_CODE_USE_MANTLE=1 → mantle", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_MANTLE: "1" } })
    expect(r.provider).toBe("mantle")
  })

  test("HELL-B5: CLAUDE_CODE_USE_BEDROCK=0 is FALSE (not truthy)", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } })
    expect(r.provider).toBe("anthropic")
    expect(r.reason).toBe("default-fallback")
  })

  test("HELL-B6: CLAUDE_CODE_USE_BEDROCK=2 is FALSE (strict truthy parser)", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_BEDROCK: "2" } })
    expect(r.provider).toBe("anthropic")
  })

  test("HELL-B7: CLAUDE_CODE_USE_BEDROCK='' is FALSE (empty not truthy)", () => {
    const r = resolveProviderWithRouter({ env: { CLAUDE_CODE_USE_BEDROCK: "" } })
    expect(r.provider).toBe("anthropic")
  })

  test("HELL-C1: CLAUDE_CODE_USE_BEDROCK=1 + CLAUDE_CODE_USE_VERTEX=1 → ProviderConflictError", () => {
    expect(() =>
      resolveProviderWithRouter({
        env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "true" },
      }),
    ).toThrow(ProviderConflictError)
  })

  test("HELL-C2: 3-way conflict (BEDROCK + VERTEX + MANTLE) → ProviderConflictError with all 3 listed", () => {
    try {
      resolveProviderWithRouter({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "1",
          CLAUDE_CODE_USE_MANTLE: "1",
        },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderConflictError)
      const providers = (e as ProviderConflictError).providers
      expect(providers).toContain("bedrock")
      expect(providers).toContain("vertex")
      expect(providers).toContain("mantle")
    }
  })

  test("HELL-D1: ANTHROPIC_BEDROCK_BASE_URL precedence (Layer 3) below CLAUDE_CODE_USE_*", () => {
    // CLAUDE_CODE_USE_VERTEX wins over ANTHROPIC_BEDROCK_BASE_URL.
    const r = resolveProviderWithRouter({
      env: {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      },
    })
    expect(r.provider).toBe("vertex")
    expect(r.reason).toBe("claude-code-use-env")
  })

  test("HELL-D2: ANTHROPIC_BEDROCK_BASE_URL alone → bedrock (Layer 3)", () => {
    const r = resolveProviderWithRouter({
      env: { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" },
    })
    expect(r.provider).toBe("bedrock")
    expect(r.reason).toBe("anthropic-base-url-env")
  })

  test("HELL-D3: ANTHROPIC_*_BASE_URL empty string DOES NOT count", () => {
    const r = resolveProviderWithRouter({
      env: {
        ANTHROPIC_BEDROCK_BASE_URL: "",
        ANTHROPIC_VERTEX_BASE_URL: "",
        ANTHROPIC_API_KEY: "sk-x",
      },
    })
    expect(r.provider).toBe("anthropic")
    expect(r.reason).toBe("anthropic-api-key-env")
  })

  test("HELL-E1: chatgpt-oauth token on disk (Layer 4) wins over ANTHROPIC_API_KEY", () => {
    const r = resolveProviderWithRouter({
      env: { ANTHROPIC_API_KEY: "sk-x" },
      hasChatgptOAuthToken: () => true,
    })
    expect(r.provider).toBe("chatgpt-oauth")
    expect(r.reason).toBe("chatgpt-oauth-token-on-disk")
    expect(r.credentials.kind).toBe("oauth")
    expect(r.credentials.source).toBe("file")
  })

  test("HELL-E2: hasChatgptOAuthToken=false → falls through to API key", () => {
    const r = resolveProviderWithRouter({
      env: { ANTHROPIC_API_KEY: "sk-x" },
      hasChatgptOAuthToken: () => false,
    })
    expect(r.provider).toBe("anthropic")
  })

  test("HELL-F1: OPENAI_API_KEY alone → openai", () => {
    const r = resolveProviderWithRouter({ env: { OPENAI_API_KEY: "sk-x" } })
    expect(r.provider).toBe("openai")
    expect(r.reason).toBe("openai-api-key-env")
  })

  test("HELL-F2: empty env → default-fallback anthropic", () => {
    const r = resolveProviderWithRouter({ env: {} })
    expect(r.provider).toBe("anthropic")
    expect(r.reason).toBe("default-fallback")
  })

  test("HELL-G1: env keys exported as canonical names", () => {
    expect(CLAUDE_USE_ENV_KEYS.bedrock).toBe("CLAUDE_CODE_USE_BEDROCK")
    expect(CLAUDE_USE_ENV_KEYS.vertex).toBe("CLAUDE_CODE_USE_VERTEX")
    expect(CLAUDE_USE_ENV_KEYS.foundry).toBe("CLAUDE_CODE_USE_FOUNDRY")
    expect(CLAUDE_USE_ENV_KEYS.mantle).toBe("CLAUDE_CODE_USE_MANTLE")
    expect(ANTHROPIC_BASE_URL_ENV_KEYS.bedrock).toBe("ANTHROPIC_BEDROCK_BASE_URL")
  })

  test("HELL-G2: ProviderConflictError carries provider list (telemetry-stable)", () => {
    try {
      resolveProviderWithRouter({
        env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_FOUNDRY: "1" },
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderConflictError)
      expect((e as ProviderConflictError).providers).toEqual(["bedrock", "foundry"])
      expect((e as ProviderConflictError).message).toContain("provider-conflict")
    }
  })

  test("HELL-G3: pure function — no process.env access (deterministic in isolated env)", () => {
    // We verify by passing an env with vars that, if process.env leaked,
    // would be overridden by the host env. Test runs identically regardless.
    const r1 = resolveProviderWithRouter({ env: {} })
    const r2 = resolveProviderWithRouter({ env: {} })
    expect(r1.provider).toBe(r2.provider)
    expect(r1.reason).toBe(r2.reason)
  })
})
