import { describe, expect, test } from "bun:test"
import {
  exchangeCode,
  type FetchLike,
  RefreshCoordinator,
  resolveOAuthConfig,
  type TokenRecord,
} from "@/auth/chatgpt-oauth"

/**
 * T07 hellgate — OAuth refresh validation (audit L6 H4) + RefreshCoordinator
 * in-flight retention (audit L6 M12).
 *
 * H4: empty `access_token` (→ spurious 401 at call time) and non-finite /
 *     non-positive `expires_in` (→ instantly-expired token) must be REJECTED
 *     at parse time, matching github-token-rotation / oidc-federation.
 * M12: a rejecting refresh must NOT delete its in-flight slot before settling,
 *      or a second caller arriving in the gap re-fires the issuer request and
 *      the first rejection is swallowed.
 */

const cfg = resolveOAuthConfig({})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const stubFetch =
  (body: unknown, status = 200): FetchLike =>
  async () =>
    jsonResponse(body, status)

const goodCode = {
  cfg,
  code: "c",
  verifier: "v",
  redirectUri: "http://localhost/cb",
}

describe("T07 OAuth refresh hellgate", () => {
  test("H4: empty access_token is rejected (not accepted as a usable token)", async () => {
    await expect(
      exchangeCode({
        ...goodCode,
        fetchImpl: stubFetch({ access_token: "", refresh_token: "r", expires_in: 3600 }),
      }),
    ).rejects.toThrow()
  })

  test("H4: negative expires_in is rejected (would be instantly expired)", async () => {
    await expect(
      exchangeCode({
        ...goodCode,
        fetchImpl: stubFetch({ access_token: "a", refresh_token: "r", expires_in: -5 }),
      }),
    ).rejects.toThrow()
  })

  test("H4: non-finite expires_in is rejected", async () => {
    await expect(
      exchangeCode({
        ...goodCode,
        fetchImpl: stubFetch({
          access_token: "a",
          refresh_token: "r",
          expires_in: Number.POSITIVE_INFINITY,
        }),
      }),
    ).rejects.toThrow()
  })

  test("H4: a valid token bundle still parses", async () => {
    const rec = await exchangeCode({
      ...goodCode,
      fetchImpl: stubFetch({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
      nowMs: () => 0,
    })
    expect(rec.access_token).toBe("a")
    expect(new Date(rec.expires_at).getTime()).toBe(3600 * 1000)
  })

  test("M12: a rejecting refresh shares ONE in-flight slot with a concurrent caller", async () => {
    const coord = new RefreshCoordinator()
    let calls = 0
    const failingFetch: FetchLike = async () => {
      calls += 1
      // Defer so the second caller arrives while the first is in-flight.
      await Promise.resolve()
      return jsonResponse({ error: "invalid_grant" }, 400)
    }
    const current: TokenRecord = {
      access_token: "old",
      refresh_token: "rt",
      expires_at: new Date(0).toISOString(),
    }
    const a = coord.refresh({ cfg, current, fetchImpl: failingFetch }).catch((e) => e)
    const b = coord.refresh({ cfg, current, fetchImpl: failingFetch }).catch((e) => e)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBeInstanceOf(Error)
    expect(rb).toBeInstanceOf(Error)
    // Both callers deduped onto a SINGLE issuer request (no thundering herd on
    // reject), and both observed the same rejection (no swallowed first error).
    expect(calls).toBe(1)
    expect(ra).toBe(rb)
  })

  test("M12: in-flight slot is freed after settle (no leak)", async () => {
    const coord = new RefreshCoordinator()
    const current: TokenRecord = {
      access_token: "old",
      refresh_token: "rt",
      expires_at: new Date(0).toISOString(),
    }
    await coord
      .refresh({ cfg, current, fetchImpl: stubFetch({ error: "invalid_grant" }, 400) })
      .catch(() => undefined)
    expect(coord.__sizeForTest()).toBe(0)
  })
})
