/**
 * Cohere rerank adapter — `rerank-v3.5` (ADR-0262).
 *
 * REST contract:
 *   POST https://api.cohere.com/v1/rerank
 *   Headers: Authorization: Bearer <apiKey>, Content-Type: application/json
 *   Body: { model, query, documents: string[], top_n }
 *   Resp: { results: [{ index, relevance_score }, ...] }
 *
 * HTTP transport is INJECTED via {@link CohereHttp}. A `defaultCohereHttp`
 * factory wires raw `fetch` for production; tests inject a fake. The slice
 * NEVER imports `cohere-ai` (vendor SDKs are blocked).
 *
 * Boundary behavior is the canonical Reranker contract — see port.ts.
 */
import { err, ok, type Result } from "@/shared"
import type { Reranker } from "./port"
import type { RerankError, RerankedHit, RerankerCapabilities } from "./types"

export interface CohereRerankRequest {
  readonly model: string
  readonly query: string
  readonly documents: readonly string[]
  readonly top_n: number
}

export interface CohereRerankResult {
  readonly index: number
  readonly relevance_score: number
}

export interface CohereRerankResponse {
  readonly results: readonly CohereRerankResult[]
}

export interface CohereHttp {
  rerank(body: CohereRerankRequest, opts?: { signal?: AbortSignal }): Promise<CohereRerankResponse>
}

export interface CohereRerankerOptions<T> {
  readonly apiKey: string
  readonly http: CohereHttp
  /** Map an input hit to the document text Cohere will score. */
  readonly documentOf: (hit: T) => string
  /** Defaults to `rerank-v3.5` — the current published GA model. */
  readonly model?: string
  /** Override the published cap (Cohere v1 ≤ 1000). */
  readonly maxDocsPerCall?: number
  /** Override the published cap (Cohere ≤ 4096 tokens per call). */
  readonly maxInputTokens?: number
}

const DEFAULT_MODEL = "rerank-v3.5"
// Cohere v1 rerank docs: up to 1000 documents per call.
const DEFAULT_MAX_DOCS = 1000
// Cohere v3.5: ~4096 tokens per request (query + per-document budget).
const DEFAULT_MAX_TOKENS = 4096

const statusOf = (e: unknown): number | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const s = (e as { status?: unknown }).status
  return typeof s === "number" ? s : undefined
}

const classify = (e: unknown): RerankError => {
  const status = statusOf(e)
  if (status === 401 || status === 403) return { kind: "auth-failed" }
  if (status === 429) return { kind: "rate-limited" }
  const message = e instanceof Error ? e.message : String(e)
  return { kind: "transport", message }
}

export const createCohereReranker = <T = unknown>(opts: CohereRerankerOptions<T>): Reranker<T> => {
  const model = opts.model ?? DEFAULT_MODEL
  const maxDocsPerCall = opts.maxDocsPerCall ?? DEFAULT_MAX_DOCS
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_TOKENS

  const caps: RerankerCapabilities = {
    provider: "cohere",
    model,
    maxDocsPerCall,
    maxInputTokens,
  }

  return {
    capabilities: () => caps,
    async rerank(
      query: string,
      hits: readonly T[],
      k: number,
    ): Promise<Result<readonly RerankedHit<T>[], RerankError>> {
      if (k <= 0 || hits.length === 0) return ok([])
      if (query.trim().length === 0) return err({ kind: "empty-query" })
      if (hits.length > maxDocsPerCall) {
        return err({ kind: "too-many-docs", limit: maxDocsPerCall, given: hits.length })
      }
      const documents = hits.map(opts.documentOf)
      const top_n = Math.min(k, hits.length)
      try {
        const resp = await opts.http.rerank({ model, query, documents, top_n })
        const out: RerankedHit<T>[] = []
        for (const r of resp.results) {
          const h = hits[r.index]
          if (h === undefined) continue
          out.push({ originalIndex: r.index, score: r.relevance_score, hit: h })
        }
        // Defensive: vendor SHOULD return sorted DESC by relevance, but the
        // contract is "return in the order the vendor delivered" — sort
        // explicitly so the port owns the ordering invariant.
        out.sort((a, b) => b.score - a.score)
        return ok(out)
      } catch (e) {
        return err(classify(e))
      }
    },
  }
}

/**
 * Production HTTP adapter — raw `fetch`, no SDK. Maps Cohere HTTP status
 * onto a `.status` property so {@link classify} can branch without
 * re-parsing message text.
 */
export const defaultCohereHttp = (opts: { apiKey: string; baseURL?: string }): CohereHttp => {
  const baseURL = opts.baseURL ?? "https://api.cohere.com"
  return {
    async rerank(body, callOpts) {
      const fetchOpts: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      }
      if (callOpts?.signal !== undefined) {
        // RequestInit's signal is typed AbortSignal | null in modern lib.dom;
        // the in-tree types may not perfectly align so assign via cast-free
        // mutation.
        ;(fetchOpts as { signal?: AbortSignal }).signal = callOpts.signal
      }
      const res = await fetch(`${baseURL}/v1/rerank`, fetchOpts)
      if (!res.ok) {
        const error: Error & { status?: number } = new Error(`Cohere rerank HTTP ${res.status}`)
        error.status = res.status
        throw error
      }
      return (await res.json()) as CohereRerankResponse
    },
  }
}
