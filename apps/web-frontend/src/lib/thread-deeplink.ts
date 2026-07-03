/**
 * B2 — web-frontend thread deeplink route resolver (pure, no DOM).
 *
 * The consumer half of the cross-surface thread deeplink. A `threads_handoff`
 * tool emits `quanta://threads/{id}`; the CANONICAL router lives in the main
 * package at `@/scheduler/deeplink-route`. The web-frontend is a SEPARATE build
 * root (Vite SPA) and cannot import `src/`, so this is a self-contained mirror
 * of the SAME contract — the two are kept in lock-step by parallel unit tests
 * (`thread-deeplink.test.ts` here; `b2-deeplink-route-hellgate.test.ts` there).
 *
 * Two entry points:
 *   - {@link resolveThreadRouteFromLocation} — reads a `window.location`-like
 *     object (`search` + `hash`) for the web fallback `?thread=` / `#thread=`
 *     param. Takes the object (not the global) so it is testable without a DOM.
 *   - {@link resolveThreadRouteFromUri} — takes a raw URI/URL string, handling
 *     BOTH the native `quanta://threads/{id}` scheme (e.g. a Tauri OS deep-link
 *     event payload forwarded into the webview) AND the web fallback URL.
 *
 * Both return `{ threadId } | null` and NEVER throw. Resuming the thread is the
 * host's responsibility; this module only turns an ADDRESS into an INTENT.
 */

/** The fixed native scheme + authority (mirrors `@/scheduler/deeplink`). */
export const THREAD_DEEPLINK_PREFIX = "quanta://threads/" as const

/** The web-fallback query/hash key: `?thread=<id>` / `#thread=<id>`. */
export const THREAD_WEB_PARAM = "thread" as const

/** A resolved cross-surface thread route intent. Exactly one field. */
export interface ThreadRouteIntent {
  /** The (decoded) thread id the host should attempt to open / resume. */
  readonly threadId: string
}

/** A minimal `window.location`-shaped input (so tests need no DOM). */
export interface LocationLike {
  /** The `?query` component INCLUDING the leading `?` (or ""). */
  readonly search: string
  /** The `#hash` component INCLUDING the leading `#` (or ""). */
  readonly hash: string
}

/** Parse the native `quanta://threads/{id}` scheme. Mirrors parseThreadDeeplink. */
const parseNativeDeeplink = (uri: string): string | null => {
  if (typeof uri !== "string") return null
  if (!uri.startsWith(THREAD_DEEPLINK_PREFIX)) return null
  const encoded = uri.slice(THREAD_DEEPLINK_PREFIX.length)
  if (encoded.length === 0) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (decoded.length === 0) return null
  return decoded
}

/**
 * Read the `thread` value from a `?query` or `#hash` component body (delimiter
 * already stripped) using `URLSearchParams`. Empty/absent ⇒ null. Total (never
 * throws) — a component like "???" yields no `thread` key.
 */
const readThreadParam = (componentBody: string): string | null => {
  if (componentBody.length === 0) return null
  const params = new URLSearchParams(componentBody)
  const value = params.get(THREAD_WEB_PARAM)
  if (value === null || value.length === 0) return null
  return value
}

/** Strip a single leading delimiter char (`?` or `#`) if present. */
const stripLeading = (s: string, delimiter: "?" | "#"): string =>
  s.startsWith(delimiter) ? s.slice(1) : s

/**
 * Resolve a thread route from a location-like object (web fallback only —
 * `window.location` never carries a `quanta://` scheme). Query wins over hash.
 * Never throws.
 */
export const resolveThreadRouteFromLocation = (
  location: LocationLike,
): ThreadRouteIntent | null => {
  const fromQuery = readThreadParam(stripLeading(location.search ?? "", "?"))
  if (fromQuery !== null) return { threadId: fromQuery }
  const fromHash = readThreadParam(stripLeading(location.hash ?? "", "#"))
  if (fromHash !== null) return { threadId: fromHash }
  return null
}

/**
 * Split a raw URL/URI into its `?query` and `#hash` bodies WITHOUT `new URL()`
 * (which throws on relative inputs / malformed authorities). Total. The hash
 * starts at the first `#`; the query is between the first `?` and that `#`.
 */
const splitUrlComponents = (raw: string): { query: string; hash: string } => {
  const hashIndex = raw.indexOf("#")
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const hash = hashIndex >= 0 ? raw.slice(hashIndex + 1) : ""
  const queryIndex = beforeHash.indexOf("?")
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : ""
  return { query, hash }
}

/**
 * Resolve a thread route from a raw URI/URL string. Handles the native
 * `quanta://threads/{id}` scheme first (opaque past the prefix), then the web
 * fallback `?thread=` / `#thread=`. Never throws. Non-string ⇒ null.
 */
export const resolveThreadRouteFromUri = (input: string): ThreadRouteIntent | null => {
  if (typeof input !== "string") return null
  if (input.length === 0) return null
  if (input.startsWith(THREAD_DEEPLINK_PREFIX)) {
    const threadId = parseNativeDeeplink(input)
    return threadId === null ? null : { threadId }
  }
  const { query, hash } = splitUrlComponents(input)
  const fromQuery = readThreadParam(query)
  if (fromQuery !== null) return { threadId: fromQuery }
  const fromHash = readThreadParam(hash)
  if (fromHash !== null) return { threadId: fromHash }
  return null
}
