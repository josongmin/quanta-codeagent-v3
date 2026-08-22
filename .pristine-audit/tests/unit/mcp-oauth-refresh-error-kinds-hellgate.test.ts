/** Jun-10 silent-failure audit #16 — error-kind routing at the MCP OAuth
 *  token-REFRESH boundary (`createConnectorsMcpOAuthProvider`'s refresh catch).
 *
 *  Checklist rule under test (audit §"Error-kind routing at auth/token
 *  boundaries"): any catch deciding OAuth re-auth must branch on a TYPED
 *  statusCode; `invalid_grant`/401 is the ONLY re-auth trigger. Before the
 *  fix, the token endpoint threw an untyped status-STRING Error, so the
 *  refresh catch treated a transient 503/429/network blip exactly like a
 *  revoked refresh token → surprise INTERACTIVE re-auth (browser pop) and the
 *  still-valid refresh token overwritten.
 *
 *  Table-driven per status, asserting REAL observable effects with
 *  fresh-readback against the fake store:
 *    - 401 / invalid_grant → re-auth (browser flow runs a 2nd time)
 *    - 503 / 429 / network → NO re-auth, tokenFor degrades to `undefined`,
 *      the stored refresh token survives byte-identical, and once the IdP
 *      recovers the SAME refresh token still refreshes (proof nothing was
 *      destroyed).
 *  Paired control: the two revocation rows already passed pre-fix; the
 *  transient rows were RED against the unfixed untyped catch.
 */

import { afterEach, describe, expect, it } from "bun:test"
import type {
  ClockPort,
  FetchPort,
  FetchPortResponse,
  TokenRecord,
  TokenStorePort,
} from "@/connectors"
import { createConnectorsMcpOAuthProvider } from "@/host/runtime/mcp-oauth-provider"
import { __resetLoggerRateLimit } from "@/shared"

// The provider logs per-row "mcp-oauth: …" lines through the shared logger,
// whose per-label rate-limit bucket is PROCESS-global — drain it here and a
// later file's stderr-capture assertions see zero writes. Restore after each
// row (same pattern as approval-state-attribution-logger-hellgate).
afterEach(() => {
  __resetLoggerRateLimit()
})

const ISSUER = "https://idp.example.com"

const jsonResponse = (status: number, body: unknown): FetchPortResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
})

/** Refresh-grant behavior the table flips per row:
 *  `undefined` ⇒ refresh succeeds; `{ status, body }` ⇒ HTTP failure;
 *  `{ reject }` ⇒ the fetch itself throws (network). */
type RefreshMode = undefined | { status: number; body: unknown } | { reject: string }

/** Token-endpoint behavior: a refresh grant honors the active `RefreshMode`;
 *  everything else (auth-code grant, healthy refresh) mints normally. */
const tokenGrantResponse = (isRefresh: boolean, mode: RefreshMode): FetchPortResponse => {
  if (isRefresh && mode !== undefined) {
    if ("reject" in mode) throw new TypeError(mode.reject)
    return jsonResponse(mode.status, mode.body)
  }
  return jsonResponse(200, {
    access_token: isRefresh ? "ACCESS-REFRESHED" : "ACCESS-FIRST",
    refresh_token: "REFRESH-1",
    token_type: "Bearer",
    expires_in: 3600,
  })
}

/** A fake IdP whose refresh-grant outcome is settable per test row. */
const fakeIdp = () => {
  let refreshMode: RefreshMode
  const fetchPort: FetchPort = async (url, init) => {
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonResponse(200, {
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      })
    }
    if (url === `${ISSUER}/token`) {
      return tokenGrantResponse((init?.body ?? "").includes("refresh_token"), refreshMode)
    }
    return jsonResponse(404, {})
  }
  return {
    fetchPort,
    setRefreshMode: (m: RefreshMode) => {
      refreshMode = m
    },
  }
}

