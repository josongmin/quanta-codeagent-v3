/**
 * ADR-0263 — `none` adapter.
 *
 * Default-OFF backend that satisfies the {@link EmbedCache} port without
 * persisting anything: every `get` returns `null`, every `put` is a no-op,
 * `size()` is always 0. Wiring this when no env override is set keeps the
 * cache feature byte-identical to "no cache" — embed calls bypass the
 * cache lookup entirely (a `null` from `get` is the same signal as
 * "cache not consulted").
 */
import type { EmbedCache } from "./port"

export const newNoneEmbedCache = (): EmbedCache => ({
  get: () => null,
  put: () => {},
  invalidate: () => 0,
  size: () => 0,
  clear: () => {},
})
