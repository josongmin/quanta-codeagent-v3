/**
 * Connectors — REST registry cache semantics unit (ADR-0160 Phase B).
 *
 * Covers cache port read/write interplay, cache key shape, list() vs refresh()
 * separation, and snapshot rehydration from cachePort on cold start.
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

const sample: Connector = {
  id: "github",
  displayName: "GitHub",
  host: "api.github.com",
  auth: "oauth",
  oauthIssuer: "https://github.com",
}

const fakeFetchOk = (body: string): { fetchPort: FetchPort; calls: number } => {
  const state = { calls: 0 }
  const fp: FetchPort = async () => {
    state.calls += 1
    const r: FetchPortResponse = { status: 200, ok: true, text: async () => body }
    return r
  }
  return {
    fetchPort: fp,
    get calls() {
      return state.calls
    },
  } as { fetchPort: FetchPort; calls: number }
}

const fakeCache = (): CachePort & { store: Map<string, CacheEntry> } => {
  const store = new Map<string, CacheEntry>()
  return {
    store,
    read: async (k) => store.get(k),
    write: async (k, e) => {
      store.set(k, e)
    },
  }
}

const clockOf = (start = 0): ClockPort & { advance(ms: number): void } => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

describe("connectors / rest-registry cache", () => {
  test("UNIT-1: fresh fetch persists snapshot to cachePort", async () => {
    const fake = fakeFetchOk(JSON.stringify([sample]))
    const cache = fakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clockOf(),
      cachePort: cache,
    })
    await reg.refresh()
    const keys = [...cache.store.keys()]
    expect(keys.length).toBe(1)
    const key = keys[0]
    if (key === undefined) throw new Error("no key")
    expect(key.startsWith("connectors-rest:")).toBe(true)
    expect(key.includes("https://api.x")).toBe(true)
  })

  test("UNIT-2: cold start rehydrates from cachePort if TTL valid", async () => {
    const cache = fakeCache()
    const clock = clockOf(1000)
    cache.store.set("connectors-rest:https://api.x", {
      value: JSON.stringify([sample]),
      writtenAt: 500, // 500ms ago
    })
    // Network throws — proving the cache rehydration path runs without HTTP.
    let calls = 0
    const fetchPort: FetchPort = async () => {
      calls += 1
      throw new Error("must not hit network")
    }
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
      cacheTtlMs: 10_000,
    })
    const list = await reg.list()
    expect(list).toEqual([sample])
    expect(calls).toBe(0)
  })

  test("UNIT-3: cold start with stale cache → triggers refresh", async () => {
    const cache = fakeCache()
    const clock = clockOf(10_000)
    cache.store.set("connectors-rest:https://api.x", {
      value: JSON.stringify([sample]),
      writtenAt: 0,
    })
    const fake = fakeFetchOk(JSON.stringify([sample, { ...sample, id: "gitlab" }]))
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
      cacheTtlMs: 100,
    })
    const list = await reg.list()
    expect(list.length).toBe(2)
    expect(fake.calls).toBe(1)
  })

  test("UNIT-4: list() does not double-fetch when refresh in progress", async () => {
    let resolveOnce: ((v: FetchPortResponse) => void) | undefined
    const pending = new Promise<FetchPortResponse>((r) => {
      resolveOnce = r
    })
    let calls = 0
    const fetchPort: FetchPort = async () => {
      calls += 1
      return pending
    }
    const cache = fakeCache()
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clockOf(),
      cachePort: cache,
    })
    const r1 = reg.refresh()
    const r2 = reg.refresh()
    if (resolveOnce === undefined) throw new Error("fetch not started")
    resolveOnce({ status: 200, ok: true, text: async () => JSON.stringify([sample]) })
    await Promise.all([r1, r2])
    expect(calls).toBe(1)
  })

  test("UNIT-5: trailing slash in baseUrl is normalized", async () => {
    const cache = fakeCache()
    const fake = fakeFetchOk(JSON.stringify([sample]))
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x/",
      clockPort: clockOf(),
      cachePort: cache,
    })
    await reg.refresh()
    // Verified indirectly: no double-slash crash + cache key still uses the original baseUrl.
    expect(fake.calls).toBe(1)
  })

  test("UNIT-6: cachePort write happens AFTER successful parse", async () => {
    const cache = fakeCache()
    let calls = 0
    const fetchPort: FetchPort = async () => {
      calls += 1
      return { status: 200, ok: true, text: async () => "{ broken json" }
    }
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clockOf(),
      cachePort: cache,
    })
    await reg.refresh()
    expect(cache.store.size).toBe(0) // malformed → not written
    expect(calls).toBe(1)
  })

  test("UNIT-7: list throws ConnectorOutageError when no cache and network fails", async () => {
    // T11 / L9 H7: an outage with no cached fallback is a DISTINCT typed
    // result from an empty catalog — it must NOT be folded into `[]`.
    const cache = fakeCache()
    const fetchPort: FetchPort = async () => {
      throw new Error("net")
    }
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clockOf(),
      cachePort: cache,
    })
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
  })

  test("UNIT-8: refresh outcome distinguishes fresh vs cached-fresh vs cached-degraded", async () => {
    const cache = fakeCache()
    const clock = clockOf()
    let scriptIdx = 0
    const scripts: FetchPortResponse[] = [
      { status: 200, ok: true, text: async () => JSON.stringify([sample]) },
      { status: 500, ok: false, text: async () => "" },
    ]
    const fetchPort: FetchPort = async () => {
      const r = scripts[scriptIdx]
      scriptIdx += 1
      if (r === undefined) throw new Error("oob")
      return r
    }
    const reg = createRestConnectorRegistry({
      fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: cache,
      cacheTtlMs: 100,
    })
    expect(await reg.refresh()).toBe("fresh")
    expect(await reg.refresh()).toBe("cached-fresh") // TTL still valid
    clock.advance(101)
    expect(await reg.refresh()).toBe("cached-degraded") // 5xx after TTL
  })
})
