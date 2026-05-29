/**
 * `duckduckgoSearchProvider` — fallback `WebSearchProvider` for hosts that
 * lack a Brave API key.
 *
 * IMPORTANT: this is a **limited** provider. DuckDuckGo does NOT offer an
 * official full web-search API. The Instant Answer endpoint we use
 * (`https://api.duckduckgo.com/?q=...&format=json`) returns curated
 * topics + disambiguations + a single Abstract — NOT a ranked web result
 * list. For most queries you will get a handful of `RelatedTopics`
 * entries (often 0). Prefer {@link braveSearchProvider} whenever an API
 * key is available.
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `../search` (the port). Pure HTTP — no global state.
 *   - DI seam: `duckduckgoSearchProvider({ fetcher })` lets tests inject
 *     a fake `fetch`. No API key needed; no env reads.
 *
 * No-throw contract: this provider throws `Error("network: <msg>")` on
 * fetch failures and parse failures. The `webSearchTool` boundary
 * (ADR-0127) catches and converts to typed ok:false.
 *
 * Graceful degrade: missing / empty `RelatedTopics` collapses to `[]`,
 * NOT an error — DDG returns this for the majority of queries.
 */

import { errMessage } from "@/shared"
import type { WebSearchHit, WebSearchProvider } from "../search"
/** Default DuckDuckGo Instant Answer endpoint. */
export const DDG_DEFAULT_ENDPOINT = "https://api.duckduckgo.com/"

/** Construction options. All fields are optional — DDG needs no API key. */
export interface DuckDuckGoSearchOpts {
  /** Override the endpoint (default: {@link DDG_DEFAULT_ENDPOINT}). */
  readonly endpoint?: string
  /** Injected fetcher (test seam). Default = `globalThis.fetch`. */
  readonly fetcher?: typeof fetch
}

/** Minimal shape we read from the Instant Answer payload. We model only
 *  the `RelatedTopics[]` slice we map to hits — every other field
 *  (`Abstract`, `Heading`, `Image`, …) is ignored. */
interface DdgRelatedTopic {
  readonly Text?: unknown
  readonly FirstURL?: unknown
  /** Nested grouping: when DDG can't pick one canonical topic it nests
   *  the children under a `Topics: [...]` array on a header row. We
   *  flatten one level deep — same posture as a typical UI render. */
  readonly Topics?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Coerce one related-topic row to a `WebSearchHit`. Title falls back to
 *  the URL when `Text` is missing so the formatter still has something
 *  to display. */
const toHit = (row: DdgRelatedTopic): WebSearchHit | null => {
  const url = typeof row.FirstURL === "string" ? row.FirstURL : ""
  if (url.length === 0) return null
  const text = typeof row.Text === "string" ? row.Text : ""
  // DDG's `Text` field doubles as both title and snippet. We keep the
  // full text as snippet and lift the first sentence as title; if there
  // is no sentence boundary, title === snippet.
  const dot = text.indexOf(" – ")
  const title = text.length === 0 ? url : dot > 0 ? text.slice(0, dot) : text
  return { title, url, snippet: text }
}

/** Flatten one level of nested `Topics: [...]` into the result stream. */
const flatten = (rows: readonly unknown[]): DdgRelatedTopic[] => {
  const out: DdgRelatedTopic[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (Array.isArray(row.Topics)) {
      for (const nested of row.Topics) {
        if (isRecord(nested)) out.push(nested as DdgRelatedTopic)
      }
    } else {
      out.push(row as DdgRelatedTopic)
    }
  }
  return out
}

/** Issue the HTTP GET. Wraps network failures with a typed message. */
const doFetch = async (
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response> => {
  const init: RequestInit =
    signal !== undefined
      ? { method: "GET", headers: { Accept: "application/json" }, signal }
      : { method: "GET", headers: { Accept: "application/json" } }
  try {
    return await fetcher(url, init)
  } catch (err) {
    const msg = errMessage(err)
    throw new Error(`duckduckgo network: ${msg}`)
  }
}

/** Parse JSON body; throws `Error("duckduckgo parse-failed: ...")`. */
const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch (err) {
    const msg = errMessage(err)
    throw new Error(`duckduckgo parse-failed: ${msg}`)
  }
}

/** Extract up to `cap` hits from a parsed DDG payload. Tolerates every
 *  missing-shape case with a graceful empty array — NEVER throws. */
const extractHits = (payload: unknown, cap: number): WebSearchHit[] => {
  if (!isRecord(payload)) return []
  const related = payload.RelatedTopics
  if (!Array.isArray(related)) return []
  const flat = flatten(related)
  const hits: WebSearchHit[] = []
  for (const row of flat) {
    if (hits.length >= cap) break
    const hit = toHit(row)
    if (hit !== null) hits.push(hit)
  }
  return hits
}

/** Fallback closed-port impl backed by the DuckDuckGo Instant Answer
 *  endpoint. **Limited** — returns curated topics, not a full web search.
 *  Prefer {@link braveSearchProvider} when an API key is available. */
export const duckduckgoSearchProvider = (opts?: DuckDuckGoSearchOpts): WebSearchProvider => {
  const endpoint = opts?.endpoint ?? DDG_DEFAULT_ENDPOINT
  const fetcher = opts?.fetcher ?? globalThis.fetch

  return {
    async search(
      query: string,
      limit: number,
      signal?: AbortSignal,
    ): Promise<readonly WebSearchHit[]> {
      // DDG ignores unknown params silently; no SafeSearch / region knobs
      // exposed here (the IA endpoint doesn't honor them anyway).
      // `no_html=1` + `no_redirect=1` keep the payload typed JSON only.
      const q = encodeURIComponent(query)
      const sep = endpoint.includes("?") ? "&" : "?"
      const url = `${endpoint}${sep}q=${q}&format=json&no_html=1&no_redirect=1`

      const response = await doFetch(fetcher, url, signal)
      if (!response.ok) throw new Error(`duckduckgo HTTP ${response.status}`)
      const payload = await parseJson(response)
      const cap = Math.max(0, Math.trunc(limit))
      return extractHits(payload, cap)
    },
  }
}
