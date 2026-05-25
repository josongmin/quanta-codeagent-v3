/**
 * `SemanticIndex` — closed port for an embedding-backed retrieval index
 * (ADR-0254).
 *
 * All I/O methods return `Result<…, SearchError>` so failure crosses the
 * boundary as data. Synchronous accessors (`size`, `clear`) do not throw.
 *
 *   - `index(docs)` is idempotent by `id`. Re-indexing the same id
 *     overwrites the prior vector AND text (HELL-SS-07).
 *   - `query(text, k)`:
 *       * `k = 0`            ⇒ `ok([])` (HELL-SS-03)
 *       * empty corpus       ⇒ `ok([])` (HELL-SS-04)
 *       * empty text         ⇒ `err({ kind: "empty-text" })`
 *       * `k < 0`            ⇒ `err({ kind: "invalid-k", k })`
 *       * embedder failure   ⇒ `err({ kind: "embed-failed", cause })`
 *       * dim mismatch       ⇒ `err({ kind: "dim-mismatch", expected, actual })`
 *   - `clear()` resets `size()` to 0.
 *   - `size()` is the number of distinct ids currently indexed.
 */

import type { Result } from "@/shared"
import type { Document, SearchError, SearchHit } from "./types"

export interface SemanticIndex {
  index(docs: readonly Document[]): Promise<Result<void, SearchError>>
  query(text: string, k: number): Promise<Result<readonly SearchHit[], SearchError>>
  clear(): void
  size(): number
}
