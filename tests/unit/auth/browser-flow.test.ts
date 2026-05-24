import { beforeEach, describe, expect, test } from "bun:test"
import {
  BrowserFlowError,
  buildAuthorizeUrl,
  type OAuthCallbackProvider,
  runBrowserFlow,
} from "../../../src/auth/chatgpt-oauth/browser-flow"
import type { OAuthConfig } from "../../../src/auth/chatgpt-oauth/config"

const cfg: OAuthConfig = {
  issuer: "https://auth.example.test",
  clientId: "client_xyz",
  apiBase: "https://api.example.test",
  sku: "QUANTA",
  originator: "quanta-test",
}

describe("buildAuthorizeUrl", () => {
  test("includes every Codex query param", () => {
    const url = new URL(
      buildAuthorizeUrl({
        cfg,
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        codeChallenge: "ABC",
        state: "XYZ",
      }),
    )
    expect(url.origin + url.pathname).toBe("https://auth.example.test/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client_xyz")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe("ABC")
    expect(url.searchParams.get("state")).toBe("XYZ")
    expect(url.searchParams.get("scope")).toContain("openid")
    expect(url.searchParams.get("scope")).toContain("offline_access")
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true")
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    expect(url.searchParams.get("originator")).toBe("quanta-test")
  })
})

const makeControlledProvider = (): {
  provider: OAuthCallbackProvider
  succeed(code?: string): void
  mismatch(): void
  oauthError(reason?: string): void
} => {
  let resolveReceived: ((value: { code: string }) => void) | undefined
  let rejectReceived: ((error: Error) => void) | undefined
  const provider: OAuthCallbackProvider = {
    async start(input) {
      if (input.signal?.aborted) {
        throw new BrowserFlowError("user_cancel", "login aborted by caller")
      }
      const received = new Promise<{ code: string }>((resolve, reject) => {
        resolveReceived = resolve
        rejectReceived = reject
        if (input.signal !== undefined) {
          input.signal.addEventListener(
            "abort",
            () => reject(new BrowserFlowError("user_cancel", "login aborted by caller")),
            { once: true },
          )
        }
      })
      return {
        redirectUri: "http://localhost:1455/auth/callback",
        received,
      }
    },
  }
  return {
    provider,
    succeed(code = "test-code") {
      resolveReceived?.({ code })
    },
    mismatch() {
      rejectReceived?.(new BrowserFlowError("state_mismatch", "state mismatch on callback"))
    },
    oauthError(reason = "access_denied") {
      rejectReceived?.(new BrowserFlowError("user_cancel", `oauth error: ${reason}`))
    },
  }
}

let capturedUrl: string | null = null
const captureOpener = (u: string): void => {
  capturedUrl = u
}

beforeEach(() => {
  capturedUrl = null
})

describe("runBrowserFlow", () => {
  test("happy path: returns code + verifier on valid callback", async () => {
    const controlled = makeControlledProvider()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 5000,
      callbackProvider: controlled.provider,
    })
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    controlled.succeed()
    const result = await flow
    expect(result.code).toBe("test-code")
    expect(result.verifier.length).toBeGreaterThanOrEqual(43)
    expect(result.redirectUri).toBe("http://localhost:1455/auth/callback")
  })

  test("state mismatch is rejected (CSRF guard)", async () => {
    // Attach .catch up front so the reject that fires during `drive(...)`
    // isn't transiently treated as an unhandled rejection by bun:test
    // (which would surface as a "(fail)" even though the assertion below
    // matches).
    const controlled = makeControlledProvider()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 5000,
      callbackProvider: controlled.provider,
    }).catch((e: Error) => e)
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    controlled.mismatch()
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "state_mismatch" })
  })

  test("oauth error param is surfaced as user_cancel", async () => {
    const controlled = makeControlledProvider()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 5000,
      callbackProvider: controlled.provider,
    }).catch((e: Error) => e)
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    controlled.oauthError()
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })

  test("times out when no callback arrives within timeoutMs", async () => {
    const controlled = makeControlledProvider()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 50,
      callbackProvider: controlled.provider,
    }).catch((e: Error) => e)
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "timeout" })
  })

  test("aborts immediately when caller signal fires", async () => {
    const ac = new AbortController()
    const controlled = makeControlledProvider()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 60000,
      signal: ac.signal,
      callbackProvider: controlled.provider,
    }).catch((e: Error) => e)
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })

  test("rejects synchronously when signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const controlled = makeControlledProvider()
    const result = await runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 60000,
      signal: ac.signal,
      callbackProvider: controlled.provider,
    }).catch((e: Error) => e)
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })
})

describe("runBrowserFlow port handling", () => {
  test("ports unavailable in the callback provider surface a typed ports_in_use error", async () => {
    const provider: OAuthCallbackProvider = {
      async start() {
        throw new BrowserFlowError("ports_in_use", "Local callback ports [1455, 1457] are already in use.")
      },
    }
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 200,
      callbackProvider: provider,
    }).catch(
      (e: Error) => e,
    )
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "ports_in_use" })
  })
})
