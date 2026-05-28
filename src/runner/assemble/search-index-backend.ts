/**
 * Semantic index backend selection (ADR-0391).
 *
 * Splits the two seams the search wire (`./search-pipeline.ts`) needs:
 *
 *   1. EMBEDDER SELECTION — `selectIndexEmbedder(env)` returns the
 *      `(text) => Promise<readonly number[]>` used for BOTH the index upsert
 *      vectors AND the pipeline query embedder (they must agree). When
 *      `QUANTA_EMBED_PROVIDER` selects a real provider via the ADR-0261
 *      registry, that adapter is used; on a null/empty/erroring/throwing
 *      embedder it falls back to the legacy `hashEmbed` placeholder. With NO
 *      provider env the function IS `hashEmbed` — byte-identical to the
 *      pre-ADR-0391 wire.
 *
 *   2. STORE SELECTION — `buildSemanticBackend(env, embed, db?)` returns the
 *      `{ port, upsert }` pair the wire feeds to the indexer + pipeline. The
 *      default is the in-memory cosine map (legacy). When
 *      `QUANTA_INDEX_PERSIST=on` it persists deltas to a `bun:sqlite`-backed
 *      VectorStore (ADR-0261 `createSqliteVssStore`) so the index survives a
 *      process restart. This is the single NEW primitive — default-OFF.
 *
 * Slice-fence: this is a `@/runner` assembler, so it composes leaf
 * `@/retrieval` engines/pipeline ports + `bun:sqlite` directly (same
 * direction as the sibling `./pipeline.ts` wire).
 */

import { Database } from "bun:sqlite"
import type { IndexerFileChunk } from "@/retrieval"
import {
  createEmbedderFromEnv,
  createSqliteVssStore,
  type Embedder,
  type EmbedderEnv,
  type SqliteDb,
} from "@/retrieval/engines"
import type { SearchHit, SemanticIndex } from "@/retrieval/pipeline"
import { logger } from "@/shared"

/** Caller-supplied upsert surface — mirrors `IndexerChunkUpsertPort`. */
export interface ChunkUpsertPort {
  upsert(chunk: IndexerFileChunk): Promise<void> | void
  delete(path: string): Promise<void> | void
}

/** A wired semantic backend: a query port + the upsert surface the indexer drives. */
export interface SemanticBackend {
  readonly port: SemanticIndex
  readonly upsert: ChunkUpsertPort
}

/** Function the wire uses to embed a single string into a dense vector. */
export type IndexEmbed = (text: string) => Promise<readonly number[]>

/**
 * Legacy placeholder embedder (64-dim FNV-hash bag-of-tokens). Lives here so
 * both the in-memory backend and the wire share ONE definition. Pure and
 * deterministic — same input ⇒ byte-identical output.
 */
export const hashEmbed = (text: string, dim = 64): readonly number[] => {
  const out = new Float64Array(dim)
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length > 0)
  for (const tok of tokens) {
    let h = 2166136261 >>> 0
    for (let i = 0; i < tok.length; i++) {
      h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0
    }
    out[h % dim] = (out[h % dim] ?? 0) + 1
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += (out[i] ?? 0) * (out[i] ?? 0)
  norm = Math.sqrt(norm) || 1
  const arr: number[] = new Array(dim)
  for (let i = 0; i < dim; i++) arr[i] = (out[i] ?? 0) / norm
  return arr
}

const PERSIST_TABLE = "search_index_vss"

/** A factory the selector calls to obtain a real `Embedder` from env. Injected for tests. */
export type EmbedderFactory = (env: EmbedderEnv) => Embedder | null

/**
 * Resolve the embed function from env.
 *
 *   - No / unknown `QUANTA_EMBED_PROVIDER` ⇒ `createEmbedderFromEnv` returns
 *     null ⇒ this returns `hashEmbed` verbatim (byte-identical default).
 *   - A recognised provider ⇒ the real embedder is adapted; any failure
 *     surface (err result, empty vectors, thrown vendor error) degrades to
 *     `hashEmbed` for that call so the wire never blocks or throws.
 */
export const selectIndexEmbedder = (
  env: NodeJS.ProcessEnv,
  factory: EmbedderFactory = createEmbedderFromEnv,
): IndexEmbed => {
  const embedder = factory(env as EmbedderEnv)
  if (embedder === null) {
    return async (text: string) => hashEmbed(text)
  }
  return async (text: string): Promise<readonly number[]> => {
    try {
      const r = await embedder.embed(text)
      if (!r.ok) {
        logger.warn(`search index embedder failed: ${r.error.kind}; falling back to hashEmbed.`)
        return hashEmbed(text)
      }
      const vec = r.value.vectors[0]
      if (vec === undefined || vec.length === 0) return hashEmbed(text)
      return vec
    } catch (e) {
      logger.warn(
        `search index embedder threw (${(e as Error).message}); falling back to hashEmbed.`,
      )
      return hashEmbed(text)
    }
  }
}

