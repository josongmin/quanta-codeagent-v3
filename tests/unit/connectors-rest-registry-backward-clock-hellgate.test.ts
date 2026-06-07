/**
 * ★ HELLGATE — rest-registry cache TTL vs a BACKWARD clock step (wave-5 TIME_CLOCK).
 *
 * isFresh computed `clockPort.now() - writtenAt < ttl`. The only concrete
 * ClockPort adapter returns the WALL clock, so after a backward step (NTP
 * correction / manual set) `now < writtenAt` made the age NEGATIVE and thus
 * always `< ttl` → a stale catalog was frozen as "cached-fresh" and refresh()
 * skipped the network indefinitely until the clock caught back up. FIX
 * (fail-closed): treat a negative age as STALE so a backward clock forces a
 * refresh instead of serving a stale catalog past its TTL.
 */
import { describe, expect, test } from "bun:test"
import { createRestConnectorRegistry } from "@/connectors/rest-registry"
import type { CachePort, FetchPort } from "@/connectors/types"

const CATALOG = JSON.stringify([
  {
    id: "gh",
    displayName: "GitHub",
    host: "api.github.com",
    auth: "oauth",
    oauthIssuer: "https://github.com",
  },
])

const cacheWith = (value: string, writtenAt: number): CachePort => ({
  read: async () => ({ value, writtenAt }),
  write: async () => {},
})

/** A counting fetchPort that always returns the catalog. */
const countingFetch = (): { port: FetchPort; calls: () => number } => {
  let n = 0
  return {
    port: async () => {
      n++
      return { status: 200, ok: true, text: async () => CATALOG }
    },
    calls: () => n,
  }
}

describe("rest-registry TTL is fail-closed on a backward clock step", () => {
  test("a fresh cache entry serves WITHOUT a network fetch (control)", async () => {
    const fetcher = countingFetch()
    const reg = createRestConnectorRegistry({
      fetchPort: fetcher.port,
      baseUrl: "https://reg.example.com",
      clockPort: { now: () => 1_000_000 },
      cachePort: cacheWith(CATALOG, 1_000_000), // age 0 < ttl
      cacheTtlMs: 100_000,
    })
    const all = await reg.list()
    expect(all.map((c) => c.id)).toEqual(["gh"])
    expect(fetcher.calls()).toBe(0) // cached-fresh, no network
  })

  test("a BACKWARD clock step (now < writtenAt) forces a refresh (no frozen-stale)", async () => {
    const fetcher = countingFetch()
    // Clock has stepped BACK to 900_000 but the cache entry was written at
    // 1_000_000 (in the "future"). age = 900_000 - 1_000_000 = -100_000.
    const reg = createRestConnectorRegistry({
      fetchPort: fetcher.port,
      baseUrl: "https://reg.example.com",
      clockPort: { now: () => 900_000 },
      cachePort: cacheWith(CATALOG, 1_000_000),
      cacheTtlMs: 100_000,
    })
    const all = await reg.list()
    expect(all.map((c) => c.id)).toEqual(["gh"])
    // The negative age must NOT read as fresh — a network refresh is performed
    // rather than freezing the stale catalog until the clock catches up.
    expect(fetcher.calls()).toBeGreaterThanOrEqual(1)
  })
})
