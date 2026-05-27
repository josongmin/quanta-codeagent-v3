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

const freezeItems = (
  items: readonly ResponsesInputItem[],
): ReadonlyArray<ResponsesInputItem> => Object.freeze(items.slice()) as ReadonlyArray<ResponsesInputItem>

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
      unsupportedResumeRoutes.add(routeKey)
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
    },

    clearAll() {
      store.clear()
      unsupportedResumeRoutes.clear()
    },
  }
}
