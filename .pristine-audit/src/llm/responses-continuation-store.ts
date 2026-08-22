import type { ResponsesInputItem } from "./openai-responses-wire"

export interface ResponsesContinuationEntry {
  readonly routeKey: string
  readonly responseId: string
  readonly requestFingerprint: string
  readonly inputItems: ReadonlyArray<ResponsesInputItem>
  readonly outputItems: ReadonlyArray<ResponsesInputItem>
  readonly resumable: boolean
  readonly updatedAt: number
}

export interface ResponsesContinuationStore {
  get(routeKey: string): ResponsesContinuationEntry | null
  canResume(routeKey: string): boolean
  markResumeUnsupported(routeKey: string): void
  put(entry: Omit<ResponsesContinuationEntry, "updatedAt">): void
  clear(routeKey: string): void
  clearAll(): void
}

export interface ResponsesContinuationStoreOpts {
  readonly maxEntries?: number
  readonly now?: () => number
}

const DEFAULT_MAX_ENTRIES = 100

const freezeItems = (items: readonly ResponsesInputItem[]): ReadonlyArray<ResponsesInputItem> =>
  Object.freeze(items.slice()) as ReadonlyArray<ResponsesInputItem>

export const defaultResponsesContinuationStore = (
  opts?: ResponsesContinuationStoreOpts,
): ResponsesContinuationStore => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const now = opts?.now ?? Date.now
  const store = new Map<string, ResponsesContinuationEntry>()
  const unsupportedResumeRoutes = new Set<string>()

  const evictIfOver = (): void => {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
      // The unsupported-resume marker is keyed by the SAME routeKey; evict it
      // in lockstep so the Set can never outgrow the bounded entry map (it was
      // previously add-only ⇒ an unbounded leak across long-lived processes).
      unsupportedResumeRoutes.delete(oldestKey)
    }
  }

  return {
    get(routeKey) {
      const entry = store.get(routeKey)
      return entry === undefined ? null : entry
    },

    canResume(routeKey) {
      return !unsupportedResumeRoutes.has(routeKey)
    },

    markResumeUnsupported(routeKey) {
      // Re-insert at the tail so insertion order tracks recency (a Set preserves
      // insertion order; deleting + re-adding moves an existing key to the end).
      if (unsupportedResumeRoutes.has(routeKey)) unsupportedResumeRoutes.delete(routeKey)
      unsupportedResumeRoutes.add(routeKey)
      // Bound the marker Set INDEPENDENTLY of store membership. The store-side
      // lockstep eviction (evictIfOver) only trims markers whose routeKey is
      // also evicted from `store` — but a route can be marked unsupported while
      // never put() into the store (or cleared right after), so without this cap
      // the Set grows without bound on long-lived processes. Trim the oldest
      // (insertion-order head) markers using the SAME maxEntries cap as `store`.
      while (unsupportedResumeRoutes.size > maxEntries) {
        const oldestMarker = unsupportedResumeRoutes.values().next().value
        if (oldestMarker === undefined) break
        unsupportedResumeRoutes.delete(oldestMarker)
      }
    },

    put(entry) {
      const next: ResponsesContinuationEntry = {
        ...entry,
        updatedAt: now(),
        inputItems: freezeItems(entry.inputItems),
        outputItems: freezeItems(entry.outputItems),
      }
      if (store.has(entry.routeKey)) store.delete(entry.routeKey)
      store.set(entry.routeKey, next)
      evictIfOver()
    },

    clear(routeKey) {
      store.delete(routeKey)
      // NOTE: the per-route resume marker is intentionally NOT dropped here —
      // "resume unsupported" is a stable property of the ROUTE, not of a single
      // cached entry, so it must persist across clear(route) and reset only on
      // clearAll() (pinned by responses-continuation-wrapping). The unbounded-
      // growth concern is handled in evictIfOver (lockstep LRU eviction).
    },

    clearAll() {
      store.clear()
      unsupportedResumeRoutes.clear()
    },
  }
}
