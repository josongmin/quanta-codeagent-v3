/**
 * Per-host availability prober (ADR-0160 Phase D).
 *
 * Probe sequence per host:
 *   1. DNS resolve (typed `DnsPort`) — if zero addresses returned → "dns-fail".
 *   2. HTTP HEAD to `https://{host}/` via injected `FetchPort` with a 3s timeout
 *      (RFC 9112 conservative default). Some servers reject HEAD with 405;
 *      we treat any 2xx/3xx/4xx as "ok" (server is reachable) and only 5xx +
 *      timeout as "http-fail" / "timeout".
 *
 * LRU 5-min TTL (matches Cursor observed window). Concurrent probes for the
 * same host coalesce to one network call (in-flight dedupe).
 */

import type {
  AvailabilityCheckerPort,
  AvailabilityVerdict,
  ClockPort,
  DnsPort,
  FetchPort,
} from "./types"

/** RFC 9112 conservative default HEAD timeout. */
const DEFAULT_HEAD_TIMEOUT_MS = 3_000
/** Cursor-observed LRU window. */
const DEFAULT_LRU_TTL_MS = 5 * 60 * 1000
const DEFAULT_LRU_SIZE = 128

interface CachedVerdict {
  readonly verdict: AvailabilityVerdict
  readonly cachedAt: number
}

export interface AvailabilityProberConfig {
  readonly fetchPort: FetchPort
  readonly dnsPort: DnsPort
  readonly clockPort: ClockPort
  readonly lruSize?: number
  readonly lruTtlMs?: number
  readonly headTimeoutMs?: number
}

/**
 * Tiny insertion-order LRU. Map's iteration order in JS is insertion order;
 * deleting + re-inserting moves a key to the tail. On overflow we evict head.
 */
const evictOldest = (map: Map<string, CachedVerdict>, maxSize: number): void => {
  while (map.size > maxSize) {
    const firstKey = map.keys().next().value
    if (firstKey === undefined) break
    map.delete(firstKey)
  }
}

export const createAvailabilityProber = (
  config: AvailabilityProberConfig,
): AvailabilityCheckerPort => {
  const lruTtl = config.lruTtlMs ?? DEFAULT_LRU_TTL_MS
  const lruSize = config.lruSize ?? DEFAULT_LRU_SIZE
  const headTimeout = config.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS
  if (lruTtl <= 0) throw new Error("lruTtlMs must be > 0")
  if (lruSize <= 0) throw new Error("lruSize must be > 0")
  if (headTimeout <= 0) throw new Error("headTimeoutMs must be > 0")

  const cache = new Map<string, CachedVerdict>()
  const inFlight = new Map<string, Promise<AvailabilityVerdict>>()

  const isFresh = (entry: CachedVerdict): boolean =>
    config.clockPort.now() - entry.cachedAt < lruTtl

  const doProbe = async (host: string): Promise<AvailabilityVerdict> => {
    // 1. DNS
    let addresses: ReadonlyArray<string>
    try {
      addresses = await config.dnsPort.resolve(host)
    } catch {
      return "dns-fail"
    }
    if (addresses.length === 0) return "dns-fail"

    // 2. HEAD with timeout.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), headTimeout)
    try {
      const res = await config.fetchPort(`https://${host}/`, {
        method: "HEAD",
        signal: ac.signal,
      })
      // Server reachable iff response status is in 100..499 (any HTTP response).
      if (res.status >= 100 && res.status < 500) return "ok"
      return "http-fail"
    } catch (e) {
      // AbortError vs network — both bucket via signal state.
      if (ac.signal.aborted) return "timeout"
      // Defensive: distinguish "didn't throw an AbortError but signal aborted later" cases.
      void e
      return "http-fail"
    } finally {
      clearTimeout(timer)
    }
  }

  const probe = async (host: string): Promise<AvailabilityVerdict> => {
    const existing = cache.get(host)
    if (existing !== undefined && isFresh(existing)) {
      // Touch — move to tail for LRU recency.
      cache.delete(host)
      cache.set(host, existing)
      return existing.verdict
    }
    const ongoing = inFlight.get(host)
    if (ongoing !== undefined) return ongoing

    const p = (async () => {
      try {
        const verdict = await doProbe(host)
        cache.set(host, { verdict, cachedAt: config.clockPort.now() })
        evictOldest(cache, lruSize)
        return verdict
      } finally {
        inFlight.delete(host)
      }
    })()
    inFlight.set(host, p)
    return p
  }

  return { probe }
}
