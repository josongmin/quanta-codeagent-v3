/**
 * ADR-0422 — semantic-search-backed `SymbolLookupSemanticPort` adapter.
 *
 * Adapts the `@/runner/assemble/search-index-backend` semantic backend
 * (`SemanticIndex.query(vec, k)` + the wire's `IndexEmbed`) into the narrow
 * {@link SymbolLookupSemanticPort} the ADR-0418 `createSymbolResolver`
 * consumes as the FALLBACK strategy (used when LSP is unavailable / misses).
 *
 * Slice-fence: this is an agent-slice adapter that consumes the narrow,
 * DUCK-TYPED `SemanticQueryPort` shape declared locally (single `query`
 * method, structurally identical to `SemanticIndex`) plus an `embed`
 * function. The composition root (which is allowed to compose
 * `@/runner` engines) builds the concrete backend and passes its `.port` +
 * the wire's `IndexEmbed` here — so this module itself does NOT import
 * `@/runner`, keeping the agent slice import-clean.
 *
 * Lookup: embed the symbol NAME into a query vector, probe the index for the
 * top-k chunks, and project each `SearchHit` into a `SymbolHit` using its
 * `metadata.path` + `metadata.startLine`. A hit whose metadata lacks a usable
 * path is dropped (it cannot be rendered as a `file:line` reference).
 *
 * NO-THROW: a thrown / rejected embed or query maps to `null`. An empty
 * result maps to `null` too (so `auto` priority treats it as a miss).
 */

import { logger } from "@/shared"
import type { SymbolHit, SymbolLookupSemanticPort } from "./symbol-resolver"

/** One semantic hit — the minimal subset of the pipeline `SearchHit` this
 *  adapter reads (id + text + path/line metadata). Declared locally so the
 *  agent slice does not import `@/retrieval`. */
export interface SemanticSearchHitLike {
  readonly id: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Vector index probed with a pre-computed embedding. Structurally identical
 *  to `@/retrieval/pipeline`'s `SemanticIndex` and the `SemanticBackend.port`
 *  the search wire builds. */
export interface SemanticQueryPort {
  query(vec: readonly number[], k: number): Promise<readonly SemanticSearchHitLike[]>
}

/** Embed a single string into a dense vector (the wire's `IndexEmbed`). */
export type SymbolEmbed = (text: string) => Promise<readonly number[]>

/** Options for {@link createSemanticSymbolLookup}. */
export interface SemanticSymbolLookupOptions {
  /** Vector index (e.g. `buildSemanticBackend(...).port`). */
  readonly index: SemanticQueryPort
  /** Embedder (e.g. `selectIndexEmbedder(env)`). MUST match the embedder the
   *  index was upserted with, exactly as the search wire requires. */
  readonly embed: SymbolEmbed
  /** Top-k probed from the index. Default 5. `<= 0` ⇒ default. */
  readonly topK?: number
}

/** Vector index probe size. Matches the resolver's `DEFAULT_MAX_HITS=5` so the
 *  semantic strategy contributes its full quota to the merged hit list without
 *  over-probing the backend on every name. Tune via `topK`. */
const DEFAULT_TOP_K = 5

const metaString = (v: unknown): string => (typeof v === "string" ? v : "")
const metaNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Project a semantic hit into a `SymbolHit`. Returns `null` when no usable
 *  path is present (cannot render a `file:line` reference). */
const toHit = (h: SemanticSearchHitLike): SymbolHit | null => {
  const meta = h.metadata ?? {}
  const path = metaString(meta.path)
  if (path.length === 0) return null
  const startLine = metaNumber(meta.startLine)
  const line = startLine > 0 ? startLine : 1
  const snippet = typeof h.text === "string" ? (h.text.split("\n", 1)[0] ?? "") : ""
  return snippet.length > 0 ? { path, line, snippet } : { path, line }
}

/**
 * Build a {@link SymbolLookupSemanticPort} over a vector index + embedder.
 *
 * @param opts — index + embed (+ optional top-k).
 */
export const createSemanticSymbolLookup = (
  opts: SemanticSymbolLookupOptions,
): SymbolLookupSemanticPort => {
  const k =
    typeof opts.topK === "number" && Number.isFinite(opts.topK) && opts.topK > 0
      ? Math.floor(opts.topK)
      : DEFAULT_TOP_K
  return {
    findSymbol: async (name: string): Promise<readonly SymbolHit[] | null> => {
      if (typeof name !== "string" || name.length === 0) return null
      try {
        const vec = await opts.embed(name)
        if (!Array.isArray(vec) || vec.length === 0) return null
        const hits = await opts.index.query(vec, k)
        if (hits === null || !Array.isArray(hits) || hits.length === 0) return null
        const projected = hits.map(toHit).filter((h): h is SymbolHit => h !== null)
        return projected.length > 0 ? projected : null
      } catch (e) {
        logger.warn(`mention.symbol-lookup-semantic: ${(e as Error).message}`)
        return null
      }
    },
  }
}
