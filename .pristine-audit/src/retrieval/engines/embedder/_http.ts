/**
 * Shared HTTP helpers for embedder adapters — ADR-0261.
 *
 * Each managed-vendor adapter (openai/voyage/cohere/ollama) shares the
 * same 4 concerns: parse `retry-after`, classify 4xx vs 429, parse JSON
 * defensively, classify `AbortError`. Centralising them keeps each
 * adapter's `embed()` body small and inside biome's cognitive-complexity
 * budget.
 */
import { err, errMessage, ok, type Result } from "@/shared"
import type { EmbedError } from "./types"

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Classify a thrown fetch error → EmbedError. */
export const classifyFetchError = (e: unknown): EmbedError => {
  const name = (e as { name?: string } | null)?.name
  if (name === "AbortError" || name === "TimeoutError") return { kind: "aborted" }
  return { kind: "network", detail: errMessage(e) }
}

/** Parse `retry-after` (seconds) into ms → rate-limited arm. */
export const rateLimitedFrom = (res: Response): EmbedError => {
  const ra = res.headers.get("retry-after")
  if (ra === null) return { kind: "rate-limited" }
  const ms = Number(ra) * 1000
  if (Number.isNaN(ms)) return { kind: "rate-limited" }
  return { kind: "rate-limited", retryAfterMs: ms }
}

/** Convert a non-2xx response into the right EmbedError arm. */
export const httpErrorFrom = async (res: Response): Promise<EmbedError> => {
  if (res.status === 429) return rateLimitedFrom(res)
  const body = await res.text().catch(() => "")
  return { kind: "http-error", status: res.status, body }
}

/** Parse a JSON response, returning an `invalid-response` EmbedError on parse failure. */
export const parseJsonOr = async <T>(res: Response): Promise<Result<T, EmbedError>> => {
  try {
    return ok((await res.json()) as T)
  } catch (e) {
    return err({ kind: "invalid-response", detail: errMessage(e) })
  }
}

/** Enforce per-input byte cap; first oversize input wins. */
export const checkInputBytes = (items: readonly string[], cap: number): EmbedError | null => {
  for (const s of items) {
    const bytes = Buffer.byteLength(s, "utf8")
    if (bytes > cap) return { kind: "input-too-large", bytes, cap }
  }
  return null
}

/** Build a `RequestInit` that includes `signal` only when defined (exactOptionalPropertyTypes-safe). */
export const buildInit = (
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): RequestInit => {
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }
  if (signal !== undefined) (init as { signal?: AbortSignal }).signal = signal
  return init
}

/**
 * Run the full embed RPC against the given URL: POST → http error / parse JSON
 * → return parsed value. Pure I/O plumbing — the caller decodes the parsed
 * shape into vectors. Lives here so each vendor `embed()` stays under biome's
 * cognitive-complexity budget.
 */
export const runEmbedRequest = async <T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: FetchFn,
): Promise<Result<T, EmbedError>> => {
  let res: Response
  try {
    res = await fetchImpl(url, buildInit(body, headers, signal))
  } catch (e) {
    return err(classifyFetchError(e))
  }
  if (!res.ok) return err(await httpErrorFrom(res))
  return parseJsonOr<T>(res)
}
