/**
 * `VectorStore` port — ADR-0261.
 *
 * Closed-port abstraction over every vector backend (in-memory / sqlite /
 * lance / qdrant). All operations return `Result<T, StoreError>` so error
 * surfaces are exhaustively typed.
 */
import type { Result } from "@/shared"
import type { Filter, StoreCapabilities, StoredDoc, StoredHit, StoreError } from "./types"

export interface VectorStore {
  upsert(docs: readonly StoredDoc[]): Promise<Result<void, StoreError>>
  query(
    vec: readonly number[],
    k: number,
    filter?: Filter,
  ): Promise<Result<readonly StoredHit[], StoreError>>
  delete(ids: readonly string[]): Promise<Result<void, StoreError>>
  capabilities(): StoreCapabilities
}
