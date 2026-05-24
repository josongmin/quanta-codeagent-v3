/**
 * REST-backed connector registry (ADR-0160 Phase B).
 *
 * Adapts a remote `GET {baseUrl}/connectors` endpoint to `ConnectorRegistryPort`.
 *
 * Cache contract (RFC 8414 §4 anchor — server-driven catalog SHOULD cache 24h):
 *   - Positive cache TTL: 24h (configurable via `cacheTtlMs`, default 86_400_000).
 *   - On 5xx / network failure: serve stale cache, `refresh()` returns
 *     `"cached-degraded"` so caller can branch.
 *   - On cache hit within TTL: `refresh()` returns `"cached-fresh"` (no HTTP call).
 *   - On fresh fetch: `refresh()` returns `"fresh"`.
 *
 * In-flight refresh coalescing: concurrent `refresh()` calls share one network
 * request (mirrors `src/auth/chatgpt-oauth/refresh.ts` invariant).
 */

import type {
  CachePort,
  ClockPort,
  Connector,
  ConnectorRegistryPort,
  FetchPort,
  RefreshOutcome,
} from "./types"

/** Default cache TTL — RFC 8414 §4 SHOULD recommendation. */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Cache key used by the REST adapter. Includes baseUrl for multi-instance safety. */
const cacheKey = (baseUrl: string): string => `connectors-rest:${baseUrl}`

export interface RestRegistryConfig {
  readonly fetchPort: FetchPort
  readonly baseUrl: string
  readonly clockPort: ClockPort
  readonly cachePort: CachePort
  /** Override the 24h default (testing). Must be > 0. */
  readonly cacheTtlMs?: number
}

/**
 * Parse a cache blob into a connector list. Returns `undefined` on malformed
 * input — caller treats this as a cache miss.
 */
const parseCached = (raw: string): ReadonlyArray<Connector> | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed as ReadonlyArray<Connector>
  } catch {
    return undefined
  }
}

/**
 * Parse a server response body into a typed connector list. Throws if the
 * shape is wrong — caller catches + falls back to stale cache.
 */
const parseResponse = (raw: string): ReadonlyArray<Connector> => {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error("connectors response is not an array")
  // Shallow shape check — REST adapter trusts the registry to publish well-formed entries.
  for (const c of parsed) {
    if (typeof c !== "object" || c === null) throw new Error("connector entry not object")
    const candidate = c as Partial<Connector>
    if (typeof candidate.id !== "string") throw new Error("connector missing id")
    if (typeof candidate.host !== "string") throw new Error("connector missing host")
    if (candidate.auth !== "oauth" && candidate.auth !== "none") {
      throw new Error("connector auth must be oauth|none")
    }
  }
  return parsed as ReadonlyArray<Connector>
}

export const createRestConnectorRegistry = (config: RestRegistryConfig): ConnectorRegistryPort => {
  const ttl = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (ttl <= 0) throw new Error("cacheTtlMs must be > 0")

  const url = `${config.baseUrl.replace(/\/+$/, "")}/connectors`
  const key = cacheKey(config.baseUrl)

  // In-memory mirror of last-known-good. Populated from cachePort on first call.
  let memo: ReadonlyArray<Connector> | undefined
  let memoWrittenAt: number | undefined
  // In-flight coalescing — concurrent refresh calls share one promise.
  let inFlight: Promise<RefreshOutcome> | undefined

  const loadFromCache = async (): Promise<void> => {
    if (memo !== undefined) return
    const entry = await config.cachePort.read(key)
    if (entry === undefined) return
    const parsed = parseCached(entry.value)
    if (parsed === undefined) return
    memo = parsed
    memoWrittenAt = entry.writtenAt
  }

  const isFresh = (writtenAt: number | undefined): boolean => {
    if (writtenAt === undefined) return false
    return config.clockPort.now() - writtenAt < ttl
  }

  const doFetch = async (): Promise<RefreshOutcome> => {
    try {
      const res = await config.fetchPort(url, { method: "GET" })
      if (!res.ok) {
        // 5xx (or any non-ok) → serve stale if we have it.
        await loadFromCache()
        return memo !== undefined ? "cached-degraded" : "cached-degraded"
      }
      const body = await res.text()
      const parsed = parseResponse(body)
      const now = config.clockPort.now()
      memo = parsed
      memoWrittenAt = now
      await config.cachePort.write(key, { value: body, writtenAt: now })
      return "fresh"
    } catch {
      // Network/parse failure → degraded.
      await loadFromCache()
      return "cached-degraded"
    }
  }

  const refresh = async (): Promise<RefreshOutcome> => {
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        await loadFromCache()
        if (isFresh(memoWrittenAt)) return "cached-fresh"
        return doFetch()
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  const list = async (): Promise<ReadonlyArray<Connector>> => {
    await loadFromCache()
    if (memo === undefined || !isFresh(memoWrittenAt)) {
      await refresh()
    }
    return memo ?? []
  }

  const get = async (id: string): Promise<Connector | undefined> => {
    const all = await list()
    return all.find((c) => c.id === id)
  }

  return { list, get, refresh }
}
