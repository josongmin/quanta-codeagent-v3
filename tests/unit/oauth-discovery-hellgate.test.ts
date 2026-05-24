/**
 * OAuth discovery — hellgate (ADR-0160 Phase C).
 *
 * Seals 11 adversarial cases for RFC 8414 well-known discovery + OIDC fallback:
 *   1.  happy: 200 RFC 8414 doc → endpoints
 *   2.  happy with registration endpoint
 *   3.  404 RFC 8414 → fallback OIDC 200 → endpoints
 *   4.  404 both → OAuthDiscoveryError code=well-known-404
 *   5.  primary 500 (not 404) → well-known-404 error (non-OK non-404 short-circuits)
 *   6.  primary malformed JSON → well-known-malformed
 *   7.  primary 200 missing token_endpoint → missing-required-field
 *   8.  network throws on primary → network-failed
 *   9.  primary 404, fallback OIDC malformed → well-known-malformed
 *   10. primary 404, fallback OIDC missing required field → missing-required-field
 *   11. trailing slash in issuer normalized (does NOT produce double slash in URL)
 */

import { describe, expect, test } from "bun:test"
import type { FetchPort, FetchPortResponse } from "@/connectors"
import { discoverOAuthEndpoints, OAuthDiscoveryError } from "@/connectors"

interface ScriptedResponse {
  readonly url: string
  readonly status: number
  readonly body: string
  readonly throws?: boolean
}

const scriptFetch = (responses: ScriptedResponse[]): { fetchPort: FetchPort; urls: string[] } => {
  const urls: string[] = []
  const fetchPort: FetchPort = async (url, _init) => {
    urls.push(url)
    const match = responses.find((r) => r.url === url)
    if (match === undefined) throw new Error(`unexpected fetch to ${url}`)
    if (match.throws === true) throw new Error("net down")
    const res: FetchPortResponse = {
      status: match.status,
      ok: match.status >= 200 && match.status < 300,
      text: async () => match.body,
    }
    return res
  }
  return { fetchPort, urls }
}

describe("oauth-discovery-hellgate", () => {
  test("HELL-1: RFC 8414 200 → endpoints", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 200,
        body: JSON.stringify({
          authorization_endpoint: "https://idp.example/auth",
          token_endpoint: "https://idp.example/token",
        }),
      },
    ])
    const r = await discoverOAuthEndpoints("https://idp.example", fetchPort)
    expect(r.authorizeEndpoint).toBe("https://idp.example/auth")
    expect(r.tokenEndpoint).toBe("https://idp.example/token")
    expect(r.registrationEndpoint).toBeUndefined()
  })

  test("HELL-2: includes registration_endpoint when present", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 200,
        body: JSON.stringify({
          authorization_endpoint: "https://idp.example/auth",
          token_endpoint: "https://idp.example/token",
          registration_endpoint: "https://idp.example/register",
        }),
      },
    ])
    const r = await discoverOAuthEndpoints("https://idp.example", fetchPort)
    expect(r.registrationEndpoint).toBe("https://idp.example/register")
  })

  test("HELL-3: 404 RFC 8414 → fallback OIDC 200 → endpoints", async () => {
    const { fetchPort, urls } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 404,
        body: "",
      },
      {
        url: "https://idp.example/.well-known/openid-configuration",
        status: 200,
        body: JSON.stringify({
          authorization_endpoint: "https://idp.example/auth",
          token_endpoint: "https://idp.example/token",
        }),
      },
    ])
    const r = await discoverOAuthEndpoints("https://idp.example", fetchPort)
    expect(r.tokenEndpoint).toBe("https://idp.example/token")
    expect(urls.length).toBe(2)
  })

  test("HELL-4: 404 on both → well-known-404 typed error", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 404,
        body: "",
      },
      { url: "https://idp.example/.well-known/openid-configuration", status: 404, body: "" },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) {
        expect(e.code).toBe("well-known-404")
      }
    }
  })

  test("HELL-5: primary 500 (not 404) → well-known-404 error (no fallback)", async () => {
    const { fetchPort, urls } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 500,
        body: "",
      },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("well-known-404")
    }
    expect(urls.length).toBe(1) // no fallback on non-404
  })

  test("HELL-6: malformed JSON primary → well-known-malformed", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 200,
        body: "{ not json",
      },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("well-known-malformed")
    }
  })

  test("HELL-7: primary missing token_endpoint → missing-required-field", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 200,
        body: JSON.stringify({ authorization_endpoint: "https://idp.example/auth" }),
      },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("missing-required-field")
    }
  })

  test("HELL-8: network throws on primary → network-failed", async () => {
    const fetchPort: FetchPort = async () => {
      throw new Error("net down")
    }
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("network-failed")
    }
  })

  test("HELL-9: 404 primary, malformed JSON fallback → well-known-malformed", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 404,
        body: "",
      },
      {
        url: "https://idp.example/.well-known/openid-configuration",
        status: 200,
        body: "{ broken",
      },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("well-known-malformed")
    }
  })

  test("HELL-10: 404 primary, OIDC missing token_endpoint → missing-required-field", async () => {
    const { fetchPort } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 404,
        body: "",
      },
      {
        url: "https://idp.example/.well-known/openid-configuration",
        status: 200,
        body: JSON.stringify({ authorization_endpoint: "https://idp.example/auth" }),
      },
    ])
    try {
      await discoverOAuthEndpoints("https://idp.example", fetchPort)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthDiscoveryError)
      if (e instanceof OAuthDiscoveryError) expect(e.code).toBe("missing-required-field")
    }
  })

  test("HELL-11: trailing slash issuer is normalized (no double slash in URL)", async () => {
    const { fetchPort, urls } = scriptFetch([
      {
        url: "https://idp.example/.well-known/oauth-authorization-server",
        status: 200,
        body: JSON.stringify({
          authorization_endpoint: "https://idp.example/auth",
          token_endpoint: "https://idp.example/token",
        }),
      },
    ])
    await discoverOAuthEndpoints("https://idp.example/", fetchPort)
    expect(urls[0]).toBe("https://idp.example/.well-known/oauth-authorization-server")
  })
})
