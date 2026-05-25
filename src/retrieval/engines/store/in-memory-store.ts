/**
 * In-memory cosine VectorStore — ADR-0261 (re-exposed in the new
 * registry-aware shape; ADR-0254's sibling store is unchanged).
 *
 * Storage: `Map<id, { vector, metadata? }>`. Query: full scan + cosine.
 * O(n*dim) per query — fine for corpora ≤ ~10k docs.
 *
 * Pure / no I/O / no clock. `dim` is fixed at construction time; the
 * first `upsert` may set it (when constructed without a `dim` option),
 * after which any vector of a different length is rejected with
 * `dim-mismatch`.
 */
import { err, ok, type Result } from "@/shared"
import { makeHit, matchesFilter } from "./_filter"
import type { VectorStore } from "./port"
import type { Filter, StoreCapabilities, StoredDoc, StoredHit, StoreError } from "./types"

const DEFAULT_MAX_DIM = 4096

export interface InMemoryStoreOptions {
  readonly dim?: number
  readonly maxDim?: number
}

/** Cosine similarity in [-1, 1]; returns 0 on length mismatch or zero norm. */
const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return Number.isFinite(c) ? c : 0
}

export const createInMemoryVectorStore = (opts: InMemoryStoreOptions = {}): VectorStore => {
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM
  let dim: number | undefined = opts.dim
  const docs = new Map<
    string,
    { vector: readonly number[]; metadata?: Readonly<Record<string, string | number | boolean>> }
  >()

  const checkDim = (v: readonly number[]): StoreError | null => {
    if (dim === undefined) {
      if (v.length === 0 || v.length > maxDim) {
        return { kind: "dim-mismatch", expected: maxDim, got: v.length }
      }
      dim = v.length
      return null
    }
    if (v.length !== dim) return { kind: "dim-mismatch", expected: dim, got: v.length }
    return null
  }

  return {
    async upsert(input: readonly StoredDoc[]): Promise<Result<void, StoreError>> {
      for (const d of input) {
        const e = checkDim(d.vector)
        if (e !== null) return err(e)
      }
      for (const d of input) {
        docs.set(
          d.id,
          d.metadata === undefined
            ? { vector: [...d.vector] }
            : { vector: [...d.vector], metadata: { ...d.metadata } },
        )
      }
      return ok(undefined)
    },
    async query(
      vec: readonly number[],
      k: number,
      filter?: Filter,
    ): Promise<Result<readonly StoredHit[], StoreError>> {
      if (dim !== undefined && vec.length !== dim) {
        return err({ kind: "dim-mismatch", expected: dim, got: vec.length })
      }
      if (k <= 0) return ok([])
      const out: StoredHit[] = []
      for (const [id, entry] of docs) {
        if (!matchesFilter(entry.metadata, filter)) continue
        out.push(makeHit(id, cosine(vec, entry.vector), entry.metadata))
      }
      out.sort((a, b) => b.score - a.score)
      return ok(out.slice(0, k))
    },
    async delete(ids: readonly string[]): Promise<Result<void, StoreError>> {
      for (const id of ids) {
        if (!docs.has(id)) return err({ kind: "not-found", id })
      }
      for (const id of ids) docs.delete(id)
      return ok(undefined)
    },
    capabilities(): StoreCapabilities {
      return { distMetric: "cosine", maxDim, persistent: false }
    },
  }
}
