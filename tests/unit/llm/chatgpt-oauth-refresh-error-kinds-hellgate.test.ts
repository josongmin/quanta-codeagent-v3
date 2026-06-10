/** Jun-10 silent-failure audit #15 — error-kind routing at the chatgpt-oauth
 *  token-REFRESH boundary (`ensureFreshToken`'s catch).
 *
 *  Checklist rule under test (audit §"Error-kind routing at auth/token
 *  boundaries"): any catch assigning an LLMError `kind` must branch on the
 *  TYPED statusCode; `invalid_grant`/401 is the ONLY re-auth ("run /login")
 *  trigger. Before the fix, EVERY refresh failure (429/5xx/network/disk) was
 *  re-classified `kind:"auth"` = FATAL + non-fallback, so a transient blip at
 *  the refresh boundary killed the turn with a false "run /login".
 *
 *  Table-driven per status, asserting the REAL observable effect (the typed
 *  LLMError thrown out of `stream()`):
 *    - 401            → auth        (re-auth trigger, "/login" advice)
 *    - invalid_grant  → auth        (explicit revocation, "/login" advice)
 *    - 429            → rate_limit  (+ retryAfterMs preserved from headers)
 *    - 503            → server_error (transient — retry policy routes it)
 *    - network throw  → network     (transient)
 *  Paired control: the two auth rows already passed pre-fix; the transient
 *  rows were RED against the unfixed catch (everything mapped to "auth").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  __resetInflightForTest,
  chatgptTokenPath,
  type FetchLike,
  TokenExchangeError,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { __resetCatalogCacheForTest, ChatGPTOAuthAdapter } from "@/llm/adapters/chatgpt-oauth"
import type { StreamInput } from "@/llm/types"
import { LLMError } from "@/shared"

const FIXED_NOW = Date.parse("2026-06-10T12:00:00.000Z")
/** Already expired ⇒ `stream()` MUST refresh before the wire call. */
const pastExpiry = new Date(FIXED_NOW - 1_000).toISOString()

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cgo-refresh-kinds-"))
  __resetCatalogCacheForTest()
  __resetInflightForTest()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const streamInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})

/** Seed an EXPIRED quanta token so the adapter is forced through the refresh
 *  path. Distinct refresh_token per row so the module-level refresh
 *  coordinator never dedups across rows. */
const seedExpiredToken = async (refreshToken: string): Promise<void> => {
  await writeToken(chatgptTokenPath(dir), {
    access_token: "at-stale",
    refresh_token: refreshToken,
    expires_at: pastExpiry,
    account_id: "acct-1",
    plan_type: "pro",
  })
}

/** Run `stream()` against a fetch stub and capture the thrown error. The
 *  token-endpoint failure happens BEFORE any /models or /responses call, so
 *  no other handler is needed. */
const streamAndCatch = async (fetchImpl: FetchLike): Promise<unknown> => {
  const a = new ChatGPTOAuthAdapter({
    model: "gpt-5",
    env: { QUANTA_PREFS_HOME: dir },
    fetchImpl,
    nowMs: () => FIXED_NOW,
  })
  let caught: unknown
  try {
    for await (const _ of a.stream(streamInput())) void _
  } catch (e) {
    caught = e
  }
  return caught
}

/** Walk the `cause` chain looking for the typed boundary error. A 401 refresh
 *  failure is re-wrapped ONCE more by `stream()`'s designed token-purge path
 *  (LLMError → LLMError → TokenExchangeError), so one level is not enough. */
const findInCauseChain = <T>(e: unknown, ctor: new (...args: never[]) => T): T | undefined => {
  let cur: unknown = e
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i += 1) {
    if (cur instanceof ctor) return cur
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

const tokenEndpointFailure =
  (status: number, body: unknown, headers?: Record<string, string>): FetchLike =>
  async (url) => {
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      })
    }
    throw new Error(`unexpected fetch URL (refresh must fail first): ${url}`)
  }

