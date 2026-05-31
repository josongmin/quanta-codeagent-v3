/**
 * Connectors REST registry — hellgate (ADR-0160 Phase B).
 *
 * Seals 12 adversarial cases for the REST connector registry adapter:
 *   1.  happy: 200 + valid array → fresh, list contains entries
 *   2.  cached-fresh: second call within TTL skips HTTP
 *   3.  cached-fresh ttl boundary: at TTL-1ms still fresh, at TTL still fetches
 *   4.  cached-degraded: 5xx after stale cache present
 *   5.  cached-degraded with no cache: refresh returns cached-degraded, list returns []
 *   6.  malformed JSON → degraded fallback to stale
 *   7.  array shape: response not array → degraded (refresh dedicated)
 *   8.  entry shape: missing required field → degraded
 *   9.  invalid auth arm: auth=foo → degraded
 *   10. in-flight refresh dedupe: concurrent refresh calls share ONE fetch
 *   11. get() returns undefined for missing id
 *   12. cacheTtlMs validation: <=0 throws at construction
 */

import { describe, expect, test } from "bun:test"
import type {
  CacheEntry,
  CachePort,
  ClockPort,
  Connector,
  FetchPort,
  FetchPortResponse,
} from "@/connectors"
import { createRestConnectorRegistry } from "@/connectors"
import { ConnectorOutageError } from "@/connectors/rest-registry"

interface FakeFetchScript {
  readonly status: number
  readonly body: string
  readonly throws?: boolean
}

const makeFakeFetch = (scripts: FakeFetchScript[]): { fetchPort: FetchPort; calls: number } => {
  const state = { calls: 0 }
  const fetchPort: FetchPort = async (_url, _init) => {
    const idx = state.calls
    state.calls += 1
    const next = scripts[idx]
    if (next === undefined) throw new Error(`unexpected fetch #${idx}`)
    if (next.throws === true) throw new Error("network down")
    const res: FetchPortResponse = {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => next.body,
    }
    return res
  }
  return {
    fetchPort,
    get calls() {
      return state.calls
    },
  } as { fetchPort: FetchPort; calls: number }
}

const makeFakeClock = (start = 0): ClockPort & { advance(ms: number): void } => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const makeFakeCache = (): CachePort & { readonly store: Map<string, CacheEntry> } => {
  const store = new Map<string, CacheEntry>()
  return {
    store,
    read: async (k) => store.get(k),
    write: async (k, e) => {
      store.set(k, e)
    },
  }
}

const sampleBody = (entries: Connector[]): string => JSON.stringify(entries)
const sampleConn: Connector = {
  id: "github",
  displayName: "GitHub",
  host: "api.github.com",
  auth: "oauth",
  oauthIssuer: "https://github.com",
}

