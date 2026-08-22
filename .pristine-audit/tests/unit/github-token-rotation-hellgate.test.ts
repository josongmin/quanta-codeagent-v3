/**
 * ★ CONTRACT — ADR-0163 §github-token-rotation:
 *   - rotateGitHubToken IS pure-by-call (no instance state).
 *   - Lock-protected: holderId scopes a lock keyed by userId; release in
 *     finally so HTTP throws never strand the lock.
 *   - Threshold logic: rotate IFF remainingMs <= rotateAfterMs (else
 *     not-needed).
 *   - HTTP 4xx → refresh-rejected; HTTP 5xx → refresh-transient.
 *   - Missing access_token / expires_in → refresh-malformed.
 *   - New refresh_token preferred over current; absent → keep current
 *     (GitHub docs).
 *   - expiresAt = clock.now() + expires_in*1000 (vendor TTL, no amplifier).
 *   - holderId / userId / clientId / clientSecret empty → throws (programmer
 *     bug, no silent default).
 *   - Lock returns would-wait / would-acquire → skipped-locked;
 *     redis-error → skipped-lock-error.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_GITHUB_ENDPOINT_BASE,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_ROTATE_AFTER_MS,
  type GitHubTokenPair,
  rotateGitHubToken,
} from "@/auth/github-token-rotation"
import { InMemoryLock } from "@/auth/lock-in-memory"
import { RedisLockStub } from "@/auth/lock-redis-stub"
import type { OAuthRefreshLockPort } from "@/auth/oauth-refresh-lock"
import type { ClockPort, HttpClientPort } from "@/llm/oidc-federation"

const mkClock = (t: number): ClockPort => ({ now: () => t })

const mkHttp = (
  status: number,
  body: unknown,
  onCall?: (url: string, body: unknown) => void,
): HttpClientPort => ({
  post: async (url, b, _h) => {
    onCall?.(url, b)
    return { status, body }
  },
})

const mkHttpThrow = (err: Error): HttpClientPort => ({
  post: async () => {
    throw err
  },
})

const mkPair = (overrides: Partial<GitHubTokenPair> = {}): GitHubTokenPair => ({
  accessToken: "ghu_currentAccessToken_AAA",
  refreshToken: "ghr_currentRefreshToken_BBB",
  expiresAt: 1_000_000 + 60 * 60 * 1000, // 1h remaining at clock=1_000_000
  userId: "user-123",
  ...overrides,
})

const lockNever: OAuthRefreshLockPort = {
  tryAcquire: async () => "acquired",
  release: async () => {},
}

describe("rotateGitHubToken — hellgate", () => {
  test("HELL-G1: token with > rotateAfterMs life → not-needed", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 7 * 60 * 60 * 1000 }), // 7h remaining
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, {}),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("not-needed")
  })

  test("HELL-G2: token below threshold → rotate + new pair", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }), // 1 min remaining
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, {
        access_token: "ghu_NEW",
        refresh_token: "ghr_NEW",
        expires_in: 28800, // 8h
      }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("rotated")
    if (result.kind === "rotated") {
      expect(result.next.accessToken).toBe("ghu_NEW")
      expect(result.next.refreshToken).toBe("ghr_NEW")
      expect(result.next.expiresAt).toBe(1_000_000 + 28800 * 1000)
      expect(result.next.userId).toBe("user-123")
    }
  })

  test("HELL-G3: refresh_token absent in response → keep current refresh token", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, {
        access_token: "ghu_NEW",
        expires_in: 3600,
        // no refresh_token
      }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("rotated")
    if (result.kind === "rotated") {
      expect(result.next.refreshToken).toBe("ghr_currentRefreshToken_BBB") // unchanged
    }
  })

  test("HELL-G4: HTTP 401 (refresh token revoked) → refresh-rejected", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(401, { error: "bad_refresh_token" }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-rejected")
    if (result.kind === "refresh-rejected") {
      expect(result.httpStatus).toBe(401)
    }
  })

  test("HELL-G5: HTTP 503 → refresh-transient (retry permitted)", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(503, {}),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-transient")
    if (result.kind === "refresh-transient") {
      expect(result.httpStatus).toBe(503)
    }
  })

  test("HELL-G6: HTTP throw (network error) → refresh-transient with cause", async () => {
    const cause = new Error("ECONNREFUSED")
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttpThrow(cause),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-transient")
    if (result.kind === "refresh-transient") {
      expect(result.cause).toBe(cause)
    }
  })

  test("HELL-G7: response without access_token → refresh-malformed", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { expires_in: 3600 }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-malformed")
  })

  test("HELL-G8: response without expires_in → refresh-malformed", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { access_token: "x" }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-malformed")
  })

  test("HELL-G9: lock would-wait → skipped-locked (no refresh attempted)", async () => {
    const clock = mkClock(1_000_000)
    const lock = new InMemoryLock(clock)
    // Pre-acquire as someone else.
    await lock.tryAcquire("gh-token-rotation:user-123", "other-holder", 60_000)

    let httpCalls = 0
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { access_token: "x", expires_in: 3600 }, () => {
        httpCalls++
      }),
      clockPort: clock,
      lockPort: lock,
      holderId: "us",
    })
    expect(result.kind).toBe("skipped-locked")
    expect(httpCalls).toBe(0) // Never went to wire.
  })

  test("HELL-G10: lock redis-error → skipped-lock-error", async () => {
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { access_token: "x", expires_in: 3600 }),
      clockPort: mkClock(1_000_000),
      lockPort: new RedisLockStub(),
      holderId: "h1",
    })
    expect(result.kind).toBe("skipped-lock-error")
  })

  test("HELL-G11: lock RELEASED in finally even when HTTP throws (no strand)", async () => {
    const clock = mkClock(1_000_000)
    const lock = new InMemoryLock(clock)
    const cause = new Error("network blown")
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttpThrow(cause),
      clockPort: clock,
      lockPort: lock,
      holderId: "h1",
    })
    expect(result.kind).toBe("refresh-transient")
    // Lock should be free — verify by acquiring as a different holder.
    expect(await lock.tryAcquire("gh-token-rotation:user-123", "different-holder", 1000)).toBe(
      "acquired",
    )
  })

  test("HELL-G12: empty holderId throws", async () => {
    await expect(
      rotateGitHubToken({
        current: mkPair(),
        clientId: "ci",
        clientSecret: "cs",
        httpPort: mkHttp(200, {}),
        clockPort: mkClock(1000),
        lockPort: lockNever,
        holderId: "",
      }),
    ).rejects.toThrow(/holderId/)
  })

  test("HELL-G13: empty userId throws (lock key would be ambiguous)", async () => {
    await expect(
      rotateGitHubToken({
        current: mkPair({ userId: "" }),
        clientId: "ci",
        clientSecret: "cs",
        httpPort: mkHttp(200, {}),
        clockPort: mkClock(1000),
        lockPort: lockNever,
        holderId: "h1",
      }),
    ).rejects.toThrow(/userId/)
  })

  test("HELL-G14: empty clientId / clientSecret throws", async () => {
    await expect(
      rotateGitHubToken({
        current: mkPair(),
        clientId: "",
        clientSecret: "cs",
        httpPort: mkHttp(200, {}),
        clockPort: mkClock(1000),
        lockPort: lockNever,
        holderId: "h1",
      }),
    ).rejects.toThrow(/clientId/)
  })

  test("HELL-G15: defaults documented & stable (DEFAULT_*)", () => {
    expect(DEFAULT_ROTATE_AFTER_MS).toBe(6 * 60 * 60 * 1000)
    expect(DEFAULT_LOCK_TTL_MS).toBe(30 * 1000)
    expect(DEFAULT_GITHUB_ENDPOINT_BASE).toBe("https://github.com")
  })

  test("HELL-G16: custom endpointBase respected (test/staging GH)", async () => {
    let calledUrl = ""
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { access_token: "x", expires_in: 60 }, (url) => {
        calledUrl = url
      }),
      clockPort: mkClock(1_000_000),
      lockPort: lockNever,
      holderId: "h1",
      endpointBase: "https://github.example.com",
    })
    expect(result.kind).toBe("rotated")
    expect(calledUrl).toBe("https://github.example.com/login/oauth/access_token")
  })

  test("HELL-G17: clock skew during refresh — expiresAt uses post-call clock", async () => {
    let callCount = 0
    let t = 1_000_000
    const clock: ClockPort = {
      now: () => {
        callCount++
        // First call (threshold check) = 1_000_000
        // Second call (post-HTTP) = 1_000_010 (10ms later)
        if (callCount > 1) t = 1_000_010
        return t
      },
    }
    const result = await rotateGitHubToken({
      current: mkPair({ expiresAt: 1_000_000 + 60 * 1000 }),
      clientId: "ci",
      clientSecret: "cs",
      httpPort: mkHttp(200, { access_token: "x", expires_in: 100 }),
      clockPort: clock,
      lockPort: lockNever,
      holderId: "h1",
    })
    expect(result.kind).toBe("rotated")
    if (result.kind === "rotated") {
      expect(result.next.expiresAt).toBe(1_000_010 + 100 * 1000)
    }
  })

  test("HELL-G18: 401 RACE — wrong-holder concurrent rotate is no-op (lock prevents)", async () => {
    const clock = mkClock(1_000_000)
    const lock = new InMemoryLock(clock)
    const current = mkPair({ expiresAt: 1_000_000 + 60 * 1000 })
    let httpCalls = 0
    const httpPort = mkHttp(
      200,
      {
        access_token: "ghu_NEW",
        expires_in: 28800,
      },
      () => {
        httpCalls++
      },
    )
    // Two simultaneous rotates with different holderIds.
    const [r1, r2] = await Promise.all([
      rotateGitHubToken({
        current,
        clientId: "ci",
        clientSecret: "cs",
        httpPort,
        clockPort: clock,
        lockPort: lock,
        holderId: "h1",
      }),
      rotateGitHubToken({
        current,
        clientId: "ci",
        clientSecret: "cs",
        httpPort,
        clockPort: clock,
        lockPort: lock,
        holderId: "h2",
      }),
    ])
    const kinds = [r1.kind, r2.kind].sort()
    expect(kinds).toEqual(["rotated", "skipped-locked"])
    expect(httpCalls).toBe(1) // Only the holder that won the lock called wire.
  })
})
