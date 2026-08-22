/**
 * OAuth dynamic client registration — hellgate (ADR-0160 Phase C).
 *
 * Seals 10 adversarial cases for RFC 7591 dynamic client registration:
 *   1.  happy: 200 with client_id → returns OAuthClientRegistration
 *   2.  client_secret present → propagated
 *   3.  registration_access_token + registration_client_uri propagated
 *   4.  missing client_id → missing-client-id error
 *   5.  empty client_id string → missing-client-id error
 *   6.  400 status → registration-rejected error
 *   7.  malformed JSON → registration-malformed error
 *   8.  non-object body (array) → registration-malformed error
 *   9.  network throws → network-failed error
 *   10. request body shape: redirect_uris + content-type header verified
 */

import { describe, expect, test } from "bun:test"
import type { FetchPort, FetchPortResponse } from "@/connectors"
import { OAuthRegistrationError, registerOAuthClient } from "@/connectors"

interface ScriptedReg {
  readonly status: number
  readonly body: string
  readonly throws?: boolean
}

const scriptReg = (
  resp: ScriptedReg,
): {
  fetchPort: FetchPort
  readonly captures: { url: string; init: Parameters<FetchPort>[1] }[]
} => {
  const captures: { url: string; init: Parameters<FetchPort>[1] }[] = []
  const fetchPort: FetchPort = async (url, init) => {
    captures.push({ url, init })
    if (resp.throws === true) throw new Error("net down")
    const res: FetchPortResponse = {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      text: async () => resp.body,
    }
    return res
  }
  return { fetchPort, captures }
}

describe("oauth-registration-hellgate", () => {
  test("HELL-1: 200 with client_id only → returns registration", async () => {
    const { fetchPort } = scriptReg({
      status: 200,
      body: JSON.stringify({ client_id: "abc123" }),
    })
    const r = await registerOAuthClient(
      "https://idp.example/register",
      { redirectUris: ["http://localhost:1455/cb"] },
      fetchPort,
    )
    expect(r.clientId).toBe("abc123")
    expect(r.clientSecret).toBeUndefined()
  })

  test("HELL-2: client_secret present → propagated", async () => {
    const { fetchPort } = scriptReg({
      status: 200,
      body: JSON.stringify({ client_id: "abc", client_secret: "xyz" }),
    })
    const r = await registerOAuthClient(
      "https://idp.example/register",
      { redirectUris: ["http://localhost/cb"] },
      fetchPort,
    )
    expect(r.clientSecret).toBe("xyz")
  })

  test("HELL-3: registration_access_token + registration_client_uri propagated", async () => {
    const { fetchPort } = scriptReg({
      status: 200,
      body: JSON.stringify({
        client_id: "abc",
        registration_access_token: "rat",
        registration_client_uri: "https://idp.example/reg/abc",
      }),
    })
    const r = await registerOAuthClient(
      "https://idp.example/register",
      { redirectUris: ["http://localhost/cb"] },
      fetchPort,
    )
    expect(r.registrationAccessToken).toBe("rat")
    expect(r.registrationClientUri).toBe("https://idp.example/reg/abc")
  })

  test("HELL-4: missing client_id → missing-client-id error", async () => {
    const { fetchPort } = scriptReg({ status: 200, body: JSON.stringify({}) })
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("missing-client-id")
    }
  })

  test("HELL-5: empty client_id string → missing-client-id error", async () => {
    const { fetchPort } = scriptReg({ status: 200, body: JSON.stringify({ client_id: "" }) })
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("missing-client-id")
    }
  })

  test("HELL-6: 400 → registration-rejected", async () => {
    const { fetchPort } = scriptReg({
      status: 400,
      body: JSON.stringify({ error: "invalid_redirect_uri" }),
    })
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("registration-rejected")
    }
  })

  test("HELL-7: malformed JSON → registration-malformed", async () => {
    const { fetchPort } = scriptReg({ status: 200, body: "{ not json" })
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("registration-malformed")
    }
  })

  test("HELL-8: array body (not object) → registration-malformed", async () => {
    const { fetchPort } = scriptReg({ status: 200, body: "[]" })
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("registration-malformed")
    }
  })

  test("HELL-9: network throws → network-failed", async () => {
    const fetchPort: FetchPort = async () => {
      throw new Error("DNS")
    }
    try {
      await registerOAuthClient(
        "https://idp.example/register",
        { redirectUris: ["http://localhost/cb"] },
        fetchPort,
      )
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthRegistrationError)
      if (e instanceof OAuthRegistrationError) expect(e.code).toBe("network-failed")
    }
  })

  test("HELL-10: request body + content-type header is well-formed RFC 7591", async () => {
    const { fetchPort, captures } = scriptReg({
      status: 200,
      body: JSON.stringify({ client_id: "x" }),
    })
    await registerOAuthClient(
      "https://idp.example/register",
      {
        redirectUris: ["http://localhost/cb"],
        clientName: "Quanta",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scope: "read write",
      },
      fetchPort,
    )
    expect(captures.length).toBe(1)
    const cap = captures[0]
    if (cap === undefined) throw new Error("no capture")
    expect(cap.init?.method).toBe("POST")
    expect(cap.init?.headers?.["content-type"]).toBe("application/json")
    const body = JSON.parse(cap.init?.body ?? "{}") as Record<string, unknown>
    expect(body.redirect_uris).toEqual(["http://localhost/cb"])
    expect(body.client_name).toBe("Quanta")
    expect(body.token_endpoint_auth_method).toBe("none")
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
    expect(body.response_types).toEqual(["code"])
    expect(body.scope).toBe("read write")
  })
})
