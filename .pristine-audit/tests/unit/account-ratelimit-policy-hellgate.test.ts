import { describe, expect, test } from "bun:test"
import {
  createRateLimitSnapshotStore,
  proactiveDelayMs,
  type RateLimitNotice,
  type RateLimitSnapshot,
  snapshotToNotice,
} from "@/llm/ratelimit-snapshot"

/**
 * jun-6 account-ratelimit snapshot — POLICY + STORE + NOTIFY hellgate.
 *
 * The policy is SERVER-ANCHORED: it backs off ONLY when the provider's OWN
 * `remaining <= 0`, then waits the provider's OWN reset (the same quantity B3
 * honors AFTER a 429, consulted BEFORE the request). It NEVER invents a
 * percentage/margin threshold. Delay clamps to the SAME 60s ceiling B3 uses.
 */

const snap = (p: Partial<RateLimitSnapshot>): RateLimitSnapshot => ({
  observedAt: 0,
  ...p,
})

describe("proactiveDelayMs — empty-bucket only (no invented margin)", () => {
  test("tokens empty (0) ⇒ wait the server reset", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 0, tokensResetMs: 5_000 }))).toBe(5_000)
  })

  test("requests empty (0) ⇒ wait the server reset", () => {
    expect(proactiveDelayMs(snap({ requestsRemaining: 0, requestsResetMs: 3_000 }))).toBe(3_000)
  })

  test("NOT empty (remaining 500) ⇒ 0 (NO guessed-margin backoff)", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 500, tokensResetMs: 5_000 }))).toBe(0)
  })

  test("plenty of headroom ⇒ 0 (policy never fabricates a delay)", () => {
    expect(
      proactiveDelayMs(
        snap({ tokensRemaining: 9_000, requestsRemaining: 50, tokensResetMs: 30_000 }),
      ),
    ).toBe(0)
  })

  test("empty but reset UNKNOWN ⇒ 0 (no number to wait, fall back to reactive)", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 0 }))).toBe(0)
  })

  test("empty with hostile huge reset ⇒ clamped to the B3 60s ceiling", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 0, tokensResetMs: 1e15 }))).toBe(60_000)
  })

  test("tightest binding window wins (min of the two empty windows)", () => {
    expect(
      proactiveDelayMs(
        snap({
          tokensRemaining: 0,
          tokensResetMs: 8_000,
          requestsRemaining: 0,
          requestsResetMs: 2_000,
        }),
      ),
    ).toBe(2_000)
  })

  test("only the EMPTY window's reset is consulted (non-empty window ignored)", () => {
    // tokens empty (reset 9s) but requests has headroom (reset 1s) — the 1s
    // reset must NOT shorten the wait, because requests is not the binding cap.
    expect(
      proactiveDelayMs(
        snap({
          tokensRemaining: 0,
          tokensResetMs: 9_000,
          requestsRemaining: 100,
          requestsResetMs: 1_000,
        }),
      ),
    ).toBe(9_000)
  })

  test("negative reset never produces a negative delay", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 0, tokensResetMs: -500 }))).toBe(0)
  })
})

describe("createRateLimitSnapshotStore — last-write-wins, undefined is no-op", () => {
  test("update(A); update(undefined); current() === A", () => {
    const store = createRateLimitSnapshotStore()
    const a = snap({ tokensRemaining: 10, observedAt: 1 })
    store.update(a)
    store.update(undefined)
    expect(store.current()).toBe(a)
  })

  test("a fresh store has no current snapshot", () => {
    expect(createRateLimitSnapshotStore().current()).toBeUndefined()
  })

  test("a later defined snapshot overwrites the earlier one", () => {
    const store = createRateLimitSnapshotStore()
    const a = snap({ tokensRemaining: 10, observedAt: 1 })
    const b = snap({ tokensRemaining: 2, observedAt: 2 })
    store.update(a)
    store.update(b)
    expect(store.current()).toBe(b)
  })
})

describe("snapshotToNotice — no-leak: numbers + reset only, never a header VALUE", () => {
  test("notice carries only quantities (presence/quantity, no secret strings)", () => {
    const notice: RateLimitNotice = snapshotToNotice(
      snap({
        tokensRemaining: 0,
        tokensResetMs: 5_000,
        requestsRemaining: 3,
        requestsResetMs: 10_000,
        observedAt: 42,
      }),
    )
    expect(notice.tokensRemaining).toBe(0)
    expect(notice.tokensResetMs).toBe(5_000)
    expect(notice.requestsRemaining).toBe(3)
    // Every field EXCEPT the constant `type` tag is a number / undefined — no
    // string that could smuggle an org-id header VALUE.
    for (const [k, v] of Object.entries(notice)) {
      if (k === "type") continue
      expect(v === undefined || typeof v === "number").toBe(true)
    }
  })

  test("notice type tag is the only string field", () => {
    const notice = snapshotToNotice(snap({ tokensRemaining: 0, observedAt: 1 }))
    expect(notice.type).toBe("ratelimit_snapshot")
  })
})

describe("proactiveDelayMs — fuzz: a hostile snapshot never drives an absurd delay", () => {
  // Even if a snapshot somehow carried out-of-band numbers (e.g. a future store
  // wired before the parser, or a direct construction), the POLICY must still
  // return a finite, non-negative, clamped delay — never NaN / negative / > cap.
  const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // Draw from a hostile numeric set incl. the absurd / signed-zero / non-finite edge.
  const HOSTILE = [
    0,
    -0,
    1,
    -1,
    500,
    -500,
    5_000,
    60_000,
    60_001,
    1e15,
    1e308,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER,
  ]

  test("8000 hostile snapshots ⇒ delay always finite, in [0, 60000]", () => {
    const rng = mulberry32(0xbadbeef)
    const pick = () => HOSTILE[Math.floor(rng() * HOSTILE.length)] as number
    let iterations = 0
    for (let i = 0; i < 8_000; i++) {
      iterations++
      const d = proactiveDelayMs(
        snap({
          tokensRemaining: pick(),
          tokensResetMs: pick(),
          requestsRemaining: pick(),
          requestsResetMs: pick(),
        }),
      )
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(60_000)
      expect(Number.isNaN(d)).toBe(false)
    }
    expect(iterations).toBe(8_000)
  })

  test("empty bucket with a NaN reset ⇒ 0 (not NaN)", () => {
    expect(proactiveDelayMs(snap({ tokensRemaining: 0, tokensResetMs: Number.NaN }))).toBe(0)
  })

  test("empty bucket with +Infinity reset ⇒ 0 (not Infinity)", () => {
    expect(
      proactiveDelayMs(snap({ tokensRemaining: 0, tokensResetMs: Number.POSITIVE_INFINITY })),
    ).toBe(0)
  })
})
