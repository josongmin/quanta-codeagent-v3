/**
 * LanceDB REST VectorStore adapter — ADR-0261.
 *
 * Targets a Lance-compatible HTTP server (for example lance-rest,
 * `lancedb serve`, or a compatible test shim):
 *
 *   POST {baseURL}/v1/table/{table}/upsert   { docs: [...] }
 *   POST {baseURL}/v1/table/{table}/query    { vector, k, filter? }    → { hits }
 *   POST {baseURL}/v1/table/{table}/delete   { ids }
 *
 * Transport (`fetch`) is INJECTED per ADR-0159 (slice depends on `@/shared`
 * only). The contract is shape-only — the adapter normalises responses to
 * `StoredHit[]`.
 */
import { err, errMessage, ok, type Result } from "@/shared"
import { makeHit } from "./_filter"
import type { VectorStore } from "./port"
import type { Filter, StoreCapabilities, StoredDoc, StoredHit, StoreError } from "./types"

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface LanceStoreOptions {
  readonly baseURL: string
  readonly table: string
  readonly apiKey?: string | undefined
  readonly maxDim?: number
  readonly fetchImpl?: FetchFn
}

const DEFAULT_MAX_DIM = 4096

const post = async (
  fetchImpl: FetchFn,
  url: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<Result<unknown, StoreError>> => {
  let res: Response
  try {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (apiKey !== undefined && apiKey !== "") headers.authorization = `Bearer ${apiKey}`
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) })
  } catch (e) {
    return err({ kind: "network", detail: errMessage(e) })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return err({ kind: "http-error", status: res.status, body: text })
  }
  try {
    return ok(await res.json())
  } catch (e) {
    return err({ kind: "invalid-response", detail: errMessage(e) })
  }
}

interface LanceHit {
  readonly id?: string
  readonly score?: number
  readonly metadata?: unknown
}

const decodeHits = (parsed: { hits?: LanceHit[] }): Result<StoredHit[], StoreError> => {
  const hits = parsed.hits
  if (hits === undefined || !Array.isArray(hits)) {
    return err({ kind: "invalid-response", detail: "missing hits[]" })
  }
  const out: StoredHit[] = []
  for (const h of hits) {
    if (typeof h.id !== "string" || typeof h.score !== "number") {
      return err({ kind: "invalid-response", detail: "hit missing id/score" })
    }
    const meta =
      h.metadata !== undefined && h.metadata !== null
        ? (h.metadata as Readonly<Record<string, string | number | boolean>>)
        : undefined
    out.push(makeHit(h.id, h.score, meta))
  }
  return ok(out)
}

export const createLanceVectorStore = (opts: LanceStoreOptions): VectorStore => {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM
  const base = `${opts.baseURL.replace(/\/$/, "")}/v1/table/${encodeURIComponent(opts.table)}`

  return {
    async upsert(input: readonly StoredDoc[]): Promise<Result<void, StoreError>> {
      const docs = input.map((d) =>
        d.metadata === undefined
          ? { id: d.id, vector: [...d.vector] }
          : { id: d.id, vector: [...d.vector], metadata: d.metadata },
      )
      const r = await post(fetchImpl, `${base}/upsert`, { docs }, opts.apiKey)
      if (!r.ok) return r
      return ok(undefined)
    },
    async query(
      vec: readonly number[],
      k: number,
      filter?: Filter,
    ): Promise<Result<readonly StoredHit[], StoreError>> {
      if (k <= 0) return ok([])
      const body = filter === undefined ? { vector: [...vec], k } : { vector: [...vec], k, filter }
      const r = await post(fetchImpl, `${base}/query`, body, opts.apiKey)
      if (!r.ok) return r
      return decodeHits(r.value as { hits?: LanceHit[] })
    },
    async delete(ids: readonly string[]): Promise<Result<void, StoreError>> {
      const r = await post(fetchImpl, `${base}/delete`, { ids: [...ids] }, opts.apiKey)
      if (!r.ok) return r
      return ok(undefined)
    },
    capabilities(): StoreCapabilities {
      return { distMetric: "cosine", maxDim, persistent: true }
    },
  }
}
