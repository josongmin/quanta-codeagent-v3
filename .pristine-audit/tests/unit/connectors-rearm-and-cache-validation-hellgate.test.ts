/**
 * ★ HELLGATE — connectors wave-2 (U8): two audited defects.
 *
 * (13) ASYNC_CORRECTNESS — token-refresh-scheduler stop()/cancel() could not
 *      prevent the post-success RE-ARM of an IN-FLIGHT refresh: a refresh
 *      running at stop() time scheduled a fresh timer after stop() returned, so
 *      a timer survived teardown (contradicting stop()'s "no leak" guarantee).
 *      FIX: stopped/cancelled flags checked inside the refresh body BEFORE the
 *      success/backoff re-arm. Proven here with a fake TimerPort that counts
 *      set() calls and a deferred refresh held open across stop()/cancel().
 *
 * (15) TYPE_SAFETY — rest-registry served a cached connector catalog via
 *      `as Connector[]` with NO per-entry validation (asymmetric vs the network
 *      path which validates). FIX: parseCached runs the SAME validation; a
 *      poisoned cache entry is treated as a MISS (so an outage surfaces) rather
 *      than flowing out as a "valid" Connector. Proven by a poisoned vs valid
 *      cache entry under a failing network.
 */
import { describe, expect, test } from "bun:test"
import { ConnectorOutageError, createRestConnectorRegistry } from "@/connectors/rest-registry"
import {
  createTokenRefreshScheduler,
  LEAD_MS,
  type TimerPort,
} from "@/connectors/token-refresh-scheduler"
import type { CachePort, FetchPort, TokenRecord } from "@/connectors/types"

// ─── (13) re-arm after stop()/cancel() ───────────────────────────────────────

/** Fake TimerPort: records every set() and lets the test fire the pending
 *  callback by hand. No real timers — fully deterministic. */
const makeFakeTimer = () => {
  const armed: Array<{ cb: () => void; delayMs: number; cleared: boolean }> = []
  const port: TimerPort = {
    set(cb, delayMs) {
      const entry = { cb, delayMs, cleared: false }
      armed.push(entry)
      return entry
    },
    clear(handle) {
      ;(handle as { cleared: boolean }).cleared = true
    },
  }
  return { port, armed }
}

const record = (expiresAt: number): TokenRecord => ({
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt,
  tokenType: "Bearer",
})

/** Build a scheduler whose rotator delegates straight to the refresh callback
 *  (no persistence/mutex needed for the re-arm test) and a fixed clock. */
const makeScheduler = (port: TimerPort, refresh: () => Promise<TokenRecord>) =>
  createTokenRefreshScheduler({
    timerPort: port,
    clockPort: { now: () => 0 },
    refresh,
    rotator: {
      read: async () => undefined,
      rotate: async (_id, refreshCb) => refreshCb(undefined),
      forget: async () => {},
      isExpired: () => false,
    },
  })

describe("(13) token-refresh stop()/cancel() blocks the in-flight re-arm", () => {
  test("stop() during an in-flight refresh prevents the post-success re-arm (no surviving timer)", async () => {
    const { port, armed } = makeFakeTimer()
    let release: (r: TokenRecord) => void = () => {}
    const refresh = () =>
      new Promise<TokenRecord>((resolve) => {
        release = resolve
      })
    const sched = makeScheduler(port, refresh)

    sched.schedule("c1", record(LEAD_MS + 10_000)) // arms timer #1
    expect(armed.length).toBe(1)

    armed[0]?.cb() // fire → refresh() is now in flight (deferred)
    sched.stop() // teardown WHILE the refresh is in flight
    release(record(LEAD_MS + 20_000)) // refresh resolves AFTER stop()
    await Promise.resolve()
    await Promise.resolve()

    // The success path must NOT have armed a new timer — stop() wins.
    expect(armed.length).toBe(1)
  })

  test("cancel(id) during an in-flight refresh prevents that id's re-arm; a re-schedule re-validates it", async () => {
    const { port, armed } = makeFakeTimer()
    let release: (r: TokenRecord) => void = () => {}
    const refresh = () => new Promise<TokenRecord>((resolve) => (release = resolve))
    const sched = makeScheduler(port, refresh)

    sched.schedule("c1", record(LEAD_MS + 10_000)) // timer #1
    armed[0]?.cb() // in-flight
    sched.cancel("c1") // cancel WHILE in flight
    release(record(LEAD_MS + 20_000))
    await Promise.resolve()
    await Promise.resolve()
    expect(armed.length).toBe(1) // no re-arm after cancel

    // A fresh schedule() re-validates the id (drops it from `cancelled`).
    sched.schedule("c1", record(LEAD_MS + 30_000))
    expect(armed.length).toBe(2)
  })
})

// ─── (15) poisoned cache is a miss, not a "valid" Connector ───────────────────

const clock = (t: number) => ({ now: () => t })
const failingFetch: FetchPort = async () => ({
  status: 503,
  ok: false,
  text: async () => "",
})
const cacheWith = (value: string, writtenAt: number): CachePort => ({
  read: async () => ({ value, writtenAt }),
  write: async () => {},
})

const VALID = JSON.stringify([
  {
    id: "gh",
    displayName: "GitHub",
    host: "api.github.com",
    auth: "oauth",
    oauthIssuer: "https://github.com",
  },
])
// Missing `id` and `host`, and `auth` outside the oauth|none union.
const POISONED = JSON.stringify([{ displayName: "Bad", auth: "totally-bogus" }])

describe("(15) rest-registry cache path validates entries (no `as Connector[]`)", () => {
  test("a FRESH but POISONED cache entry is dropped → outage surfaces (not a fake valid catalog)", async () => {
    const reg = createRestConnectorRegistry({
      fetchPort: failingFetch, // network down → must fall back to cache
      baseUrl: "https://reg.example.com",
      clockPort: clock(1_000_000),
      cachePort: cacheWith(POISONED, 1_000_000), // fresh (same instant)
    })
    // Poisoned cache treated as a MISS + network down ⇒ typed outage, NOT a
    // silently-surfaced malformed Connector.
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
  })

  test("a FRESH VALID cache entry is served as stale under the same failing network (control)", async () => {
    const reg = createRestConnectorRegistry({
      fetchPort: failingFetch,
      baseUrl: "https://reg.example.com",
      clockPort: clock(1_000_000),
      cachePort: cacheWith(VALID, 1_000_000),
    })
    const all = await reg.list()
    expect(all.map((c) => c.id)).toEqual(["gh"])
  })
})