describe("chatgpt-oauth refresh catch branches on typed statusCode — invalid_grant/401 is the only re-auth trigger (#15)", () => {
  const httpRows: readonly {
    readonly name: string
    readonly status: number
    readonly body: unknown
    readonly headers?: Record<string, string>
    readonly kind: string
    readonly loginAdvice: boolean
    readonly retryAfterMs?: number
  }[] = [
    {
      name: "401 → kind auth (re-auth trigger, /login advice) [paired control]",
      status: 401,
      body: { error: "invalid_token" },
      kind: "auth",
      loginAdvice: true,
    },
    {
      name: "400 invalid_grant → kind auth (explicit revocation) [paired control]",
      status: 400,
      body: { error: "invalid_grant", error_description: "refresh token revoked" },
      kind: "auth",
      loginAdvice: true,
    },
    {
      name: "429 → kind rate_limit, retryAfterMs preserved from retry-after header",
      status: 429,
      body: { error: "rate_limited" },
      headers: { "retry-after": "7" },
      kind: "rate_limit",
      loginAdvice: false,
      retryAfterMs: 7_000,
    },
    {
      name: "503 → kind server_error (transient — NOT a false 'run /login')",
      status: 503,
      body: { error: "upstream_down" },
      kind: "server_error",
      loginAdvice: false,
    },
  ]

  for (const row of httpRows) {
    test(row.name, async () => {
      await seedExpiredToken(`rt-${row.status}-${row.kind}`)
      const caught = await streamAndCatch(tokenEndpointFailure(row.status, row.body, row.headers))

      expect(caught).toBeInstanceOf(LLMError)
      const err = caught as LLMError
      expect(err.kind).toBe(row.kind as LLMError["kind"])
      // Typed statusCode survives the boundary (the checklist's whole point).
      expect(err.statusCode).toBe(row.status)
      expect(err.provider).toBe("chatgpt-oauth")
      // Cause chain preserved: the typed TokenExchangeError is reachable.
      const typedCause = findInCauseChain(err, TokenExchangeError)
      expect(typedCause).toBeInstanceOf(TokenExchangeError)
      expect(typedCause?.statusCode).toBe(row.status)
      // "/login" advice ONLY on the genuine re-auth triggers.
      if (row.loginAdvice) {
        expect(err.message).toContain("/login")
      } else {
        expect(err.message).not.toContain("/login")
      }
      if (row.retryAfterMs !== undefined) {
        expect(err.retryAfterMs).toBe(row.retryAfterMs)
      }
    })
  }

  test("network throw at the token endpoint → kind network (transient), cause preserved", async () => {
    await seedExpiredToken("rt-network")
    const netErr = new TypeError("fetch failed: ECONNRESET")
    const caught = await streamAndCatch(async (url) => {
      if (url.includes("/oauth/token")) throw netErr
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("network")
    expect(err.statusCode).toBeUndefined()
    expect(err.cause).toBe(netErr)
    expect(err.message).not.toContain("/login")
  })
})

/** Does the on-disk quanta token still exist? Used to observe the purge. */
const tokenStillOnDisk = async (): Promise<boolean> => {
  try {
    await access(chatgptTokenPath(dir))
    return true
  } catch {
    return false
  }
}

/** D6 — purge predicate MUST agree with the classifier. `classifyRefreshFailure`
 *  calls a 400 `invalid_grant` (RFC 6749 §5.2: refresh token revoked) `kind:"auth"`,
 *  but the pre-fix purge predicate (`is401AuthError`) only fired on statusCode 401,
 *  so the dead bundle survived on disk and re-refreshed a revoked token on every
 *  subsequent call until the user manually `/login`s. After the fix the revoked
 *  bundle is deleted AND the user is advised to `/login`. Paired controls
 *  (429/503/network) MUST NOT purge — there is nothing wrong with the bundle. */
describe("chatgpt-oauth refresh: revoked-grant purge predicate agrees with the classifier (D6)", () => {
  test("400 invalid_grant with a quanta-sourced on-disk token ⇒ token purged + /login advice", async () => {
    await seedExpiredToken("rt-d6-invalid-grant")
    expect(await tokenStillOnDisk()).toBe(true)

    const caught = await streamAndCatch(
      tokenEndpointFailure(400, {
        error: "invalid_grant",
        error_description: "refresh token revoked",
      }),
    )

    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("auth")
    expect(err.message).toContain("/login")
    // The real observable effect of the predicate broadening: the dead bundle
    // is gone, so the next call won't re-refresh a revoked token in a loop.
    expect(await tokenStillOnDisk()).toBe(false)
  })

  const noPurgeRows: readonly {
    readonly name: string
    readonly status: number
    readonly body: unknown
    readonly headers?: Record<string, string>
  }[] = [
    {
      name: "429 rate-limited",
      status: 429,
      body: { error: "rate_limited" },
      headers: { "retry-after": "7" },
    },
    { name: "503 upstream down", status: 503, body: { error: "upstream_down" } },
  ]
  for (const row of noPurgeRows) {
    test(`paired control: ${row.name} ⇒ token NOT purged (transient, bundle is fine)`, async () => {
      await seedExpiredToken(`rt-d6-nopurge-${row.status}`)
      const caught = await streamAndCatch(tokenEndpointFailure(row.status, row.body, row.headers))
      expect(caught).toBeInstanceOf(LLMError)
      expect((caught as LLMError).message).not.toContain("/login")
      expect(await tokenStillOnDisk()).toBe(true)
    })
  }

  test("paired control: network throw ⇒ token NOT purged", async () => {
    await seedExpiredToken("rt-d6-nopurge-network")
    const caught = await streamAndCatch(async (url) => {
      if (url.includes("/oauth/token")) throw new TypeError("fetch failed: ECONNRESET")
      throw new Error(`unexpected fetch URL: ${url}`)
    })
    expect(caught).toBeInstanceOf(LLMError)
    expect((caught as LLMError).message).not.toContain("/login")
    expect(await tokenStillOnDisk()).toBe(true)
  })
})

/** A successful refresh response body for the token endpoint. */
const refreshSuccessBody = {
  access_token: "at-fresh",
  refresh_token: "rt-rotated",
  expires_in: 3600,
}

/** Stub that succeeds on /oauth/token (counting hits) and lets the caller
 *  observe the next leg. After a SUCCESSFUL refresh `stream()` proceeds to
 *  /codex/models; we fail there with a sentinel so the test terminates without
 *  needing a full SSE body, while still proving the in-memory token was USED
 *  (the buggy path threw at `ensureFreshToken` and never reached /models). */
const refreshSucceedsThenModelsSentinel = (
  counters: { tokenHits: number; modelsHit: boolean },
): FetchLike => {
  return async (url) => {
    if (url.includes("/oauth/token")) {
      counters.tokenHits += 1
      return new Response(JSON.stringify(refreshSuccessBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("/models")) {
      counters.modelsHit = true
      // Sentinel: terminate the stream past ensureFreshToken cleanly.
      return new Response(JSON.stringify({ error: "models-sentinel" }), {
        status: 418,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch URL: ${url}`)
  }
}

/** D7 — a disk-persist failure on an OTHERWISE-SUCCESSFUL refresh must NOT
 *  discard the valid in-memory token. The pre-fix catch wrapped the EACCES from
 *  `writeToken` as `kind:"network"` (retryable), so the in-flight call threw and
 *  the retry layer re-ran the FULL refresh ×maxRetries, burning the issuer
 *  budget and tossing a perfectly good access token. The fix returns the
 *  in-memory token (the disk copy is a cache, not load-bearing) with a logged
 *  warning, so the call proceeds on ONE refresh. */
describe("chatgpt-oauth refresh: disk-persist failure keeps the fresh in-memory token (D7)", () => {
  test("/token SUCCEEDS but writeToken throws EACCES ⇒ in-memory token used, no re-fetch", async () => {
    await seedExpiredToken("rt-d7-persist-fail")
    const authDir = dirname(chatgptTokenPath(dir))
    // Make the post-refresh writeToken (write-to-tmp + rename) fail EACCES.
    await chmod(authDir, 0o500)
    try {
      const counters = { tokenHits: 0, modelsHit: false }
      const caught = await streamAndCatch(refreshSucceedsThenModelsSentinel(counters))

      // The refresh ran exactly once — the in-memory token carried the call
      // forward instead of being discarded + re-fetched.
      expect(counters.tokenHits).toBe(1)
      // Proof the fresh token was USED: stream() advanced to /codex/models.
      // (Pre-fix this was never reached — ensureFreshToken threw "network".)
      expect(counters.modelsHit).toBe(true)
      // The error the test sees is the /models sentinel, NOT a refresh failure.
      expect(caught).toBeInstanceOf(LLMError)
      expect((caught as LLMError).message).not.toContain("token refresh failed")
    } finally {
      await chmod(authDir, 0o700)
    }
  })
})

/** D8 — a 403 from the token endpoint (e.g. account suspended / scope revoked,
 *  non-`invalid_grant`) is an auth problem, not the catch-all `unknown`. Pre-fix
 *  it fell through to `kind:"unknown"` ⇒ no `/login` advice + no purge. The fix
 *  classifies 403 as `kind:"auth"` before the unknown fallthrough. */
describe("chatgpt-oauth refresh: 403 classified as auth, not unknown (D8)", () => {
  test("403 (non-invalid_grant body) ⇒ kind auth + /login advice", async () => {
    await seedExpiredToken("rt-d8-403")
    const caught = await streamAndCatch(tokenEndpointFailure(403, { error: "access_denied" }))
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("auth")
    expect(err.statusCode).toBe(403)
    expect(err.message).toContain("/login")
  })

  test("paired control: 403 body invalid_grant still hits the errorCode branch (kind auth)", async () => {
    await seedExpiredToken("rt-d8-403-invalid-grant")
    const caught = await streamAndCatch(
      tokenEndpointFailure(403, { error: "invalid_grant", error_description: "revoked" }),
    )
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("auth")
    expect(err.message).toContain("/login")
  })
})