describe("connector-registry-rest-hellgate", () => {
  test("HELL-1: happy path 200 → fresh", async () => {
    const fake = makeFakeFetch([{ status: 200, body: sampleBody([sampleConn]) }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("fresh")
    const list = await reg.list()
    expect(list).toEqual([sampleConn])
  })

  test("HELL-2: second refresh within TTL is cached-fresh, no HTTP", async () => {
    const fake = makeFakeFetch([{ status: 200, body: sampleBody([sampleConn]) }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("fresh")
    expect(await reg.refresh()).toBe("cached-fresh")
    expect(fake.calls).toBe(1)
  })

  test("HELL-3: TTL boundary — at ttl-1 cached-fresh, at ttl re-fetch", async () => {
    const fake = makeFakeFetch([
      { status: 200, body: sampleBody([sampleConn]) },
      { status: 200, body: sampleBody([sampleConn]) },
    ])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
      cacheTtlMs: 1000,
    })
    expect(await reg.refresh()).toBe("fresh")
    clock.advance(999)
    expect(await reg.refresh()).toBe("cached-fresh")
    clock.advance(1)
    expect(await reg.refresh()).toBe("fresh")
    expect(fake.calls).toBe(2)
  })

  test("HELL-4: 5xx after stale cache → cached-degraded, stale list served", async () => {
    const fake = makeFakeFetch([
      { status: 200, body: sampleBody([sampleConn]) },
      { status: 503, body: "" },
    ])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
      cacheTtlMs: 100,
    })
    expect(await reg.refresh()).toBe("fresh")
    clock.advance(101)
    expect(await reg.refresh()).toBe("cached-degraded")
    expect(await reg.list()).toEqual([sampleConn])
  })

  test("HELL-5: 5xx without cache → refresh cached-degraded, list throws outage", async () => {
    // T11 / L9 H7: refresh() reports the degraded outcome, but list() must
    // NOT masquerade an outage-with-no-fallback as an empty catalog — it
    // throws a typed ConnectorOutageError so the caller can branch.
    const fake = makeFakeFetch([{ status: 500, body: "" }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("cached-degraded")
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
  })

  test("HELL-6: malformed JSON body → degraded fallback", async () => {
    const fake = makeFakeFetch([{ status: 200, body: "{ not json" }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("cached-degraded")
  })

  test("HELL-7: response not array → degraded", async () => {
    const fake = makeFakeFetch([{ status: 200, body: JSON.stringify({ ok: true }) }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("cached-degraded")
  })

  test("HELL-8: entry missing required field → degraded", async () => {
    const fake = makeFakeFetch([
      {
        status: 200,
        body: JSON.stringify([{ id: "x", displayName: "X", auth: "oauth" /* no host */ }]),
      },
    ])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("cached-degraded")
  })

  test("HELL-9: invalid auth arm → degraded", async () => {
    const fake = makeFakeFetch([
      {
        status: 200,
        body: JSON.stringify([{ id: "x", displayName: "X", host: "h", auth: "saml" }]),
      },
    ])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    expect(await reg.refresh()).toBe("cached-degraded")
  })

  test("HELL-10: in-flight refresh dedupe — concurrent calls share one fetch", async () => {
    let resolveFetch: ((v: FetchPortResponse) => void) | undefined
    const pending = new Promise<FetchPortResponse>((r) => {
      resolveFetch = r
    })
    let calls = 0
    const fetchPort: FetchPort = async () => {
      calls += 1
      return pending
    }
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    const p1 = reg.refresh()
    const p2 = reg.refresh()
    const p3 = reg.refresh()
    if (resolveFetch === undefined) throw new Error("fetch did not start")
    resolveFetch({
      status: 200,
      ok: true,
      text: async () => sampleBody([sampleConn]),
    })
    const [o1, o2, o3] = await Promise.all([p1, p2, p3])
    expect(o1).toBe("fresh")
    expect(o2).toBe("fresh")
    expect(o3).toBe("fresh")
    expect(calls).toBe(1)
  })

  test("HELL-11: get() returns undefined for missing id", async () => {
    const fake = makeFakeFetch([{ status: 200, body: sampleBody([sampleConn]) }])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
    })
    await reg.refresh()
    expect(await reg.get("nonexistent")).toBeUndefined()
    expect(await reg.get("github")).toEqual(sampleConn)
  })

  test("HELL-12: cacheTtlMs <=0 throws at construction", () => {
    const fake = makeFakeFetch([])
    const clock = makeFakeClock()
    const cache = makeFakeCache()
    expect(() =>
      createRestConnectorRegistry({
        fetchPort: fake.fetchPort,
        baseUrl: "https://api.x",
        clockPort: clock,
        cachePort: cache,
        cacheTtlMs: 0,
      }),
    ).toThrow(/cacheTtlMs/)
    expect(() =>
      createRestConnectorRegistry({
        fetchPort: fake.fetchPort,
        baseUrl: "https://api.x",
        clockPort: clock,
        cachePort: cache,
        cacheTtlMs: -1,
      }),
    ).toThrow(/cacheTtlMs/)
  })
})