/** `QUANTA_INDEX_PERSIST=on` toggles the sqlite-backed delta store. */
export const isPersistOn = (env: NodeJS.ProcessEnv): boolean => env.QUANTA_INDEX_PERSIST === "on"

const chunkId = (c: IndexerFileChunk): string => `${c.path}:${c.startLine}-${c.endLine}`

const newInMemoryBackend = (embed: IndexEmbed): SemanticBackend => {
  type Entry = { readonly vec: readonly number[]; readonly chunk: IndexerFileChunk }
  const store = new Map<string, Entry>()
  return {
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const out: SearchHit[] = []
        for (const [id, { vec: v, chunk }] of store) {
          let dot = 0
          const len = Math.min(v.length, vec.length)
          for (let i = 0; i < len; i++) dot += (v[i] ?? 0) * (vec[i] ?? 0)
          out.push({
            id,
            score: dot,
            text: chunk.text,
            source: "semantic",
            metadata: {
              path: chunk.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            },
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, k)
      },
    },
    upsert: {
      async upsert(chunk: IndexerFileChunk): Promise<void> {
        store.set(chunkId(chunk), { vec: await embed(chunk.text), chunk })
      },
      delete(path: string): void {
        for (const id of store.keys()) {
          if (id.startsWith(`${path}:`)) store.delete(id)
        }
      },
    },
  }
}

const metaString = (v: string | number | boolean | undefined): string =>
  typeof v === "string" ? v : ""
const metaNumber = (v: string | number | boolean | undefined): number =>
  typeof v === "number" ? v : 0

const newSqliteBackend = (embed: IndexEmbed, db: SqliteDb): SemanticBackend => {
  const vss = createSqliteVssStore({ db, tableName: PERSIST_TABLE })
  // Persisted-id registry for `delete(path)`: the store keys by exact chunk id,
  // so we resolve a path's chunk ids by scanning the table on demand.
  const idsForPath = (path: string): string[] => {
    const prefix = `${path}:`
    const rows = db
      .query<{ id: string }>(`SELECT id FROM ${PERSIST_TABLE} WHERE id LIKE ?`)
      .all(`${prefix}%`)
    return rows.map((r) => r.id).filter((id) => id.startsWith(prefix))
  }
  return {
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const r = await vss.query(vec, k)
        if (!r.ok) {
          logger.warn(`search index sqlite query failed: ${r.error.kind}`)
          return []
        }
        return r.value.map((h) => {
          const meta = h.metadata ?? {}
          return {
            id: h.id,
            score: h.score,
            text: metaString(meta.text),
            source: "semantic" as const,
            metadata: {
              path: metaString(meta.path),
              startLine: metaNumber(meta.startLine),
              endLine: metaNumber(meta.endLine),
            },
          }
        })
      },
    },
    upsert: {
      async upsert(chunk: IndexerFileChunk): Promise<void> {
        const vec = await embed(chunk.text)
        const r = await vss.upsert([
          {
            id: chunkId(chunk),
            vector: vec,
            metadata: {
              path: chunk.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              text: chunk.text,
            },
          },
        ])
        if (!r.ok) logger.warn(`search index sqlite upsert failed: ${r.error.kind}`)
      },
      async delete(path: string): Promise<void> {
        const ids = idsForPath(path)
        if (ids.length === 0) return
        const r = await vss.delete(ids)
        if (!r.ok) logger.warn(`search index sqlite delete failed: ${r.error.kind}`)
      },
    },
  }
}

/**
 * Open the persist database. `QUANTA_INDEX_DB_PATH` names a file; absent ⇒
 * an in-process `:memory:` db (persist-shaped store, no on-disk file). Build
 * failures degrade to `null` so the caller can fall back to in-memory.
 */
const openPersistDb = (env: NodeJS.ProcessEnv): SqliteDb | null => {
  try {
    const path = env.QUANTA_INDEX_DB_PATH
    return new Database(
      path !== undefined && path !== "" ? path : ":memory:",
    ) as unknown as SqliteDb
  } catch (e) {
    logger.warn(
      `search index persist db open failed (${(e as Error).message}); ` +
        "falling back to in-memory index.",
    )
    return null
  }
}

/**
 * Build the semantic backend for the wire. Default is the legacy in-memory
 * cosine map. With `QUANTA_INDEX_PERSIST=on` deltas persist to a sqlite
 * VectorStore. `db` is injectable for tests; when omitted it is opened from
 * `QUANTA_INDEX_DB_PATH` (or `:memory:`).
 */
export const buildSemanticBackend = (
  env: NodeJS.ProcessEnv,
  embed: IndexEmbed,
  db?: SqliteDb,
): SemanticBackend => {
  if (!isPersistOn(env)) return newInMemoryBackend(embed)
  const handle = db ?? openPersistDb(env)
  if (handle === null) return newInMemoryBackend(embed)
  return newSqliteBackend(embed, handle)
}
