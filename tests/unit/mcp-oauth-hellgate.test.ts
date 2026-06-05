/** H18 — MCP OAuth integration hellgate (write FIRST: red → green).
 *
 *  Seals the OAuth PORT seam + the connectors-backed host adapter in isolation
 *  against a FAKE auth server + fake browser-flow + fake token store:
 *    (1) knob OFF ⇒ no discovery, no flow, byte-identical (provider never built);
 *    (2) discovery resolves endpoints (RFC 8414 well-known via fake fetch);
 *    (3) PKCE authorize → token stored in the fake store;
 *    (4) the resolved bearer is attached to subsequent MCP HTTP requests (e2e);
 *    (5) a stored, unexpired token is reused (no second browser flow);
 *    (6) expiry ⇒ refresh via the rotator (RFC 6749 §6 refresh_token), no flow;
 *    (7) refresh failure ⇒ re-auth (a fresh browser flow);
 *    (8) tokens never appear in any log/output.
 *
 *  The port (`@/mcp/oauth`) ships only the seam + a safe default; the
 *  connectors-backed impl (`@/host/runtime/mcp-oauth-provider`) is the only
 *  layer allowed to reach `@/connectors`.
 */

import { describe, expect, it } from "bun:test"
import type {
  ClockPort,
  FetchPort,
  FetchPortResponse,
  TokenRecord,
  TokenStorePort,
} from "@/connectors"
import {
  buildMcpOAuthWiring,
  createConnectorsMcpOAuthProvider,
} from "@/host/runtime/mcp-oauth-provider"
import { headlessOAuthRejecter, type McpOAuthProviderPort } from "@/mcp"

// ── fakes ───────────────────────────────────────────────────────────────────

const jsonResponse = (status: number, body: unknown): FetchPortResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
})

/** A fake IdP: RFC 8414 well-known + a token endpoint that mints/refreshes. */
const fakeIdp = (issuer: string) => {
  const calls: { url: string; method: string; body?: string }[] = []
  let refreshShouldFail = false
  const fetchPort: FetchPort = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) })
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return jsonResponse(200, {
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      })
    }
    if (url === `${issuer}/token`) {
      const isRefresh = (init?.body ?? "").includes("refresh_token")
      if (isRefresh && refreshShouldFail) return jsonResponse(400, { error: "invalid_grant" })
      return jsonResponse(200, {
        access_token: isRefresh ? "ACCESS-REFRESHED" : "ACCESS-FIRST",
        refresh_token: "REFRESH-1",
        token_type: "Bearer",
        expires_in: 3600,
      })
    }
    return jsonResponse(404, {})
  }
  return {
    fetchPort,
    calls: () => calls,
    failRefresh: (v: boolean) => {
      refreshShouldFail = v
    },
  }
}

/** A fake in-memory token store satisfying the connectors port. */
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
  return { port, peek: (id: string) => map.get(id), size: () => map.size }
}

