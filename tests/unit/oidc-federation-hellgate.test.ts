/**
 * ★ CONTRACT — ADR-0163 §oidc-federation:
 *   - Closed-port: file / http / clock are all DI'd; no node:fs, no fetch,
 *     no Date.now reach inside the exchanger.
 *   - Token file size floor (100 B) + ceiling (64 KiB) + JWT 3-segment shape
 *     are STRUCTURAL validations (typed-fail before HTTP call).
 *   - Exchange HTTP 4xx → exchange-rejected (do NOT retry).
 *   - Exchange HTTP 5xx → exchange-transient (retry permitted).
 *   - Response without access_token or expires_in →
 *     exchange-malformed-response.
 *   - exchangeEndpointBase empty → exchange-misconfigured at construction.
 *   - identityTokenFile / federationRuleId empty → exchange-misconfigured at
 *     exchange call.
 *   - expiresAt = clock.now() + expires_in*1000 (vendor TTL, no amplifier).
 *   - File re-read on EVERY exchange (no caching — Kubernetes rotates).
 */
import { describe, expect, test } from "bun:test"
import {
  type ClockPort,
  type FileReaderPort,
  type HttpClientPort,
  OIDC_ENV_KEYS,
  OidcFederationError,
  OidcFederationExchanger,
  readOidcEnv,
  TOKEN_FILE_MAX_BYTES,
  TOKEN_FILE_MIN_BYTES,
} from "@/llm/oidc-federation"

/** A canonical 250-byte JWT-shaped token for tests (3 dot-separated segments). */
const makeFakeJwt = (): string => `${"a".repeat(60)}.${"b".repeat(120)}.${"c".repeat(60)}` // 60 + 1 + 120 + 1 + 60 = 242 bytes

const fixedClock = (t: number): ClockPort => ({ now: () => t })

const fileReaderReturning = (body: string): FileReaderPort => ({
  read: async (_path) => body,
})

const fileReaderThrowing = (err: Error): FileReaderPort => ({
  read: async (_path) => {
    throw err
  },
})

const httpClientReturning = (status: number, body: unknown): HttpClientPort => ({
  post: async (_url, _body, _headers) => ({ status, body }),
})

