/**
 * In-memory adapter for {@link SemanticIndex} (ADR-0254).
 *
 *   - Backing store: `Map<id, { doc, vec }>`.
 *   - Cosine similarity, deterministic tie-break (score desc, id asc).
 *   - Top-k by full sort + slice — adequate at MVP scale; HNSW / IVF are
 *     deliberate holds (catalog).
 *   - Zero-norm vector returns score 0 (degenerate but typed — NaN never
 *     crosses the boundary).
 *
 * Pure aside from the injected {@link Embedder} which owns all I/O.
 */

import { err, ok, type Result } from "@/shared"
import type { Embedder } from "./embed-port"
import type { SemanticIndex } from "./port"
import type { Document, EmbeddingVector, SearchError, SearchHit } from "./types"

interface Entry {
  readonly doc: Document
  readonly vec: EmbeddingVector
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 when either
 * vector has zero norm — keeps the score domain bounded and avoids NaN
 * leaking into the public `SearchHit.score`.
 */
const cosine = (a: EmbeddingVector, b: EmbeddingVector): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const len = a.length
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Build an in-memory `SemanticIndex` backed by the supplied embedder. */
export const createInMemoryIndex = (embedder: Embedder): SemanticIndex => {
  const store = new Map<string, Entry>()

  const expectedDim = (): number => embedder.dim()

  const indexDocs = async (docs: readonly Document[]): Promise<Result<void, SearchError>> => {
    const dim = expectedDim()
    for (const d of docs) {
      const r = await embedder.embed(d.text)
      if (!r.ok) {
        if (r.error.kind === "empty-text") return err({ kind: "empty-text" })
        return err({ kind: "embed-failed", cause: r.error.cause })
      }
      const vec = r.value
      if (vec.length !== dim) {
        return err({ kind: "dim-mismatch", expected: dim, actual: vec.length })
      }
      store.set(d.id, { doc: d, vec })
    }
    return ok(undefined)
  }

  /** Validate the (text, k) tuple. Returns `null` when the inputs are
   *  acceptable; otherwise a typed `SearchError`. Lifted into its own
   *  helper to keep `query` below the cognitive-complexity threshold. */
  const validateInputs = (text: string, k: number): SearchError | null => {
    if (text === "") return { kind: "empty-text" }
    if (!Number.isFinite(k) || k < 0 || !Number.isInteger(k)) {
      return { kind: "invalid-k", k }
    }
    return null
  }

  /** Score every entry against `qvec`, sort by `(score desc, id asc)`,
   *  and slice the top `k`. Pure function — does not touch the embedder. */
  const rankTopK = (qvec: EmbeddingVector, k: number): readonly SearchHit[] => {
    type Scored = { id: string; score: number; doc: Document }
    const scored: Scored[] = []
    for (const [id, entry] of store) {
      scored.push({ id, score: cosine(qvec, entry.vec), doc: entry.doc })
    }
    // Deterministic tie-break: score desc, then id asc.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return scored
      .slice(0, k)
      .map<SearchHit>((s) =>
        s.doc.metadata !== undefined
          ? { id: s.id, score: s.score, text: s.doc.text, metadata: s.doc.metadata }
          : { id: s.id, score: s.score, text: s.doc.text },
      )
  }

  const query = async (
    text: string,
    k: number,
  ): Promise<Result<readonly SearchHit[], SearchError>> => {
    const validation = validateInputs(text, k)
    if (validation !== null) return err(validation)
    if (k === 0) return ok([])

    // Embed BEFORE the empty-store short-circuit so embedder failures
    // surface to the caller even when the corpus happens to be empty —
    // otherwise a misconfigured embedder hides until the index is
    // populated, then crashes the first real query.
    const r = await embedder.embed(text)
    if (!r.ok) {
      if (r.error.kind === "empty-text") return err({ kind: "empty-text" })
      return err({ kind: "embed-failed", cause: r.error.cause })
    }
    const qvec = r.value
    const dim = expectedDim()
    if (qvec.length !== dim) {
      return err({ kind: "dim-mismatch", expected: dim, actual: qvec.length })
    }
    if (store.size === 0) return ok([])
    return ok(rankTopK(qvec, k))
  }

  return {
    index: indexDocs,
    query,
    clear: () => {
      store.clear()
    },
    size: () => store.size,
  }
}
