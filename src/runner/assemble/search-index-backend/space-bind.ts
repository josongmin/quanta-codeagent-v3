import type { SqliteDb } from "@/retrieval/engines"
import type { EmbeddingSpace } from "@/retrieval/engines/embedder/space"
import { embeddingSpacesEqual } from "@/retrieval/engines/embedder/space"

/** Sidecar identity for a persisted sqlite vector table. Not the vector rows. */
export const EMBEDDING_SPACE_TABLE = "search_index_embedding_space"
export const EMBEDDING_NAMESPACE_TABLE = "search_index_embedding_namespaces"

export type SpaceBindResult =
  | { readonly kind: "ok"; readonly space: EmbeddingSpace }
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "mismatch"
      readonly reason: string
      readonly persisted: EmbeddingSpace
      readonly current: EmbeddingSpace
    }

const readPersistedSpace = (db: SqliteDb): EmbeddingSpace | null => {
  const row = db
    .query<{
      model: string
      revision: string
      dimensions: number
      normalization: string
    }>(
      `SELECT model, revision, dimensions, normalization FROM ${EMBEDDING_SPACE_TABLE} WHERE slot = 1`,
    )
    .get()
  if (row === null) return null
  if (row.normalization !== "l2" && row.normalization !== "none") return null
  return {
    model: row.model,
    revision: row.revision,
    dimensions: row.dimensions,
    normalization: row.normalization,
  }
}

const countVectors = (db: SqliteDb, vectorTable: string): number => {
  const row = db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${vectorTable}`).get()
  return row?.n ?? 0
}

/**
 * Bind the live embedder space to a persisted sqlite index.
 *
 * Empty store → write current space. Matching space → ok. Unknown (vectors
 * without identity) or mismatch → refuse. Never deletes original rows.
 */
export const bindPersistedEmbeddingSpace = (
  db: SqliteDb,
  vectorTable: string,
  current: EmbeddingSpace,
): SpaceBindResult => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${EMBEDDING_SPACE_TABLE} (
       slot INTEGER PRIMARY KEY CHECK (slot = 1),
       model TEXT NOT NULL,
       revision TEXT NOT NULL,
       dimensions INTEGER NOT NULL,
       normalization TEXT NOT NULL
     )`,
  )
  const persisted = readPersistedSpace(db)
  if (persisted === null) {
    if (countVectors(db, vectorTable) > 0) {
      return {
        kind: "unknown",
        reason: "persisted index has vectors but no embedding-space identity; rebuild required",
      }
    }
    db.query(
      `INSERT INTO ${EMBEDDING_SPACE_TABLE} (slot, model, revision, dimensions, normalization)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(current.model, current.revision, current.dimensions, current.normalization)
    return { kind: "ok", space: current }
  }
  if (embeddingSpacesEqual(persisted, current)) return { kind: "ok", space: persisted }
  return {
    kind: "mismatch",
    reason: `persisted embedding space ${persisted.model}/${persisted.dimensions}d ≠ ${current.model}/${current.dimensions}d; rebuild required`,
    persisted,
    current,
  }
}

/**
 * Record and collision-check an embedding-derived remote namespace.
 *
 * Remote vector rows live in the namespace itself, so no local vector count is
 * needed. Absence writes the mapping; a hash collision or manual remap refuses.
 */
export const bindPersistedEmbeddingNamespace = (
  db: SqliteDb,
  namespace: string,
  current: EmbeddingSpace,
): SpaceBindResult => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${EMBEDDING_NAMESPACE_TABLE} (
       namespace TEXT PRIMARY KEY,
       model TEXT NOT NULL,
       revision TEXT NOT NULL,
       dimensions INTEGER NOT NULL,
       normalization TEXT NOT NULL
     ) WITHOUT ROWID`,
  )
  const row = db
    .query<{
      model: string
      revision: string
      dimensions: number
      normalization: string
    }>(
      `SELECT model, revision, dimensions, normalization
       FROM ${EMBEDDING_NAMESPACE_TABLE} WHERE namespace = ?`,
    )
    .get(namespace)
  if (row === null) {
    db.query(
      `INSERT INTO ${EMBEDDING_NAMESPACE_TABLE}
       (namespace, model, revision, dimensions, normalization)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(namespace, current.model, current.revision, current.dimensions, current.normalization)
    return { kind: "ok", space: current }
  }
  if (row.normalization !== "l2" && row.normalization !== "none") {
    return {
      kind: "unknown",
      reason: `remote namespace ${namespace} has invalid identity metadata`,
    }
  }
  const persisted: EmbeddingSpace = {
    model: row.model,
    revision: row.revision,
    dimensions: row.dimensions,
    normalization: row.normalization,
  }
  if (embeddingSpacesEqual(persisted, current)) return { kind: "ok", space: persisted }
  return {
    kind: "mismatch",
    reason: `remote namespace ${namespace} is bound to a different embedding space`,
    persisted,
    current,
  }
}
