/**
 * B2 — cross-surface thread deeplink (pure, no I/O).
 *
 * A `quanta://threads/{threadId}` URI is the surface-agnostic handle a host
 * (CLI / Web-Tauri / embedded browser) uses to point at a conversation thread —
 * e.g. a `threads_handoff` tool hands the current session off to another surface
 * by emitting this link, and the receiving surface parses it to resume the
 * thread (reusing the spot-resume cassette/replay transport as the actual
 * session carrier; this module only encodes the ADDRESS, never a payload).
 *
 * SCHEME + HOST are fixed (`quanta` + `threads`). The threadId is percent-
 * encoded on build and decoded on parse so ids containing URL-unsafe characters
 * (slashes, spaces, unicode) round-trip losslessly. Pure functions: no clock,
 * no env, no I/O — safe to import anywhere.
 *
 * Slice: `@/scheduler` (additive pure helper).
 */

/** The fixed URI scheme + authority for a thread deeplink. */
export const THREAD_DEEPLINK_PREFIX = "quanta://threads/" as const

/**
 * Build a `quanta://threads/{threadId}` deeplink. The `threadId` is percent-
 * encoded so any string round-trips through {@link parseThreadDeeplink}.
 *
 * Empty `threadId` is a programming error (a deeplink must address SOME thread);
 * it still builds a (parse-rejecting) prefix-only URI rather than throwing, so
 * callers stay no-throw — the paired parser returns `null` for it.
 */
export const buildThreadDeeplink = (threadId: string): string =>
  `${THREAD_DEEPLINK_PREFIX}${encodeURIComponent(threadId)}`

/**
 * Parse a thread deeplink back to its `threadId`, or `null` when the input is
 * not a well-formed `quanta://threads/{non-empty}` URI. Never throws — a
 * malformed percent-escape yields `null` rather than a `URIError`.
 */
export const parseThreadDeeplink = (uri: string): string | null => {
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
