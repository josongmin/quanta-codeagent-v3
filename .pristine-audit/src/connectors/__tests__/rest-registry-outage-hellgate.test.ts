/**
 * T11 — REST connector registry OUTAGE-vs-EMPTY hellgate.
 *
 * Audit L9 H7: "Connector outage masquerades as empty catalog."
 *
 * The owning-seam invariant (T11): outage and empty-state are DISTINCT
 * typed results. A server outage with NO cached fallback MUST NOT return
 * an empty connector list (the `warn-once-return-[]` anti-pattern) — it
 * must surface a typed {@link ConnectorOutageError} so the caller can
 * branch (retry / show "registry unreachable" / refuse to treat the
 * catalog as authoritatively empty).
 *
 * A genuinely-empty catalog (server returned `[]` with 200) MUST still
 * return `[]` — that IS the authoritative answer.
 *
 * 8 adversarial cases:
 *   1. outage (5xx) + no cache  → list() THROWS ConnectorOutageError
 *   2. outage (network throw) + no cache → list() THROWS
 *   3. genuinely-empty 200 [] + no cache → list() returns [] (NOT a throw)
 *   4. outage + stale cache → list() returns the stale set (no throw)
 *   5. outage error carries the failing baseUrl + a stable code
 *   6. after an outage, a later fresh 200 recovers (list returns entries)
 *   7. refresh() still returns "cached-degraded" on outage (no throw there)
 *   8. empty 200 caches []; a subsequent outage returns the cached [] (no throw)
 */

import { describe, expect, test } from "bun:test"
import { ConnectorOutageError, createRestConnectorRegistry } from "@/connectors/rest-registry"
import type {
  CacheEntry,
  CachePort,
  ClockPort,
  Connector,
  FetchPort,
  FetchPortResponse,
} from "@/connectors/types"

interface Script {
  readonly status: number
  readonly body: string
  readonly throws?: boolean
}

const makeFetch = (scripts: Script[]): { fetchPort: FetchPort; calls: () => number } => {
  let calls = 0
  const fetchPort: FetchPort = async () => {
    const next = scripts[calls]
    calls += 1
    if (next === undefined) throw new Error(`unexpected fetch #${calls - 1}`)
    if (next.throws === true) throw new Error("network down")
    const res: FetchPortResponse = {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => next.body,
    }
    return res
  }
  return { fetchPort, calls: () => calls }
}

const makeClock = (start = 0): ClockPort & { advance(ms: number): void } => {
  let now = start
  return { now: () => now, advance: (ms) => (now += ms) }
}

const makeCache = (): CachePort & { store: Map<string, CacheEntry> } => {
  const store = new Map<string, CacheEntry>()
  return {
    store,
    read: async (k) => store.get(k),
    write: async (k, e) => {
      store.set(k, e)
    },
  }
}

const conn: Connector = {
  id: "github",
  displayName: "GitHub",
  host: "api.github.com",
  auth: "oauth",
  oauthIssuer: "https://github.com",
}

describe("rest-registry-outage-hellgate", () => {
  test("HELL-1: 5xx outage + no cache → list() throws ConnectorOutageError", async () => {
    const fake = makeFetch([{ status: 503, body: "" }])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
  })

  test("HELL-2: network-throw outage + no cache → list() throws", async () => {
    const fake = makeFetch([{ status: 0, body: "", throws: true }])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
  })

  test("HELL-3: genuinely-empty 200 [] + no cache → list() returns [] (NO throw)", async () => {
    const fake = makeFetch([{ status: 200, body: "[]" }])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    expect(await reg.list()).toEqual([])
  })

  test("HELL-4: outage + stale cache → list() serves stale set, no throw", async () => {
    const fake = makeFetch([
      { status: 200, body: JSON.stringify([conn]) },
      { status: 503, body: "" },
    ])
    const clock = makeClock()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: makeCache(),
      cacheTtlMs: 100,
    })
    expect(await reg.refresh()).toBe("fresh")
    clock.advance(101)
    expect(await reg.list()).toEqual([conn])
  })

  test("HELL-5: outage error carries failing baseUrl + stable code", async () => {
    const fake = makeFetch([{ status: 500, body: "" }])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.unreachable",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    let caught: unknown
    try {
      await reg.list()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConnectorOutageError)
    const err = caught as ConnectorOutageError
    expect(err.code).toBe("registry-unreachable")
    expect(err.baseUrl).toBe("https://api.unreachable")
  })

  test("HELL-6: after outage, a later fresh 200 recovers", async () => {
    const fake = makeFetch([
      { status: 503, body: "" },
      { status: 200, body: JSON.stringify([conn]) },
    ])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    await expect(reg.list()).rejects.toBeInstanceOf(ConnectorOutageError)
    expect(await reg.refresh()).toBe("fresh")
    expect(await reg.list()).toEqual([conn])
  })

  test("HELL-7: refresh() still returns cached-degraded on outage (no throw)", async () => {
    const fake = makeFetch([{ status: 500, body: "" }])
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: makeClock(),
      cachePort: makeCache(),
    })
    expect(await reg.refresh()).toBe("cached-degraded")
  })

  test("HELL-8: empty 200 caches []; later outage returns cached [] (no throw)", async () => {
    const fake = makeFetch([
      { status: 200, body: "[]" },
      { status: 503, body: "" },
    ])
    const clock = makeClock()
    const reg = createRestConnectorRegistry({
      fetchPort: fake.fetchPort,
      baseUrl: "https://api.x",
      clockPort: clock,
      cachePort: makeCache(),
      cacheTtlMs: 100,
    })
    expect(await reg.list()).toEqual([])
    clock.advance(101)
    // Stale cache exists (an authoritative empty []) → outage serves it,
    // does NOT throw. Empty-because-cached is distinct from empty-because-outage.
    expect(await reg.list()).toEqual([])
  })
})