/** A fake clock the test advances to drive expiry. */
const fakeClock = (start = 1_000_000): ClockPort & { advance: (ms: number) => void } => {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

/** A fake browser flow: counts invocations, hands back a redeemable code. */
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

const ISSUER = "https://idp.example.com"

/** Construct a connectors-backed provider over a fresh fake IdP/store/clock/
 *  browser set, returning the provider plus its fakes for assertions. */
const buildProvider = () => {
  const idp = fakeIdp(ISSUER)
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
  return { provider, idp, store, browser, clock }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("mcp-oauth port — knob / default", () => {
  it("knob OFF ⇒ buildMcpOAuthWiring yields no provider (byte-identical)", () => {
    const wiring = buildMcpOAuthWiring(false, undefined)
    expect(wiring.provider).toBeUndefined()
  })

  it("knob ON but no deps ⇒ still no provider (advertise-iff-able)", () => {
    const wiring = buildMcpOAuthWiring(true, undefined)
    expect(wiring.provider).toBeUndefined()
  })

  it("headlessOAuthRejecter returns no token (the safe default)", async () => {
    const port: McpOAuthProviderPort = headlessOAuthRejecter
    expect(await port.tokenFor("any")).toBeUndefined()
  })
})

describe("mcp-oauth provider — discovery + PKCE authorize + store", () => {
  it("first tokenFor ⇒ discovery, browser flow, token stored, bearer returned", async () => {
    const { provider, idp, store, browser } = buildProvider()
    const token = await provider.tokenFor("srv")
    expect(token).toBe("ACCESS-FIRST")
    expect(browser.runs()).toBe(1)
    expect(idp.calls().some((c) => c.url.endsWith("/.well-known/oauth-authorization-server"))).toBe(
      true,
    )
    expect(store.peek("srv")?.accessToken).toBe("ACCESS-FIRST")
  })

  it("a stored unexpired token is reused (no second browser flow)", async () => {
    const { provider, browser } = buildProvider()
    await provider.tokenFor("srv")
    const second = await provider.tokenFor("srv")
    expect(second).toBe("ACCESS-FIRST")
    expect(browser.runs()).toBe(1)
  })
})

describe("mcp-oauth provider — expiry → refresh, refresh-fail → re-auth", () => {
  it("expired token ⇒ refresh (RFC 6749 §6), no new browser flow", async () => {
    const { provider, idp, browser, clock } = buildProvider()
    await provider.tokenFor("srv") // ACCESS-FIRST, expires in 3600s
    clock.advance(3_600_001)
    const refreshed = await provider.tokenFor("srv")
    expect(refreshed).toBe("ACCESS-REFRESHED")
    expect(browser.runs()).toBe(1) // refresh, NOT a new flow
    expect(
      idp.calls().some((c) => c.url.endsWith("/token") && c.body?.includes("refresh_token")),
    ).toBe(true)
  })

  it("refresh failure ⇒ re-auth via a fresh browser flow", async () => {
    const { provider, idp, browser, clock } = buildProvider()
    await provider.tokenFor("srv")
    clock.advance(3_600_001)
    idp.failRefresh(true) // server rejects the refresh_token grant
    const reauthed = await provider.tokenFor("srv")
    expect(reauthed).toBe("ACCESS-FIRST") // fresh auth-code grant minted a new token
    expect(browser.runs()).toBe(2)
  })

  it("invalidate() forces a fresh authorization on next tokenFor", async () => {
    const { provider, browser, store } = buildProvider()
    await provider.tokenFor("srv")
    await provider.invalidate("srv")
    await provider.tokenFor("srv")
    expect(browser.runs()).toBe(2)
    expect(store.size()).toBe(1)
  })
})

describe("mcp-oauth — concurrent acquisition coalesces (no double browser flow)", () => {
  it("two concurrent first tokenFor calls share ONE browser flow + one code redemption", async () => {
    // A browser flow that yields cooperatively so both concurrent `tokenFor`
    // calls are genuinely in-flight at once. Without coalescing each would pop
    // its own window and replay the single-use auth code.
    const idp = fakeIdp(ISSUER)
    const store = fakeStore()
    const clock = fakeClock()
    let runs = 0
    const provider = createConnectorsMcpOAuthProvider({
      fetchPort: idp.fetchPort,
      tokenStore: store.port,
      clockPort: clock,
      runBrowserFlow: async () => {
        runs += 1
        await new Promise((r) => setTimeout(r, 5))
        return { code: "AUTH-CODE", verifier: "VERIFIER", redirectUri: "http://localhost:1455/cb" }
      },
      clientId: "client-abc",
      issuerFor: () => ISSUER,
    })
    const [a, b] = await Promise.all([provider.tokenFor("srv"), provider.tokenFor("srv")])
    expect(a).toBe("ACCESS-FIRST")
    expect(b).toBe("ACCESS-FIRST")
    expect(runs).toBe(1) // coalesced — exactly one interactive flow
    // exactly one auth-code token exchange POST (not two replays of the code).
    const tokenPosts = idp
      .calls()
      .filter((c) => c.url.endsWith("/token") && c.body?.includes("authorization_code"))
    expect(tokenPosts).toHaveLength(1)
  })

  it("a fresh tokenFor after the first resolves is independent (in-flight cleared)", async () => {
    const { provider, browser } = buildProvider()
    await provider.tokenFor("srv") // resolves; in-flight entry cleared
    const second = await provider.tokenFor("srv") // unexpired ⇒ reused, no flow
    expect(second).toBe("ACCESS-FIRST")
    expect(browser.runs()).toBe(1)
  })
})

describe("mcp-oauth — clock skew (born-expired / boundary / refresh-loop)", () => {
  /** Build a provider whose IdP mints tokens with a configurable `expires_in`
   *  (so we can mint a token that is born-expired relative to the clock). Counts
   *  refresh-grant POSTs so a refresh LOOP would be observable. */
  const buildWithExpiresIn = (expiresIn: number) => {
    let refreshCount = 0
    const store = fakeStore()
    const clock = fakeClock()
    const browser = fakeBrowser()
    const fetchPort: FetchPort = async (url, init) => {
      if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
        return jsonResponse(200, {
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
        })
      }
      if (url === `${ISSUER}/token`) {
        const isRefresh = (init?.body ?? "").includes("refresh_token")
        if (isRefresh) refreshCount += 1
        return jsonResponse(200, {
          access_token: isRefresh ? "ACCESS-REFRESHED" : "ACCESS-FIRST",
          refresh_token: "REFRESH-1",
          token_type: "Bearer",
          expires_in: expiresIn,
        })
      }
      return jsonResponse(404, {})
    }
    const provider = createConnectorsMcpOAuthProvider({
      fetchPort,
      tokenStore: store.port,
      clockPort: clock,
      runBrowserFlow: browser.run,
      clientId: "client-abc",
      issuerFor: () => ISSUER,
    })
    return { provider, store, clock, browser, refreshCount: () => refreshCount }
  }

  it("expires_in=0 (token BORN expired) ⇒ next tokenFor refreshes EXACTLY once (no infinite loop)", async () => {
    const { provider, store, refreshCount } = buildWithExpiresIn(0)
    const first = await provider.tokenFor("srv") // browser flow → born-expired token
    expect(first).toBe("ACCESS-FIRST")
    // Stored with expiresAt === now (born expired).
    expect(store.peek("srv")?.expiresAt).toBeDefined()
    const second = await provider.tokenFor("srv") // expired → ONE refresh, not a loop
    expect(second).toBe("ACCESS-REFRESHED")
    expect(refreshCount()).toBe(1) // exactly one refresh GRANT per call — NO loop
  })

  it("negative expires_in (server clock skew) ⇒ stored expiresAt in the PAST, single refresh, no crash", async () => {
    const { provider, store, clock, refreshCount } = buildWithExpiresIn(-100)
    await provider.tokenFor("srv")
    const exp = store.peek("srv")?.expiresAt
    expect(exp).toBeDefined()
    expect(exp as number).toBeLessThan(clock.now()) // born in the past
    const second = await provider.tokenFor("srv")
    expect(second).toBe("ACCESS-REFRESHED")
    expect(refreshCount()).toBe(1)
  })

  it("token expiring EXACTLY at now (>= boundary) ⇒ treated as expired, refreshes", async () => {
    const { provider, store, clock, refreshCount } = buildWithExpiresIn(3600)
    await provider.tokenFor("srv")
    const exp = store.peek("srv")?.expiresAt as number
    clock.advance(exp - clock.now()) // now === expiresAt exactly
    const at = await provider.tokenFor("srv")
    expect(at).toBe("ACCESS-REFRESHED") // `now >= expiresAt` ⇒ expired at the boundary
    expect(refreshCount()).toBe(1)
  })
})

describe("mcp-oauth — tokens never leak", () => {
  it("provider toString / JSON never exposes the access token", async () => {
    const { provider } = buildProvider()
    await provider.tokenFor("srv")
    const serialized = `${String(provider)} ${JSON.stringify(provider)}`
    expect(serialized).not.toContain("ACCESS-FIRST")
    expect(serialized).not.toContain("REFRESH-1")
  })
})
