import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Server, createServer } from "node:http"
import {
  BrowserFlowError,
  buildAuthorizeUrl,
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

// runBrowserFlow integration tests — uses a real loopback HTTP server bind.
// We capture the opener URL, parse the redirect, and fetch the callback
// manually to drive the flow without a real browser.

const drive = async (
  authorizeUrl: string,
  overrides: { code?: string | null; state?: string | null; error?: string } = {},
): Promise<void> => {
  const u = new URL(authorizeUrl)
  const redirectUri = u.searchParams.get("redirect_uri") ?? ""
  const realState = u.searchParams.get("state") ?? ""
  const cb = new URL(redirectUri)
  if (overrides.error) cb.searchParams.set("error", overrides.error)
  else {
    cb.searchParams.set("code", overrides.code ?? "test-code")
    cb.searchParams.set("state", overrides.state ?? realState)
  }
  // Body-consume + small settle wait so the server can finish closing the
  // socket before runBrowserFlow's finally block tears the server down
  // (avoids an "error" event firing after Promise.race already rejected,
  // which surfaces as an unhandled-rejection-as-test-fail under bun:test).
  const res = await fetch(cb.toString())
  await res.text()
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
    const flow = runBrowserFlow({ cfg, opener: captureOpener, timeoutMs: 5000 })
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    await drive(capturedUrl)
    const result = await flow
    expect(result.code).toBe("test-code")
    expect(result.verifier.length).toBeGreaterThanOrEqual(43)
    // CRITICAL: must be `localhost` (not `127.0.0.1`) to match the OAuth
    // app's registered redirect_uri — see browser-flow.ts comment.
    expect(result.redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
  })

  test("state mismatch is rejected (CSRF guard)", async () => {
    // Attach .catch up front so the reject that fires during `drive(...)`
    // isn't transiently treated as an unhandled rejection by bun:test
    // (which would surface as a "(fail)" even though the assertion below
    // matches).
    const flow = runBrowserFlow({ cfg, opener: captureOpener, timeoutMs: 5000 }).catch(
      (e: Error) => e,
    )
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    await drive(capturedUrl, { state: "wrong-state" })
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "state_mismatch" })
  })

  test("oauth error param is surfaced as user_cancel", async () => {
    const flow = runBrowserFlow({ cfg, opener: captureOpener, timeoutMs: 5000 }).catch(
      (e: Error) => e,
    )
    while (capturedUrl === null) await new Promise((r) => setTimeout(r, 5))
    await drive(capturedUrl, { error: "access_denied" })
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })

  test("times out when no callback arrives within timeoutMs", async () => {
    const flow = runBrowserFlow({ cfg, opener: captureOpener, timeoutMs: 50 }).catch(
      (e: Error) => e,
    )
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "timeout" })
  })

  test("aborts immediately when caller signal fires", async () => {
    const ac = new AbortController()
    const flow = runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 60000,
      signal: ac.signal,
    }).catch((e: Error) => e)
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })

  test("rejects synchronously when signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await runBrowserFlow({
      cfg,
      opener: captureOpener,
      timeoutMs: 60000,
      signal: ac.signal,
    }).catch((e: Error) => e)
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "user_cancel" })
  })
})

describe("runBrowserFlow port handling", () => {
  let blockers: Server[] = []

  afterEach(() => {
    for (const s of blockers) s.close()
    blockers = []
  })

  const occupy = async (port: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once("error", () => {
        s.close()
        resolve(false)
      })
      s.listen(port, "127.0.0.1", () => {
        blockers.push(s)
        resolve(true)
      })
    })

  test("ports_in_use surfaces a typed error when 1455 + 1457 both occupied", async () => {
    const a = await occupy(1455)
    const b = await occupy(1457)
    if (!a || !b) return // Skip on host where ports are already taken — test would be flaky.
    const flow = runBrowserFlow({ cfg, opener: captureOpener, timeoutMs: 200 }).catch(
      (e: Error) => e,
    )
    const result = await flow
    expect(result).toMatchObject({ name: "BrowserFlowError", reason: "ports_in_use" })
  })
})