const fakeStore = () => {
  const map = new Map<string, TokenRecord>()
  const port: TokenStorePort = {
    read: async (id) => map.get(id),
    write: async (id, rec) => {
      map.set(id, rec)
    },
    delete: async (id) => {
      map.delete(id)
    },
  }
  return { port, peek: (id: string) => map.get(id) }
}

const fakeClock = (start = 1_000_000): ClockPort & { advance: (ms: number) => void } => {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

const fakeBrowser = () => {
  let n = 0
  return {
    runs: () => n,
    run: async (): Promise<{ code: string; verifier: string; redirectUri: string }> => {
      n += 1
      return { code: "AUTH-CODE", verifier: "VERIFIER", redirectUri: "http://localhost:1455/cb" }
    },
  }
}

/** Provider over fresh fakes, pre-seeded through ONE real authorization so a
 *  stored record (access + refresh token) exists, then expired so the next
 *  `tokenFor` is forced through the refresh grant. */
const buildExpiredProvider = async () => {
  const idp = fakeIdp()
  const store = fakeStore()
  const browser = fakeBrowser()
  const clock = fakeClock()
  const provider = createConnectorsMcpOAuthProvider({
    fetchPort: idp.fetchPort,
    tokenStore: store.port,
    clockPort: clock,
    runBrowserFlow: browser.run,
    clientId: "client-abc",
    issuerFor: () => ISSUER,
  })
  const first = await provider.tokenFor("srv")
  expect(first).toBe("ACCESS-FIRST")
  expect(browser.runs()).toBe(1)
  clock.advance(3_600_001) // past expires_in=3600
  return { provider, idp, store, browser }
}

describe("mcp-oauth refresh catch branches on typed statusCode — invalid_grant/401 is the only re-auth trigger (#16)", () => {
  const revocationRows: readonly { name: string; status: number; body: unknown }[] = [
    {
      name: "401 → refresh token revoked ⇒ re-auth via a fresh browser flow [paired control]",
      status: 401,
      body: { error: "invalid_token" },
    },
    {
      name: "400 invalid_grant → explicit revocation ⇒ re-auth [paired control]",
      status: 400,
      body: { error: "invalid_grant" },
    },
  ]

  for (const row of revocationRows) {
    it(row.name, async () => {
      const { provider, idp, browser } = await buildExpiredProvider()
      idp.setRefreshMode({ status: row.status, body: row.body })
      const reauthed = await provider.tokenFor("srv")
      expect(reauthed).toBe("ACCESS-FIRST") // fresh auth-code grant
      expect(browser.runs()).toBe(2) // interactive re-auth DID run
    })
  }

  const transientRows: readonly { name: string; mode: RefreshMode }[] = [
    {
      name: "503 → transient: NO interactive re-auth, NO token destruction",
      mode: { status: 503, body: { error: "upstream_down" } },
    },
    {
      name: "429 → transient: NO interactive re-auth, NO token destruction",
      mode: { status: 429, body: { error: "rate_limited" } },
    },
    {
      name: "network throw → transient: NO interactive re-auth, NO token destruction",
      mode: { reject: "fetch failed: ECONNRESET" },
    },
  ]

  for (const row of transientRows) {
    it(row.name, async () => {
      const { provider, idp, store, browser } = await buildExpiredProvider()
      idp.setRefreshMode(row.mode)

      const result = await provider.tokenFor("srv")

      // Degrades to unauthenticated for THIS load — total contract holds…
      expect(result).toBeUndefined()
      // …but NO surprise browser pop (the audit's headline harm)…
      expect(browser.runs()).toBe(1)
      // …and the stored refresh token survives byte-identical (fresh-readback).
      expect(store.peek("srv")?.refreshToken).toBe("REFRESH-1")

      // Recovery proof: once the IdP is healthy again, the PRESERVED refresh
      // token still refreshes — no re-auth was ever needed.
      idp.setRefreshMode(undefined)
      const recovered = await provider.tokenFor("srv")
      expect(recovered).toBe("ACCESS-REFRESHED")
      expect(browser.runs()).toBe(1)
    })
  }
})
