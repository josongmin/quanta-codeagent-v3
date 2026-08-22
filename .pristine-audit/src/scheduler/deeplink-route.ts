/**
 * B2 — thread deeplink ROUTE resolver (pure, no I/O).
 *
 * The missing CONSUMER for {@link parseThreadDeeplink}: a `quanta://threads/{id}`
 * emitted by the `threads_handoff` tool had zero callers, so the address was
 * un-openable. This module is the single surface-agnostic entry point every host
 * funnels an incoming address through to obtain a typed route intent:
 *
 *   - Tauri: the OS deep-link event delivers `quanta://threads/{id}` — routed here.
 *   - Web:   a shared link `http://host/?thread=<id>` (or `#thread=<id>`) — the
 *            browser cannot receive a custom-scheme URI, so the web fallback is a
 *            plain query/hash param on the SPA URL. Routed here too.
 *
 * It returns `{ threadId }` or `null`. It NEVER throws — hosts pass untyped event
 * payloads and arbitrary `window.location.href`, so a malformed URL, a foreign
 * scheme, a missing param, or a non-string input all yield `null`. Resuming the
 * thread is the host's job (see the web-frontend note): this module encodes only
 * the ADDRESS→INTENT step, mirroring `@/scheduler/deeplink` which encodes the
 * address itself.
 *
 * Precedence: the native `quanta://threads/` scheme is checked first (it is the
 * canonical cross-surface handle), then the web `?thread=` query, then the
 * `#thread=` hash. The native URI is opaque past its prefix (the emitter always
 * percent-encodes the id), so a defensive `?`/`#` inside it stays part of the id.
 *
 * Pure: no `window`, no clock, no env — safe to import in any surface.
 *
 * Slice: `@/scheduler` (additive pure helper; consumer of `./deeplink`).
 */

import { parseThreadDeeplink, THREAD_DEEPLINK_PREFIX } from "./deeplink"

/**
 * The query/hash key a web-fallback share URL uses to name the target thread:
 * `?thread=<id>` or `#thread=<id>`. Exported so the web host and this resolver
 * never drift on the magic string.
 */
export const THREAD_WEB_PARAM = "thread" as const

/** A resolved cross-surface thread route intent. Exactly one field. */
export interface ThreadRouteIntent {
  /** The (decoded) thread id the host should attempt to open / resume. */
  readonly threadId: string
}

/**
 * Extract the `thread` value from a URL's `?query` or `#hash` component using
 * `URLSearchParams` semantics (so percent-escapes decode, `+` → space). Returns
 * `null` when the component is absent, has no `thread` key, or the value is empty.
 *
 * The component string is the part AFTER the `?` / `#` delimiter (delimiter
 * stripped by the caller). A hash of the form `#thread=x` and a query of the
 * form `?thread=x` share this parser.
 */
const readThreadParam = (search: string): string | null => {
  if (search.length === 0) return null
  const params = new URLSearchParams(search)
  const value = params.get(THREAD_WEB_PARAM)
  if (value === null || value.length === 0) return null
  return value
}

/**
 * Split a raw URL/URI string into its `?query` and `#hash` component bodies
 * WITHOUT the `new URL()` constructor — the constructor throws on relative
 * inputs (`#thread=x`) and malformed authorities (`http://[::bad`), and the
 * fallback param may legitimately arrive on such strings. String slicing here
 * is total (never throws). The hash starts at the FIRST `#`; the query is
 * between the first `?` and that `#` (a `?` after `#` is part of the fragment,
 * per the URL grammar).
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
 * Resolve an incoming URI/URL to a typed thread route intent, or `null`.
 *
 * Order:
 *   1. Native `quanta://threads/{id}` — delegated to {@link parseThreadDeeplink}
 *      (opaque past the prefix; percent-decoded id).
 *   2. Web `?thread=<id>` query param.
 *   3. Web `#thread=<id>` hash param.
 *
 * Never throws.
 */
export const resolveThreadRoute = (input: string): ThreadRouteIntent | null => {
  if (typeof input !== "string") return null
  if (input.length === 0) return null

  // (1) Native scheme first — the canonical cross-surface handle. Everything
  // after the fixed prefix is the (encoded) id, so a native URI is opaque past
  // the prefix and a defensive query/hash inside it is NOT re-split.
  if (input.startsWith(THREAD_DEEPLINK_PREFIX)) {
    const threadId = parseThreadDeeplink(input)
    return threadId === null ? null : { threadId }
  }

  // (2)/(3) Web fallback — query wins over hash (query is the canonical share
  // form the URL pill would emit). Component split is total (no URL ctor).
  const { query, hash } = splitUrlComponents(input)
  const fromQuery = readThreadParam(query)
  if (fromQuery !== null) return { threadId: fromQuery }
  const fromHash = readThreadParam(hash)
  if (fromHash !== null) return { threadId: fromHash }

  return null
}
