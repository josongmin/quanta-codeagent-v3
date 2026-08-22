/**
 * `@/shared/net/redirect-hygiene` — cross-origin credential strip on redirect.
 *
 * WHY IT LIVES HERE (aug-22 audit). This logic was written for the egress proxy
 * (`@/runtime/network-proxy/header-rules`) and had **zero callers**, while the
 * one place that needed it — `fetchWithSsrfGuard` in `./ssrf.ts` — leaked. That
 * guard walks redirects with `redirect: "manual"` so it can re-validate every
 * hop against the SSRF policy, and re-issues each hop with the ORIGINAL `init`.
 * Switching off the platform's automatic redirect handling silently gave up the
 * WHATWG-fetch behaviour of dropping `Authorization` when a redirect leaves the
 * origin, so a 302 from a configured LLM endpoint to an attacker host forwarded
 * the API key verbatim. Measured, paired control:
 *
 *   via fetchWithSsrfGuard → attacker saw: Bearer <API KEY>
 *   via plain fetch        → attacker saw: null
 *
 * `@/shared` may not import `@/runtime` (slice fence), so the implementation
 * moved DOWN to the lowest slice that both consumers can reach and
 * `header-rules` now re-exports it. One implementation, two callers — a second
 * copy in `ssrf.ts` would be the same drift that produced this bug.
 *
 * PURE / NO-THROW.
 */

/** Headers dropped when a redirect crosses origin. Mirrors the browser rule. */
export const CROSS_ORIGIN_STRIP_HEADERS: readonly string[] = ["authorization", "cookie", "host"]

/** The canonical origin tuple (scheme + lowercased host + effective port). */
interface Origin {
  readonly scheme: string
  readonly host: string
  readonly port: number
}

const defaultPortFor = (scheme: string): number =>
  scheme === "https:"
    ? 443
    : scheme === "http:"
      ? 80
      : scheme === "ws:"
        ? 80
        : scheme === "wss:"
          ? 443
          : -1

const parseOrigin = (raw: string): Origin | null => {
  try {
    const u = new URL(raw)
    const scheme = u.protocol.toLowerCase()
    const port = u.port !== "" ? Number(u.port) : defaultPortFor(scheme)
    return { scheme, host: u.hostname.toLowerCase(), port }
  } catch {
    return null
  }
}

/**
 * True when a redirect from `fromUrl` to `toUrl` crosses ORIGIN — scheme, host,
 * OR port differ. Default scheme ports are normalized (http→80, https→443) so
 * `http://h` and `http://h:80` are the SAME origin (no spurious strip). An
 * UNPARSEABLE url is treated as cross-origin (fail-closed — strip rather than
 * risk a leak).
 */
export const shouldStripOnRedirect = (fromUrl: string, toUrl: string): boolean => {
  const from = parseOrigin(fromUrl)
  const to = parseOrigin(toUrl)
  if (from === null || to === null) return true
  return from.scheme !== to.scheme || from.host !== to.host || from.port !== to.port
}

/**
 * Return `headers` with the cross-origin-sensitive entries removed. Header names
 * are matched case-insensitively (HTTP header names are case-insensitive and a
 * caller may well have written `Authorization`). Accepts the shapes a
 * `RequestInit.headers` can take; returns a plain record the caller can hand
 * straight back to `fetch`.
 */
/** Exactly what a `RequestInit.headers` can be — derived, never restated, so a
 *  runtime/lib change cannot desync this signature from its only call site. */
type HeaderSource = NonNullable<RequestInit["headers"]>

export const stripCrossOriginHeaders = (
  headers: HeaderSource | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  const drop = new Set(CROSS_ORIGIN_STRIP_HEADERS)
  const put = (k: string, v: string): void => {
    if (!drop.has(k.trim().toLowerCase())) out[k] = v
  }
  if (headers === undefined) return out
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      put(k, v)
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const pair of headers as ReadonlyArray<ReadonlyArray<string>>) {
      put(pair[0] ?? "", pair[1] ?? "")
    }
    return out
  }
  // Record form. A value typed `string | readonly string[]` (the multi-value
  // shape some runtimes admit) is joined the way HTTP would send it, so a
  // dropped header is dropped whatever its arity.
  for (const [k, v] of Object.entries(headers as Record<string, string | readonly string[]>)) {
    put(k, Array.isArray(v) ? v.join(", ") : (v as string))
  }
  return out
}