describe("OidcFederationExchanger — hellgate", () => {
  test("HELL-O1: constructor with empty exchangeEndpointBase → exchange-misconfigured", () => {
    expect(
      () =>
        new OidcFederationExchanger({
          fileReader: fileReaderReturning(""),
          httpClient: httpClientReturning(200, {}),
          clock: fixedClock(1000),
          exchangeEndpointBase: "",
        }),
    ).toThrow(OidcFederationError)
  })

  test("HELL-O2: token file missing → token-file-missing", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderThrowing(new Error("ENOENT")),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/does/not/exist",
        federationRuleId: "rule-x",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect(e).toBeInstanceOf(OidcFederationError)
      expect((e as OidcFederationError).code).toBe("token-file-missing")
    }
  })

  test("HELL-O3: token < 100 bytes (too small) → token-file-malformed", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning("short.payload.sig"),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("token-file-malformed")
      expect((e as OidcFederationError).message).toContain("too small")
    }
  })

  test("HELL-O4: token > 64 KiB (too large) → token-file-malformed", async () => {
    const huge = `${"a".repeat(70_000)}.${"b".repeat(100)}.${"c".repeat(60)}`
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(huge),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("token-file-malformed")
      expect((e as OidcFederationError).message).toContain("too large")
    }
  })

  test("HELL-O5: token without 2 dots (wrong JWT shape) → token-file-malformed", async () => {
    const nonJwt = "a".repeat(200) // no dots
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(nonJwt),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("token-file-malformed")
      expect((e as OidcFederationError).message).toContain("JWT-shaped")
    }
  })

  test("HELL-O6: HTTP 403 (forbidden) → exchange-rejected (do NOT retry)", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(403, { error: "rule revoked" }),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-rejected")
      expect((e as OidcFederationError).httpStatus).toBe(403)
    }
  })

  test("HELL-O7: HTTP 503 (server error) → exchange-transient (retry permitted)", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(503, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-transient")
      expect((e as OidcFederationError).httpStatus).toBe(503)
    }
  })

  test("HELL-O8: response without access_token → exchange-malformed-response", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(200, { expires_in: 3600 }),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-malformed-response")
      expect((e as OidcFederationError).message).toContain("access_token")
    }
  })

  test("HELL-O9: response without expires_in → exchange-malformed-response", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(200, { access_token: "tok-x" }),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-malformed-response")
      expect((e as OidcFederationError).message).toContain("expires_in")
    }
  })

  test("HELL-O10: empty identityTokenFile arg → exchange-misconfigured", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "",
        federationRuleId: "r",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-misconfigured")
    }
  })

  test("HELL-O11: empty federationRuleId → exchange-misconfigured", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(200, {}),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    try {
      await exchanger.exchangeToken({
        identityTokenFile: "/t",
        federationRuleId: "",
      })
      throw new Error("unreachable")
    } catch (e) {
      expect((e as OidcFederationError).code).toBe("exchange-misconfigured")
    }
  })

  test("HELL-O12: success — expiresAt = clock.now() + expires_in*1000", async () => {
    const exchanger = new OidcFederationExchanger({
      fileReader: fileReaderReturning(makeFakeJwt()),
      httpClient: httpClientReturning(200, {
        access_token: "tok-abc",
        expires_in: 3600,
      }),
      clock: fixedClock(1_000_000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    const result = await exchanger.exchangeToken({
      identityTokenFile: "/t",
      federationRuleId: "r",
      orgId: "org-x",
    })
    expect(result.accessToken).toBe("tok-abc")
    expect(result.expiresAt).toBe(1_000_000 + 3600 * 1000)
    expect(result.credentials.kind).toBe("oidc-federation")
    expect(result.credentials.source).toBe("file")
  })

  test("HELL-O13: file is RE-READ on every exchange (no caching — k8s rotation)", async () => {
    let readCount = 0
    const reader: FileReaderPort = {
      read: async () => {
        readCount++
        return makeFakeJwt()
      },
    }
    const exchanger = new OidcFederationExchanger({
      fileReader: reader,
      httpClient: httpClientReturning(200, {
        access_token: "tok-x",
        expires_in: 60,
      }),
      clock: fixedClock(1000),
      exchangeEndpointBase: "https://api.anthropic.com",
    })
    await exchanger.exchangeToken({ identityTokenFile: "/t", federationRuleId: "r" })
    await exchanger.exchangeToken({ identityTokenFile: "/t", federationRuleId: "r" })
    await exchanger.exchangeToken({ identityTokenFile: "/t", federationRuleId: "r" })
    expect(readCount).toBe(3) // 3 calls = 3 file reads, no cache
  })

  test("HELL-O14: env constants are stable (telemetry)", () => {
    expect(OIDC_ENV_KEYS.identityTokenFile).toBe("ANTHROPIC_IDENTITY_TOKEN_FILE")
    expect(OIDC_ENV_KEYS.federationRuleId).toBe("ANTHROPIC_FEDERATION_RULE_ID")
    expect(OIDC_ENV_KEYS.orgId).toBe("ANTHROPIC_ORGANIZATION_ID")
    expect(TOKEN_FILE_MIN_BYTES).toBe(100)
    expect(TOKEN_FILE_MAX_BYTES).toBe(64 * 1024)
  })

  test("HELL-O15: readOidcEnv — full triad present → ExchangeRequest", () => {
    const result = readOidcEnv({
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
      ANTHROPIC_FEDERATION_RULE_ID: "rule-abc",
      ANTHROPIC_ORGANIZATION_ID: "org-xyz",
    })
    expect(result?.identityTokenFile).toBe("/var/run/secrets/token")
    expect(result?.federationRuleId).toBe("rule-abc")
    expect(result?.orgId).toBe("org-xyz")
  })

  test("HELL-O16: readOidcEnv — token file absent → undefined", () => {
    const result = readOidcEnv({ ANTHROPIC_FEDERATION_RULE_ID: "rule-x" })
    expect(result).toBeUndefined()
  })

  test("HELL-O17: readOidcEnv — rule id absent → undefined (federation requires both)", () => {
    const result = readOidcEnv({ ANTHROPIC_IDENTITY_TOKEN_FILE: "/t" })
    expect(result).toBeUndefined()
  })

  test("HELL-O18: readOidcEnv — orgId optional → ExchangeRequest without orgId", () => {
    const result = readOidcEnv({
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/t",
      ANTHROPIC_FEDERATION_RULE_ID: "r",
    })
    expect(result?.orgId).toBeUndefined()
  })
})
