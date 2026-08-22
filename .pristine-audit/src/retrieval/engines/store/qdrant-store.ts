/**
 * Qdrant REST VectorStore adapter — ADR-0261.
 *
 * Targets a Qdrant HTTP API (default `http://localhost:6333`):
 *
 *   PUT  {baseURL}/collections/{collection}/points       { points: [...] }
 *   POST {baseURL}/collections/{collection}/points/search { vector, limit, filter? }
 *   POST {baseURL}/collections/{collection}/points/delete { points: [ids] }
 *
 * Transport (`fetch`) is INJECTED per ADR-0159 — no `qdrant-client` import.
 */
import { err, errMessage, ok, type Result } from "@/shared"
import { makeHit } from "./_filter"
import type { VectorStore } from "./port"
import type { Filter, StoreCapabilities, StoredDoc, StoredHit, StoreError } from "./types"

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface QdrantStoreOptions {
  readonly baseURL?: string
  readonly collection: string
  readonly apiKey?: string | undefined
  readonly maxDim?: number
  readonly fetchImpl?: FetchFn
}

const DEFAULT_BASE = "http://localhost:6333"
const DEFAULT_MAX_DIM = 4096

const headersWith = (apiKey: string | undefined): Record<string, string> => {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (apiKey !== undefined && apiKey !== "") h["api-key"] = apiKey
  return h
}

const send = async (
  fetchImpl: FetchFn,
  url: string,
  method: "POST" | "PUT",
  body: unknown,
  apiKey: string | undefined,
): Promise<Result<unknown, StoreError>> => {
  let res: Response
  try {
    res = await fetchImpl(url, { method, headers: headersWith(apiKey), body: JSON.stringify(body) })
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

const toQdrantFilter = (filter: Filter | undefined): unknown => {
  if (filter?.equals === undefined) return undefined
  const must: Array<{ key: string; match: { value: string | number | boolean } }> = []
  for (const k in filter.equals) {
    must.push({ key: k, match: { value: filter.equals[k] as string | number | boolean } })
  }
  return { must }
}

interface QdrantHit {
  readonly id?: string | number
  readonly score?: number
  readonly payload?: unknown
}

const decodeOne = (h: QdrantHit): Result<StoredHit, StoreError> => {
  if (h.id === undefined || (typeof h.id !== "string" && typeof h.id !== "number")) {
    return err({ kind: "invalid-response", detail: "hit missing id" })
  }
  if (typeof h.score !== "number") {
    return err({ kind: "invalid-response", detail: "hit missing score" })
  }
  const meta =
    h.payload !== undefined && h.payload !== null
      ? (h.payload as Readonly<Record<string, string | number | boolean>>)
      : undefined
  return ok(makeHit(String(h.id), h.score, meta))
}

const decodeQdrantResult = (parsed: { result?: QdrantHit[] }): Result<StoredHit[], StoreError> => {
  const result = parsed.result
  if (result === undefined || !Array.isArray(result)) {
    return err({ kind: "invalid-response", detail: "missing result[]" })
  }
  const out: StoredHit[] = []
  for (const h of result) {
    const r = decodeOne(h)
    if (!r.ok) return r
    out.push(r.value)
  }
  return ok(out)
}

export const createQdrantVectorStore = (opts: QdrantStoreOptions): VectorStore => {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM
  const baseURL = (opts.baseURL ?? DEFAULT_BASE).replace(/\/$/, "")
  const base = `${baseURL}/collections/${encodeURIComponent(opts.collection)}`

  return {
    async upsert(input: readonly StoredDoc[]): Promise<Result<void, StoreError>> {
      const points = input.map((d) =>
        d.metadata === undefined
          ? { id: d.id, vector: [...d.vector] }
          : { id: d.id, vector: [...d.vector], payload: d.metadata },
      )
      const r = await send(fetchImpl, `${base}/points`, "PUT", { points }, opts.apiKey)
      if (!r.ok) return r
      return ok(undefined)
    },
    async query(
      vec: readonly number[],
      k: number,
      filter?: Filter,
    ): Promise<Result<readonly StoredHit[], StoreError>> {
      if (k <= 0) return ok([])
      const qFilter = toQdrantFilter(filter)
      const body: Record<string, unknown> = {
        vector: [...vec],
        limit: k,
        with_payload: true,
      }
      if (qFilter !== undefined) body.filter = qFilter
      const r = await send(fetchImpl, `${base}/points/search`, "POST", body, opts.apiKey)
      if (!r.ok) return r
      return decodeQdrantResult(r.value as { result?: QdrantHit[] })
    },
    async delete(ids: readonly string[]): Promise<Result<void, StoreError>> {
      const r = await send(
        fetchImpl,
        `${base}/points/delete`,
        "POST",
        { points: [...ids] },
        opts.apiKey,
      )
      if (!r.ok) return r
      return ok(undefined)
    },
    capabilities(): StoreCapabilities {
      return { distMetric: "cosine", maxDim, persistent: true }
    },
  }
}
