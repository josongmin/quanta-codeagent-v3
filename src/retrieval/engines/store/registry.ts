/**
 * VectorStore registry — env-driven swap (ADR-0261).
 *
 *   QUANTA_VECTOR_STORE ∈ { in-memory, sqlite, lance, qdrant }
 *
 * Returns `null` when env is unset / unknown — caller-owned construction
 * remains the default (byte-identical landing).
 *
 * Some stores require resources that env alone cannot supply (a sqlite
 * `Database` handle; a Lance/Qdrant collection name + URL). Those cases
 * are handled by `requirements(provider)` which describes what the
 * caller must inject. The registry itself only constructs the *trivial*
 * choices automatically (`in-memory`); the others demand explicit
 * caller wiring via `createStoreFromEnv(env, deps)`.
 */

import { createInMemoryVectorStore } from "./in-memory-store"
import { createLanceVectorStore, type LanceStoreOptions } from "./lance-store"
import type { VectorStore } from "./port"
import { createQdrantVectorStore, type QdrantStoreOptions } from "./qdrant-store"
import { createSqliteVssStore, type SqliteVssStoreOptions } from "./sqlite-vss-store"

export const VECTOR_STORES = ["in-memory", "sqlite", "lance", "qdrant"] as const
export type VectorStoreProvider = (typeof VECTOR_STORES)[number]

export const isVectorStoreProvider = (s: string | undefined): s is VectorStoreProvider =>
  s !== undefined && (VECTOR_STORES as readonly string[]).includes(s)

export interface VectorStoreEnv {
  readonly QUANTA_VECTOR_STORE?: string
}

export interface VectorStoreDeps {
  readonly sqlite?: Omit<SqliteVssStoreOptions, never>
  readonly lance?: LanceStoreOptions
  readonly qdrant?: QdrantStoreOptions
}

/**
 * Construct a `VectorStore` from env. Returns `null` when:
 *   - env var is absent or unrecognised, OR
 *   - the chosen provider requires deps that are absent.
 */
export const createStoreFromEnv = (
  env: VectorStoreEnv,
  deps: VectorStoreDeps = {},
): VectorStore | null => {
  const provider = env.QUANTA_VECTOR_STORE
  if (!isVectorStoreProvider(provider)) return null
  switch (provider) {
    case "in-memory":
      return createInMemoryVectorStore()
    case "sqlite":
      return deps.sqlite === undefined ? null : createSqliteVssStore(deps.sqlite)
    case "lance":
      return deps.lance === undefined ? null : createLanceVectorStore(deps.lance)
    case "qdrant":
      return deps.qdrant === undefined ? null : createQdrantVectorStore(deps.qdrant)
  }
}
