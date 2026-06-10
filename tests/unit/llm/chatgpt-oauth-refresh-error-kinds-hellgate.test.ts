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
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
