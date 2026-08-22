/**
 * `braveSearchProvider` — first concrete impl of the `WebSearchProvider`
 * closed-port introduced in ADR-0127. Backed by the Brave Search REST API
 * (https://api.search.brave.com/res/v1/web/search).
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `../search` (the port). NO `@/agent`, `@/llm`,
 *     `@/permission`, `@/storage`, `@/memory`, `@/stream`. Pure HTTP —
 *     no global state, no singletons.
 *   - DI seam: `braveSearchProvider({ apiKey, fetcher })` lets tests inject
 *     a fake `fetch` and lets the host wire any `apiKey` source
 *     (env / vault / OS keychain). The provider never reads `process.env`
 *     itself — keys are constructor-injected only.
 *
 * Why Brave (vs Google / Bing / SerpAPI / scraping)?
 *   1. Free tier exists (no payment up-front).
 *   2. Typed JSON response — no HTML scraping, no per-page rate dance.
 *   3. Commercial-friendly TOS.
 *   4. Anthropic uses it for their own WebSearch backend (parity with the
 *      reference modern coding agent).
 *
 * No-throw contract: this provider may throw `BraveSearchError` for HTTP
 * non-2xx and JSON-parse failures. The `webSearchTool` boundary catches
 * provider throws and converts to typed ok:false (per ADR-0127). Callers
 * that use this provider OUTSIDE the tool boundary must be aware of the
 * throw shape.
 *
 * Graceful degrade: a 200 response missing `web.results` (e.g. a query
 * with literally zero matches in Brave's index) maps to an empty hit
 * array — NOT an error. The downstream `webSearchTool` formats `0
 * results for "<query>"` exactly as designed for empty searches.
 */

import { errMessage, isRecord } from "@/shared"
import type { WebSearchHit, WebSearchProvider } from "../search"
/** Default Brave Search REST endpoint. Overridable for tests (in-process
 *  fake) and for self-hosted / reverse-proxy deployments. */
export const BRAVE_DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

/** Lower bound on `count` accepted by the Brave API. We clamp `limit`
 *  into this range so a caller passing `0` or a negative still issues a
 *  well-formed request rather than producing an API 400. */
const BRAVE_COUNT_MIN = 1

/** Upper bound on `count` accepted by the Brave API (per their docs).
 *  Matches `WEB_SEARCH_MAX_LIMIT` in the port — but we clamp here too in
 *  case a caller bypasses the tool boundary. */
const BRAVE_COUNT_MAX = 20

/** Construction options. `apiKey` is REQUIRED — the provider never reads
 *  `process.env` itself; the host (CLI / Web surface) is responsible for
 *  sourcing it from `BRAVE_SEARCH_API_KEY` env, an OS keychain, or any
 *  other secure store. */
export interface BraveSearchOpts {
  /** API key — from `BRAVE_SEARCH_API_KEY` env or explicit injection.
   *  Required at construction; never logged. */
  readonly apiKey: string
  /** Override the endpoint (default: {@link BRAVE_DEFAULT_ENDPOINT}). */
  readonly endpoint?: string
  /** Injected fetcher (test seam). Default = `globalThis.fetch`. */
  readonly fetcher?: typeof fetch
  /** Country code for region-biased results (default `"us"`). */
  readonly country?: string
  /** Safesearch level (default `"moderate"`). */
  readonly safesearch?: "off" | "moderate" | "strict"
}

/** Typed error for Brave-specific failures. Carries the HTTP status (when
 *  applicable) and a short body excerpt (first non-empty line, capped at
 *  200 chars) so the caller can log without echoing megabytes of HTML. */
export class BraveSearchError extends Error {
  override readonly name = "BraveSearchError"
  readonly status: number | undefined
  readonly bodyExcerpt: string | undefined

  constructor(message: string, opts?: { status?: number; bodyExcerpt?: string }) {
    super(message)
    if (opts?.status !== undefined) this.status = opts.status
    if (opts?.bodyExcerpt !== undefined) this.bodyExcerpt = opts.bodyExcerpt
  }
}

/** Clamp `n` into the inclusive `[lo, hi]` range. `NaN` / non-finite
 *  collapses to `lo` (we never issue a malformed `count=`). */
const clamp = (n: number, lo: number, hi: number): number => {
  if (!Number.isFinite(n)) return lo
  const i = Math.trunc(n)
  if (i < lo) return lo
  if (i > hi) return hi
  return i
}

/** First non-empty line of `body`, capped at 200 chars — for inclusion
 *  in `BraveSearchError.bodyExcerpt`. */
const firstLineExcerpt = (body: string): string => {
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
    }
  }
  return ""
}

