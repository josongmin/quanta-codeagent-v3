/**
 * Voyage rerank adapter — `rerank-2` (ADR-0262).
 *
 * REST contract:
 *   POST https://api.voyageai.com/v1/rerank
 *   Headers: Authorization: Bearer <apiKey>, Content-Type: application/json
 *   Body: { model, query, documents: string[], top_k }
 *   Resp: { data: [{ index, relevance_score }, ...] }
 *
 * HTTP transport is INJECTED via {@link VoyageHttp}. A `defaultVoyageHttp`
 * factory wires raw `fetch` for production; tests inject a fake. The slice
 * NEVER imports a Voyage SDK.
 *
 * Boundary behavior is the canonical Reranker contract — see port.ts.
 */
import { err, ok, type Result } from "@/shared"
import type { Reranker } from "./port"
import type { RerankError, RerankedHit, RerankerCapabilities } from "./types"

export interface VoyageRerankRequest {
  readonly model: string
  readonly query: string
  readonly documents: readonly string[]
  readonly top_k: number
}

export interface VoyageRerankResult {
  readonly index: number
  readonly relevance_score: number
}

export interface VoyageRerankResponse {
  readonly data: readonly VoyageRerankResult[]
}

export interface VoyageHttp {
  rerank(body: VoyageRerankRequest, opts?: { signal?: AbortSignal }): Promise<VoyageRerankResponse>
}

export interface VoyageRerankerOptions<T> {
  readonly apiKey: string
  readonly http: VoyageHttp
  readonly documentOf: (hit: T) => string
  readonly model?: string
  readonly maxDocsPerCall?: number
  readonly maxInputTokens?: number
}

const DEFAULT_MODEL = "rerank-2"
// Voyage rerank docs: up to 1000 documents per call.
const DEFAULT_MAX_DOCS = 1000
// Voyage rerank-2: 16K token total context per call.
const DEFAULT_MAX_TOKENS = 16_000

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

export const createVoyageReranker = <T = unknown>(opts: VoyageRerankerOptions<T>): Reranker<T> => {
  const model = opts.model ?? DEFAULT_MODEL
  const maxDocsPerCall = opts.maxDocsPerCall ?? DEFAULT_MAX_DOCS
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_TOKENS

  const caps: RerankerCapabilities = {
    provider: "voyage",
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
      const top_k = Math.min(k, hits.length)
      try {
        const resp = await opts.http.rerank({ model, query, documents, top_k })
        const out: RerankedHit<T>[] = []
        for (const r of resp.data) {
          const h = hits[r.index]
          if (h === undefined) continue
          out.push({ originalIndex: r.index, score: r.relevance_score, hit: h })
        }
        out.sort((a, b) => b.score - a.score)
        return ok(out)
      } catch (e) {
        return err(classify(e))
      }
    },
  }
}

export const defaultVoyageHttp = (opts: { apiKey: string; baseURL?: string }): VoyageHttp => {
  const baseURL = opts.baseURL ?? "https://api.voyageai.com"
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
        ;(fetchOpts as { signal?: AbortSignal }).signal = callOpts.signal
      }
      const res = await fetch(`${baseURL}/v1/rerank`, fetchOpts)
      if (!res.ok) {
        const error: Error & { status?: number } = new Error(`Voyage rerank HTTP ${res.status}`)
        error.status = res.status
        throw error
      }
      return (await res.json()) as VoyageRerankResponse
    },
  }
}
