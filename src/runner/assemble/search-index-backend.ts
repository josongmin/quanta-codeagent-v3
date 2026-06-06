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
 *   2. STORE SELECTION — `buildSemanticBackend(env, embed, opts?)` returns the
 *      `{ port, upsert, reconcileChanges }` triple the wire feeds to the
 *      indexer + pipeline. The default is the in-memory cosine map (legacy).
 *      `QUANTA_INDEX_PERSIST=on` still opts into sqlite implicitly, while an
 *      explicit `QUANTA_VECTOR_STORE=...` request selects sqlite/Lance/Qdrant/
 *      in-memory directly. Explicit store misconfigurations fail closed
 *      (disabled semantic backend) instead of silently aliasing back to the
 *      legacy in-memory path.
 *
 * Slice-fence: this is a `@/runner` assembler, so it composes leaf
 * `@/retrieval` engines/pipeline ports + `bun:sqlite` directly (same
 * direction as the sibling `./pipeline.ts` wire).
 */

import { Database } from "bun:sqlite"
import type { IndexerFileChunk } from "@/retrieval"
import {
  createEmbedderFromEnv,
  createHeadlessEmbedder,
  createStoreFromEnv,
  negotiateCapabilities,
  type Embedder,
  type EmbedderCapabilities,
  type EmbedderEnv,
  type LanceStoreOptions,
  type QdrantStoreOptions,
  type SqliteDb,
  type VectorStore,
} from "@/retrieval/engines"
import type { SearchHit, SemanticIndex } from "@/retrieval/pipeline"
import { errMessage, gateOn, logger } from "@/shared"

/** Caller-supplied upsert surface — mirrors `IndexerChunkUpsertPort`. */
export interface ChunkUpsertPort {
  upsert(chunk: IndexerFileChunk): Promise<void> | void
  delete(path: string): Promise<void> | void
}

/**
 * Typed health of a wired semantic backend (T06 / L5 H-4 + M-13).
 *
 *   - `"ready"`    — a usable store (in-memory / sqlite / vector) is backing
 *                    the port; upsert + query operate normally.
 *   - `"degraded"` — the requested store could not be opened but the wire is
 *                    falling back to a usable store (implicit selection only).
 *   - `"failed"`   — an EXPLICIT request is unusable (invalid `QUANTA_VECTOR_STORE`
 *                    spelling). The backend is inert (query ⇒ `[]`, upsert/delete
 *                    no-op) and consumers MUST treat this as a hard config error,
 *                    NOT a silently-empty index.
 */
export type SemanticBackendState = "ready" | "degraded" | "failed"

/** A wired semantic backend: a query port + the upsert surface the indexer drives. */
export interface SemanticBackend {
  readonly port: SemanticIndex
  readonly upsert: ChunkUpsertPort
  readonly reconcileChanges?: (batch: SemanticReconcileBatch) => Promise<void>
  /**
   * Typed health so a consumer (indexer wire / mention symbol deps) can detect
   * a broken backend instead of treating a disabled/inert store as a normal
   * empty index. `reason` is set whenever state is not `"ready"`. (L5 H-4/M-13.)
   */
  readonly state: SemanticBackendState
  readonly stateReason?: string
}

