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

/**
 * Raised by {@link ConnectorRegistryPort.list} (T11, audit L9 H7) when the
 * registry is unreachable AND there is no cached catalog to fall back on.
 *
 * Honesty contract: a connector outage with no fallback is a DISTINCT state
 * from an empty catalog. `list()` MUST NOT fold "I could not reach the
 * registry" into `[]` (the `warn-once-return-[]` anti-pattern) — that would
 * let a transient server outage masquerade as "the user has no connectors".
 * Callers branch on this error to retry / surface "registry unreachable" /
 * refuse to treat the catalog as authoritatively empty.
 *
 * A genuinely-empty catalog (server returned `[]` with 200) is NOT an outage
 * and `list()` returns `[]` for it.
 */
export class ConnectorOutageError extends Error {
  /** Stable discriminant — callers branch without parsing the message. */
  readonly code = "registry-unreachable" as const
  /** The registry base URL that could not be reached (for diagnostics). */
  readonly baseUrl: string
  constructor(baseUrl: string, options?: { cause?: unknown }) {
    super(`connector registry unreachable and no cached catalog: ${baseUrl}`, options)
    this.name = "ConnectorOutageError"
    this.baseUrl = baseUrl
  }
}

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
 * Per-entry shape validation, shared by BOTH the network path
 * ({@link parseResponse}) and the cache path ({@link parseCached}). A cached
 * blob is no more trustworthy than a network blob — it can be stale,
 * hand-edited, or corrupt — so it must clear the SAME bar before being typed as
 * `Connector[]`. This is the single source of truth for "is this a connector
 * array"; never `as Connector[]` after only an `Array.isArray` guard.
 *
 * Throws on the first malformed entry. The two call sites differ only in how
 * they react: the network path lets the throw propagate (→ stale-cache
 * fallback); the cache path catches it and treats a poisoned blob as a miss.
 */
const validateConnectorArray = (parsed: unknown): ReadonlyArray<Connector> => {
  if (!Array.isArray(parsed)) throw new Error("connectors response is not an array")
  // Shallow shape check — mirrors the closed `Connector` union (id/host/auth).
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

/**
 * Parse a cache blob into a connector list. Returns `undefined` on malformed
 * input OR on a poisoned entry (stale/hand-edited/corrupt cache) — caller
 * treats this as a cache miss. Symmetric with {@link parseResponse}: a cache
 * entry gets the SAME per-entry validation as a network response.
 */
const parseCached = (raw: string): ReadonlyArray<Connector> | undefined => {
  try {
    return validateConnectorArray(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Parse a server response body into a typed connector list. Throws if the
 * shape is wrong — caller catches + falls back to stale cache.
 */
const parseResponse = (raw: string): ReadonlyArray<Connector> =>
  validateConnectorArray(JSON.parse(raw) as unknown)

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
    // Fail-closed on a backward clock step (NTP correction / manual set): the
    // only concrete ClockPort adapter returns the WALL clock, so `now` can be
    // < `writtenAt`, making `now - writtenAt` negative and `< ttl` always true —
    // freezing a stale catalog as "fresh" indefinitely until the clock catches
    // back up. Treat a negative age as STALE so a clock that ran backward forces
    // a refresh rather than serving a stale catalog past its TTL.
    const age = config.clockPort.now() - writtenAt
    return age >= 0 && age < ttl
  }

  const doFetch = async (): Promise<RefreshOutcome> => {
    try {
      const res = await config.fetchPort(url, { method: "GET" })
      if (!res.ok) {
        // 5xx (or any non-ok) → serve stale if we have it. `memo` stays
        // `undefined` when there is no cache to fall back on; `list()`
        // converts that into a typed `ConnectorOutageError` so an outage
        // never masquerades as an empty catalog (T11 / L9 H7).
        await loadFromCache()
        return "cached-degraded"
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
    // After a refresh attempt, `memo === undefined` means: the registry was
    // unreachable AND there was no cached catalog to fall back on. We refuse
    // to fold that into `[]` — an outage is a DISTINCT typed result from an
    // empty catalog (T11 / L9 H7 owning-seam invariant). A genuinely-empty
    // catalog (server 200 with `[]`, or a cached `[]`) leaves `memo === []`,
    // which we return as the authoritative answer.
    if (memo === undefined) {
      throw new ConnectorOutageError(config.baseUrl)
    }
    return memo
  }

  const get = async (id: string): Promise<Connector | undefined> => {
    const all = await list()
    return all.find((c) => c.id === id)
  }

  return { list, get, refresh }
}