/** Minimal shape we read from Brave's response. We do NOT model the full
 *  schema (the API has many fields — `mixed`, `news`, `videos`, `query`,
 *  …) — only the `web.results[]` slice that maps to `WebSearchHit`.
 *  Unknown / missing fields are tolerated (graceful empty array). */
interface BraveWebResult {
  readonly title?: unknown
  readonly url?: unknown
  readonly description?: unknown
}

/** Type-guard: a value is a plain object with at least one accessible
 *  property (used before reading `.web.results`). */
/** Coerce one Brave result row into a `WebSearchHit`. Missing strings
 *  collapse to `""` — the formatter happily renders a hit with an empty
 *  title or snippet, and dropping the row would mis-count against the
 *  caller's `limit`. */
const toHit = (row: BraveWebResult): WebSearchHit => {
  const title = typeof row.title === "string" ? row.title : ""
  const url = typeof row.url === "string" ? row.url : ""
  const snippet = typeof row.description === "string" ? row.description : ""
  return { title, url, snippet }
}

/** Build the request URL with query-string params. We hand-encode rather
 *  than using `URLSearchParams` to keep the param order stable (test
 *  assertions match exact substrings of the URL). */
const buildUrl = (
  endpoint: string,
  query: string,
  count: number,
  country: string,
  safesearch: string,
): string => {
  const q = encodeURIComponent(query)
  const sep = endpoint.includes("?") ? "&" : "?"
  return `${endpoint}${sep}q=${q}&count=${count}&country=${country}&safesearch=${safesearch}`
}

/** Issue the HTTP GET. Wraps network failures as `BraveSearchError`. */
const doFetch = async (
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> => {
  // `fetch` accepts `signal: undefined` but we only spread when present
  // to stay exactOptionalPropertyTypes-clean.
  const init: RequestInit =
    signal !== undefined ? { method: "GET", headers, signal } : { method: "GET", headers }
  try {
    return await fetcher(url, init)
  } catch (err) {
    // Network errors (DNS failure, connection refused, abort, TLS) — wrap
    // as a `BraveSearchError` so the caller has a uniform throw shape.
    const msg = errMessage(err)
    throw new BraveSearchError(`network: ${msg}`)
  }
}

/** Convert a non-2xx `Response` into a `BraveSearchError` throw. Reads
 *  the body for a short diagnostic excerpt — body-read failure is
 *  non-fatal (we still throw with status alone). */
const throwNonOk = async (response: Response): Promise<never> => {
  let bodyExcerpt = ""
  try {
    bodyExcerpt = firstLineExcerpt(await response.text())
  } catch {
    // Body read failure — proceed with empty excerpt.
  }
  throw new BraveSearchError(
    `Brave search HTTP ${response.status}${bodyExcerpt.length > 0 ? `: ${bodyExcerpt}` : ""}`,
    { status: response.status, bodyExcerpt },
  )
}

/** Parse JSON body; throws `BraveSearchError("parse-failed: ...")`. */
const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch (err) {
    const msg = errMessage(err)
    throw new BraveSearchError(`parse-failed: ${msg}`)
  }
}

/** Extract up to `count` hits from a parsed Brave payload. Tolerates
 *  every missing-shape case (`payload.web.results` absent / wrong type)
 *  with a graceful empty array — NEVER throws. */
const extractHits = (payload: unknown, count: number): WebSearchHit[] => {
  if (!isRecord(payload)) return []
  const web = payload.web
  if (!isRecord(web)) return []
  const results = web.results
  if (!Array.isArray(results)) return []
  const hits: WebSearchHit[] = []
  for (const row of results) {
    if (hits.length >= count) break
    if (isRecord(row)) hits.push(toHit(row as BraveWebResult))
  }
  return hits
}

/** Closed-port impl backed by the Brave Search REST API. Pure HTTP — no
 *  global state, no singletons, no env reads. */
export const braveSearchProvider = (opts: BraveSearchOpts): WebSearchProvider => {
  const endpoint = opts.endpoint ?? BRAVE_DEFAULT_ENDPOINT
  const fetcher = opts.fetcher ?? globalThis.fetch
  const country = opts.country ?? "us"
  const safesearch = opts.safesearch ?? "moderate"

  // Headers per Brave docs. The API key MUST travel in
  // `X-Subscription-Token` (never as a URL param) — keeps it out of proxy
  // logs and referrer headers.
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": opts.apiKey,
  }

  return {
    async search(
      query: string,
      limit: number,
      signal?: AbortSignal,
    ): Promise<readonly WebSearchHit[]> {
      const count = clamp(limit, BRAVE_COUNT_MIN, BRAVE_COUNT_MAX)
      const url = buildUrl(endpoint, query, count, country, safesearch)
      const response = await doFetch(fetcher, url, headers, signal)
      if (!response.ok) await throwNonOk(response)
      const payload = await parseJson(response)
      return extractHits(payload, count)
    },
  }
}