export interface SemanticReconcileBatch {
  readonly changedPaths: ReadonlyMap<string, readonly string[]>
  readonly deletedPaths: readonly string[]
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
const MANIFEST_TABLE = "search_index_chunk_manifest"
const HASH_EMBED_DIM = 64
const HASH_EMBED_MODEL_TAG = "legacy:hash-embed"
const HASH_EMBED_CAPS: EmbedderCapabilities = {
  dim: HASH_EMBED_DIM,
  maxInputBytes: Number.MAX_SAFE_INTEGER,
  batchSize: 1,
  modelTag: HASH_EMBED_MODEL_TAG,
}

/** A factory the selector calls to obtain a real `Embedder` from env. Injected for tests. */
export type EmbedderFactory = (env: EmbedderEnv) => Embedder | null

export interface SearchIndexMetrics {
  observe(name: string, value: number, labels?: Record<string, string>): void
}

export interface ResolveIndexEmbedderOptions {
  readonly metrics?: SearchIndexMetrics
  readonly nowMs?: () => number
}

export interface ResolvedIndexEmbedder {
  readonly embed: IndexEmbed
  readonly capabilities: () => Promise<EmbedderCapabilities>
  readonly providerLabel: string
}

export interface BuildSemanticBackendOptions {
  readonly db?: SqliteDb
  readonly manifestDb?: SqliteDb
  readonly metrics?: SearchIndexMetrics
  readonly nowMs?: () => number
  readonly resolvedEmbedder?: ResolvedIndexEmbedder
  readonly storeDeps?: {
    readonly lance?: Partial<LanceStoreOptions>
    readonly qdrant?: Partial<QdrantStoreOptions>
  }
}

interface ChunkManifestStore {
  listPaths(): Promise<readonly string[]>
  idsForPath(path: string): Promise<readonly string[]>
  replacePath(path: string, ids: readonly string[]): Promise<void>
  deletePath(path: string): Promise<void>
}

interface VectorStoreRuntime {
  readonly store: VectorStore
  readonly storeLabel: string
  readonly manifest: ChunkManifestStore
}

type RequestedStoreSelection =
  | { readonly kind: "none" }
  | { readonly kind: "implicit"; readonly provider: "sqlite" }
  | {
      readonly kind: "explicit"
      readonly provider: "in-memory" | "sqlite" | "lance" | "qdrant"
    }
  | { readonly kind: "invalid-explicit"; readonly raw: string }

const safeObserve = (
  metrics: SearchIndexMetrics | undefined,
  name: string,
  value: number,
  labels?: Record<string, string>,
): void => {
  if (metrics === undefined) return
  try {
    metrics.observe(name, value, labels)
  } catch (e) {
    // Metrics are optional; recorder failures must not affect retrieval. But a
    // throwing recorder is a wiring fault, not an absent one — surface it once
    // at debug so "metrics not configured" is distinguishable from "metrics
    // silently failing" (L5 M-12).
    logger.debug(`search index metric "${name}" observe failed: ${errMessage(e)}`)
  }
}

const nowOrDate = (nowMs: (() => number) | undefined): number =>
  (nowMs ?? (() => Date.now()))()

const buildLegacyHashEmbedder = (): ResolvedIndexEmbedder => ({
  embed: async (text: string) => hashEmbed(text),
  capabilities: async () => HASH_EMBED_CAPS,
  providerLabel: HASH_EMBED_MODEL_TAG,
})

const fallbackHeadless = async (
  embedder: Embedder,
  text: string,
): Promise<readonly number[] | null> => {
  try {
    const caps = await embedder.capabilities()
    const stub = createHeadlessEmbedder({
      dim: caps.dim,
      modelTag: `headless-fallback:${caps.modelTag}`,
    })
    const r = await stub.embed(text)
    if (!r.ok) return null
    return r.value.vectors[0] ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the embed function from env.
 *
 *   - No / unknown `QUANTA_EMBED_PROVIDER` ⇒ `createEmbedderFromEnv` returns
 *     null ⇒ this returns `hashEmbed` verbatim (byte-identical default).
 *   - A recognised provider ⇒ the real embedder is adapted; any failure
 *     surface (err result, empty vectors, thrown vendor error) degrades to
 *     `hashEmbed` for that call so the wire never blocks or throws.
 */
export const resolveIndexEmbedder = (
  env: NodeJS.ProcessEnv,
  factory: EmbedderFactory = createEmbedderFromEnv,
  opts: ResolveIndexEmbedderOptions = {},
): ResolvedIndexEmbedder => {
  const embedder = factory(env as EmbedderEnv)
  if (embedder === null) return buildLegacyHashEmbedder()
  const providerLabel = env.QUANTA_EMBED_PROVIDER ?? HASH_EMBED_MODEL_TAG
  return {
    capabilities: async (): Promise<EmbedderCapabilities> => {
      try {
        return await embedder.capabilities()
      } catch (e) {
        logger.warn(
          `search index embedder capabilities failed (${(e as Error).message}); falling back to ${HASH_EMBED_MODEL_TAG}.`,
        )
        return HASH_EMBED_CAPS
      }
    },
    providerLabel,
    embed: async (text: string): Promise<readonly number[]> => {
      const t0 = nowOrDate(opts.nowMs)
      try {
        const r = await embedder.embed(text)
        const vec = r.ok ? r.value.vectors[0] : undefined
        if (r.ok && vec !== undefined && vec.length > 0) {
          safeObserve(opts.metrics, "search.index.embed.latency_ms", nowOrDate(opts.nowMs) - t0, {
            provider: providerLabel,
            mode: "primary",
          })
          return vec
        }
        const reason = r.ok ? "empty-vector" : r.error.kind
        logger.warn(`search index embedder failed: ${reason}; attempting deterministic fallback.`)
      } catch (e) {
        logger.warn(
          `search index embedder threw (${(e as Error).message}); attempting deterministic fallback.`,
        )
      }
      const fallback = await fallbackHeadless(embedder, text)
      if (fallback !== null) {
        safeObserve(opts.metrics, "search.index.embed.latency_ms", nowOrDate(opts.nowMs) - t0, {
          provider: providerLabel,
          mode: "fallback-headless",
        })
        return fallback
      }
      safeObserve(opts.metrics, "search.index.embed.latency_ms", nowOrDate(opts.nowMs) - t0, {
        provider: providerLabel,
        mode: "fallback-hash",
      })
      return hashEmbed(text)
    },
  }
}

export const selectIndexEmbedder = (
  env: NodeJS.ProcessEnv,
  factory: EmbedderFactory = createEmbedderFromEnv,
): IndexEmbed => resolveIndexEmbedder(env, factory).embed

/** `QUANTA_INDEX_PERSIST=on` toggles the sqlite-backed delta store. */
export const isPersistOn = (env: NodeJS.ProcessEnv): boolean => gateOn(env, "QUANTA_INDEX_PERSIST")

const chunkId = (c: IndexerFileChunk): string => `${c.path}:${c.startLine}-${c.endLine}`

const newInMemoryBackend = (
  embed: IndexEmbed,
  metrics?: SearchIndexMetrics,
  nowMs?: () => number,
  storeLabel = "legacy-in-memory",
  state: SemanticBackendState = "ready",
  stateReason?: string,
): SemanticBackend => {
  type Entry = { readonly vec: readonly number[]; readonly chunk: IndexerFileChunk }
  const store = new Map<string, Entry>()
  return {
    state,
    ...(stateReason !== undefined ? { stateReason } : {}),
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const t0 = nowOrDate(nowMs)
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
        const hits = out.sort((a, b) => b.score - a.score).slice(0, k)
        safeObserve(metrics, "search.index.query.latency_ms", nowOrDate(nowMs) - t0, {
          store: storeLabel,
        })
        return hits
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

class InMemoryManifestStore implements ChunkManifestStore {
  private readonly idsByPath = new Map<string, readonly string[]>()

  async listPaths(): Promise<readonly string[]> {
    return [...this.idsByPath.keys()]
  }

  async idsForPath(path: string): Promise<readonly string[]> {
    return this.idsByPath.get(path) ?? []
  }

  async replacePath(path: string, ids: readonly string[]): Promise<void> {
    this.idsByPath.set(path, [...ids])
  }

  async deletePath(path: string): Promise<void> {
    this.idsByPath.delete(path)
  }
}

class SqliteManifestStore implements ChunkManifestStore {
  constructor(private readonly db: SqliteDb) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
         path TEXT NOT NULL,
         id TEXT NOT NULL,
         PRIMARY KEY(path, id)
       ) WITHOUT ROWID`,
    )
  }

  async listPaths(): Promise<readonly string[]> {
    const rows = this.db.query<{ path: string }>(`SELECT DISTINCT path FROM ${MANIFEST_TABLE}`).all()
    return rows.map((row) => row.path)
  }

  async idsForPath(path: string): Promise<readonly string[]> {
    const rows = this.db
      .query<{ id: string }>(`SELECT id FROM ${MANIFEST_TABLE} WHERE path = ? ORDER BY id`)
      .all(path)
    return rows.map((row) => row.id)
  }

  async replacePath(path: string, ids: readonly string[]): Promise<void> {
    this.db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE path = ?`).run(path)
    const stmt = this.db.query(`INSERT INTO ${MANIFEST_TABLE} (path, id) VALUES (?, ?)`)
    for (const id of ids) stmt.run(path, id)
  }

  async deletePath(path: string): Promise<void> {
    this.db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE path = ?`).run(path)
  }
}

const parseMaxDim = (raw: string | undefined): number | undefined =>
  raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined

const openLocalIndexDb = (
  env: NodeJS.ProcessEnv,
  purpose: "store" | "manifest",
): SqliteDb | null => {
  try {
    const path = env.QUANTA_INDEX_DB_PATH
    return new Database(
      path !== undefined && path !== "" ? path : ":memory:",
    ) as unknown as SqliteDb
  } catch (e) {
    logger.warn(
      `search index ${purpose} db open failed (${(e as Error).message}); ` +
        "falling back to in-memory index.",
    )
    return null
  }
}

const resolveRequestedStore = (env: NodeJS.ProcessEnv): RequestedStoreSelection => {
  const requested = env.QUANTA_VECTOR_STORE
  if (requested !== undefined && requested !== "") {
    if (
      requested === "in-memory" ||
      requested === "sqlite" ||
      requested === "lance" ||
      requested === "qdrant"
    ) {
      return { kind: "explicit", provider: requested }
    }
    return { kind: "invalid-explicit", raw: requested }
  }
  return isPersistOn(env) ? { kind: "implicit", provider: "sqlite" } : { kind: "none" }
}

const resolveStoreDeps = (
  env: NodeJS.ProcessEnv,
  provider: "in-memory" | "sqlite" | "lance" | "qdrant",
  opts: BuildSemanticBackendOptions,
): { readonly deps: Parameters<typeof createStoreFromEnv>[1]; readonly dbHandle?: SqliteDb } => {
  if (provider === "sqlite") {
    const dbHandle = opts.db ?? openLocalIndexDb(env, "store")
    return {
      deps:
        dbHandle === null
          ? {}
          : { sqlite: { db: dbHandle, tableName: PERSIST_TABLE } },
      ...(dbHandle !== null ? { dbHandle } : {}),
    }
  }
  if (provider === "lance") {
    const maxDim = parseMaxDim(env.QUANTA_LANCE_MAX_DIM)
    return {
      deps:
        env.QUANTA_LANCE_BASE_URL !== undefined && env.QUANTA_LANCE_TABLE !== undefined
          ? {
              lance: {
                baseURL: env.QUANTA_LANCE_BASE_URL,
                table: env.QUANTA_LANCE_TABLE,
                ...(env.QUANTA_LANCE_API_KEY !== undefined
                  ? { apiKey: env.QUANTA_LANCE_API_KEY }
                  : {}),
                ...(maxDim !== undefined ? { maxDim } : {}),
                ...(opts.storeDeps?.lance ?? {}),
              },
            }
          : {},
    }
  }
  if (provider === "qdrant") {
    const maxDim = parseMaxDim(env.QUANTA_QDRANT_MAX_DIM)
    return {
      deps:
        env.QUANTA_QDRANT_COLLECTION !== undefined
          ? {
              qdrant: {
                collection: env.QUANTA_QDRANT_COLLECTION,
                ...(env.QUANTA_QDRANT_BASE_URL !== undefined
                  ? { baseURL: env.QUANTA_QDRANT_BASE_URL }
                  : {}),
                ...(env.QUANTA_QDRANT_API_KEY !== undefined
                  ? { apiKey: env.QUANTA_QDRANT_API_KEY }
                  : {}),
                ...(maxDim !== undefined ? { maxDim } : {}),
                ...(opts.storeDeps?.qdrant ?? {}),
              },
            }
          : {},
    }
  }
  return { deps: { } }
}

const resolveManifestStore = (
  env: NodeJS.ProcessEnv,
  provider: "in-memory" | "sqlite" | "lance" | "qdrant",
  opts: BuildSemanticBackendOptions,
  dbHandle: SqliteDb | undefined,
): ChunkManifestStore => {
  if (opts.manifestDb !== undefined) return new SqliteManifestStore(opts.manifestDb)
  if (provider === "sqlite" && dbHandle !== undefined) return new SqliteManifestStore(dbHandle)
  if (env.QUANTA_INDEX_DB_PATH !== undefined && env.QUANTA_INDEX_DB_PATH !== "") {
    const db = openLocalIndexDb(env, "manifest")
    if (db !== null) return new SqliteManifestStore(db)
  }
  if (provider === "lance" || provider === "qdrant") {
    logger.warn(
      `search index ${provider} manifest is in-memory only (set QUANTA_INDEX_DB_PATH for restart-safe stale-chunk cleanup).`,
    )
  }
  return new InMemoryManifestStore()
}

const buildVectorStoreRuntime = async (
  env: NodeJS.ProcessEnv,
  selection: RequestedStoreSelection,
  resolvedEmbedder: ResolvedIndexEmbedder,
  opts: BuildSemanticBackendOptions,
): Promise<VectorStoreRuntime | null> => {
  if (selection.kind === "none" || selection.kind === "invalid-explicit") return null
  const provider = selection.provider
  const resolved = resolveStoreDeps(env, provider, opts)
  const store = createStoreFromEnv({ QUANTA_VECTOR_STORE: provider }, resolved.deps)
  if (store === null) {
    logger.warn(
      selection.kind === "explicit"
        ? `search index ${provider} store unavailable; semantic backend disabled for explicit QUANTA_VECTOR_STORE.`
        : `search index ${provider} store unavailable; falling back to legacy in-memory index.`,
    )
    return null
  }
  try {
    const caps = await resolvedEmbedder.capabilities()
    const negotiated = negotiateCapabilities(caps, store.capabilities())
    if (!negotiated.ok) {
      logger.warn(
        selection.kind === "explicit"
          ? `search index ${provider} capability mismatch (${negotiated.error.kind}); semantic backend disabled for explicit QUANTA_VECTOR_STORE.`
          : `search index ${provider} capability mismatch (${negotiated.error.kind}); falling back to legacy in-memory index.`,
      )
      return null
    }
  } catch (e) {
    logger.warn(
      selection.kind === "explicit"
        ? `search index ${provider} capability negotiation failed (${(e as Error).message}); semantic backend disabled for explicit QUANTA_VECTOR_STORE.`
        : `search index ${provider} capability negotiation failed (${(e as Error).message}); falling back to legacy in-memory index.`,
    )
    return null
  }
  return {
    store,
    storeLabel: provider,
    manifest: resolveManifestStore(env, provider, opts, resolved.dbHandle),
  }
}

const mapStoredHits = (hits: readonly {
  readonly id: string
  readonly score: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}[]): SearchHit[] =>
  hits.map((h) => {
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

const buildVectorStoreBackend = (
  embed: IndexEmbed,
  runtimePromise: Promise<VectorStoreRuntime | null>,
  metrics?: SearchIndexMetrics,
  nowMs?: () => number,
): SemanticBackend => {
  const ensureRuntime = async (): Promise<VectorStoreRuntime | null> => runtimePromise
  return {
    state: "ready",
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const runtime = await ensureRuntime()
        if (runtime === null) return []
        const t0 = nowOrDate(nowMs)
        const r = await runtime.store.query(vec, k)
        safeObserve(metrics, "search.index.query.latency_ms", nowOrDate(nowMs) - t0, {
          store: runtime.storeLabel,
        })
        if (!r.ok) {
          logger.warn(`search index ${runtime.storeLabel} query failed: ${r.error.kind}`)
          return []
        }
        return mapStoredHits(r.value)
      },
    },
    upsert: {
      async upsert(chunk: IndexerFileChunk): Promise<void> {
        const runtime = await ensureRuntime()
        if (runtime === null) return
        const id = chunkId(chunk)
        const vec = await embed(chunk.text)
        const r = await runtime.store.upsert([
          {
            id,
            vector: vec,
            metadata: {
              path: chunk.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              text: chunk.text,
            },
          },
        ])
        if (!r.ok) {
          logger.warn(`search index ${runtime.storeLabel} upsert failed: ${r.error.kind}`)
          return
        }
        const prev = await runtime.manifest.idsForPath(chunk.path)
        if (!prev.includes(id)) await runtime.manifest.replacePath(chunk.path, [...prev, id])
      },
      async delete(path: string): Promise<void> {
        const runtime = await ensureRuntime()
        if (runtime === null) return
        const ids = await runtime.manifest.idsForPath(path)
        if (ids.length === 0) return
        const r = await runtime.store.delete(ids)
        if (!r.ok) {
          logger.warn(`search index ${runtime.storeLabel} delete failed: ${r.error.kind}`)
          return
        }
        await runtime.manifest.deletePath(path)
      },
    },
    reconcileChanges: async (batch: SemanticReconcileBatch): Promise<void> => {
      const runtime = await ensureRuntime()
      if (runtime === null) return
      for (const path of batch.deletedPaths) {
        const stale = await runtime.manifest.idsForPath(path)
        if (stale.length === 0) {
          await runtime.manifest.deletePath(path)
          continue
        }
        const r = await runtime.store.delete(stale)
        if (!r.ok) {
          logger.warn(`search index ${runtime.storeLabel} delete failed: ${r.error.kind}`)
          continue
        }
        await runtime.manifest.deletePath(path)
      }
      for (const [path, nextIds] of batch.changedPaths) {
        const prevIds = new Set(await runtime.manifest.idsForPath(path))
        const keep = new Set(nextIds)
        const stale = [...prevIds].filter((id) => !keep.has(id))
        if (stale.length > 0) {
          const r = await runtime.store.delete(stale)
          if (!r.ok) {
            logger.warn(`search index ${runtime.storeLabel} delete failed: ${r.error.kind}`)
            continue
          }
        }
        await runtime.manifest.replacePath(path, nextIds)
      }
    },
  }
}

const newDisabledBackend = (reason: string): SemanticBackend => ({
  // An EXPLICIT but unusable store request. `failed` (not `degraded`) so the
  // consumer treats this as a hard config error, not a silently-empty index
  // (L5 H-4/M-13). The port stays inert so we never index/query elsewhere.
  state: "failed",
  stateReason: reason,
  port: {
    async query(): Promise<readonly SearchHit[]> {
      return []
    },
  },
  upsert: {
    async upsert(): Promise<void> {
      /* explicit store request is disabled; do not silently index elsewhere */
    },
    async delete(): Promise<void> {
      /* explicit store request is disabled; do not silently delete elsewhere */
    },
  },
})

/**
 * Open the persist database. `QUANTA_INDEX_DB_PATH` names a file; absent ⇒
 * an in-process `:memory:` db (persist-shaped store, no on-disk file). Build
 * failures degrade to `null` so the caller can fall back to in-memory.
 */
export const buildSemanticBackend = (
  env: NodeJS.ProcessEnv,
  embed: IndexEmbed,
  opts: BuildSemanticBackendOptions = {},
): SemanticBackend => {
  const selection = resolveRequestedStore(env)
  const resolvedEmbedder = opts.resolvedEmbedder ?? resolveIndexEmbedder(env)
  if (selection.kind === "none") {
    return newInMemoryBackend(embed, opts.metrics, opts.nowMs)
  }
  if (selection.kind === "invalid-explicit") {
    // Fail-CLOSED on an explicit typo (`QUANTA_VECTOR_STORE=lannce`). We keep
    // the backend inert (no silent fallback to a different store) AND surface
    // a typed `failed` state so the consumer can refuse to wire a broken
    // index rather than dropping chunks into a black hole (L5 H-4/M-13).
    const reason = `unknown QUANTA_VECTOR_STORE "${selection.raw}" (expected in-memory | sqlite | lance | qdrant)`
    logger.error(`search index store ${reason}; semantic backend FAILED (explicit store, fail-closed).`)
    return newDisabledBackend(reason)
  }
  const runtime = buildVectorStoreRuntime(env, selection, resolvedEmbedder, opts)
  const fallback = newInMemoryBackend(embed, opts.metrics, opts.nowMs, "legacy-fallback")
  const vectorBacked = buildVectorStoreBackend(embed, runtime, opts.metrics, opts.nowMs)
  const explicitDisabled = selection.kind === "explicit"
  return {
    // A usable store was selected (explicit or implicit). If the runtime fails
    // to OPEN later, an explicit request stays inert (no cross-store fallback)
    // and an implicit request falls back to in-memory — both handled per-op
    // below; the static state here reflects the SELECTION being valid.
    state: "ready",
    port: {
      async query(vec, k) {
        const resolved = await runtime
        if (resolved !== null) return vectorBacked.port.query(vec, k)
        return explicitDisabled ? [] : fallback.port.query(vec, k)
      },
    },
    upsert: {
      async upsert(chunk) {
        const resolved = await runtime
        if (resolved !== null) return vectorBacked.upsert.upsert(chunk)
        if (explicitDisabled) return
        return fallback.upsert.upsert(chunk)
      },
      async delete(path) {
        const resolved = await runtime
        if (resolved !== null) return vectorBacked.upsert.delete(path)
        if (explicitDisabled) return
        return fallback.upsert.delete(path)
      },
    },
    reconcileChanges: async (batch) => {
      const resolved = await runtime
      if (resolved === null) return
      await vectorBacked.reconcileChanges?.(batch)
    },
  }
}
