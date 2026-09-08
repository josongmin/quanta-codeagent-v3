/**
 * Semantic index backend selection (ADR-0391).
 *
 * Splits the two seams the search wire (`./search-pipeline.ts`) needs:
 *
 *   1. EMBEDDER SELECTION — no provider ⇒ intentional hash namespace.
 *      A real provider that fails does NOT fall back to hash/headless.
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
  createStoreFromEnv,
  type Embedder,
  type EmbedderCapabilities,
  type EmbedderEnv,
  type EmbedProvider,
  type LanceStoreOptions,
  negotiateCapabilities,
  type QdrantStoreOptions,
  type SqliteDb,
  type VectorStore,
} from "@/retrieval/engines"
import { embeddingSpaceFromCaps, HASH_EMBEDDING_SPACE } from "@/retrieval/engines/embedder/space"
import type { SearchHit, SemanticIndex } from "@/retrieval/pipeline"
import { errMessage, gateDisabled, gateOn, logger } from "@/shared"
import {
  EmbeddingSpaceError,
  SemanticBackendUnavailableError,
  type SemanticReadiness,
} from "./search-index-backend/errors"
import { newInMemoryBackend } from "./search-index-backend/in-memory"
import { bindPersistedEmbeddingSpace } from "./search-index-backend/space-bind"

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
 *                    spelling). Operations throw `SemanticBackendUnavailableError`
 *                    after awaiting `readiness`. Not a silently-empty index.
 */
export type SemanticBackendState = "ready" | "degraded" | "failed"

export type { EmbeddingSpace } from "@/retrieval/engines/embedder/space"
export {
  embeddingSpaceFromCaps,
  embeddingSpacesEqual,
  HASH_EMBEDDING_SPACE,
} from "@/retrieval/engines/embedder/space"
export {
  EmbeddingSpaceError,
  isTypedSemanticFailure,
  SemanticBackendUnavailableError,
  type SemanticReadiness,
} from "./search-index-backend/errors"
export {
  bindPersistedEmbeddingSpace,
  EMBEDDING_SPACE_TABLE,
} from "./search-index-backend/space-bind"

/** A wired semantic backend: a query port + the upsert surface the indexer drives. */
export interface SemanticBackend {
  readonly port: SemanticIndex
  readonly upsert: ChunkUpsertPort
  readonly reconcileChanges?: (batch: SemanticReconcileBatch) => Promise<void>
  readonly state: SemanticBackendState
  readonly stateReason?: string
  readonly readiness: Promise<SemanticReadiness>
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
/** Provider label of the NON-SEMANTIC 64-dim hash-BoW placeholder embedder — the
 *  out-of-box default when `QUANTA_INDEX=on` but no embedding provider/key is set.
 *  Exported so the pipeline can surface a one-shot operator warning (the hash
 *  placeholder is otherwise a SILENT degradation: `search_codebase` advertises a
 *  semantic capability it does not have). */
export const HASH_EMBED_MODEL_TAG = "legacy:hash-embed"
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
  readonly space: () => Promise<import("@/retrieval/engines/embedder/space").EmbeddingSpace>
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

type RuntimeRefused = { readonly kind: "space-refused"; readonly reason: string }
type RuntimeBuild = VectorStoreRuntime | RuntimeRefused | null

const isSpaceRefused = (r: RuntimeBuild): r is RuntimeRefused =>
  r !== null && "kind" in r && r.kind === "space-refused"

const unwrapRuntime = (r: RuntimeBuild): VectorStoreRuntime | null => (isSpaceRefused(r) ? null : r)

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

const READY: SemanticReadiness = { kind: "ready" }

const awaitReady = async (readiness: Promise<SemanticReadiness>): Promise<void> => {
  const r = await readiness
  if (r.kind === "unavailable") {
    throw new SemanticBackendUnavailableError(r.reason, r.phase)
  }
}

const nowOrDate = (nowMs: (() => number) | undefined): number => (nowMs ?? (() => Date.now()))()

const buildLegacyHashEmbedder = (): ResolvedIndexEmbedder => ({
  embed: async (text: string) => hashEmbed(text),
  capabilities: async () => HASH_EMBED_CAPS,
  providerLabel: HASH_EMBED_MODEL_TAG,
  space: async () => HASH_EMBEDDING_SPACE,
})

/**
 * Key-detection default promotion (jun26 frontier-parity fix).
 *
 * The strongest semantic-search path (Voyage/OpenAI/Cohere embed) was real but
 * default-OFF: out-of-box you got the 64-dim hash-BoW placeholder unless you
 * BOTH set a key AND remembered to set `QUANTA_EMBED_PROVIDER`. When a real API
 * key is present but no provider is named, promote to that provider's embedder
 * so the box-fresh experience is real semantic search, not a placeholder.
 *
 * Invariants:
 *   - NO key present ⇒ returns `undefined` ⇒ caller keeps the legacy hash path
 *     verbatim (byte-identical default-OFF preserved).
 *   - An EXPLICIT `QUANTA_EMBED_PROVIDER` always wins (we never override it).
 *   - Kill-switch `QUANTA_INDEX_AUTO_EMBED=off` (or `=0`) disables promotion so
 *     the flip is reversible/measurable; default-ON only fires WITH a key.
 *
 * Probe order matches the registry's switch; first key present wins.
 */
const promoteProviderFromKey = (
  env: Record<string, string | undefined>,
): EmbedProvider | undefined => {
  if (env.QUANTA_EMBED_PROVIDER !== undefined && env.QUANTA_EMBED_PROVIDER !== "") return undefined
  if (gateDisabled(env, "QUANTA_INDEX_AUTO_EMBED")) return undefined
  if (env.VOYAGE_API_KEY !== undefined && env.VOYAGE_API_KEY !== "") return "voyage"
  if (env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== "") return "openai"
  if (env.COHERE_API_KEY !== undefined && env.COHERE_API_KEY !== "") return "cohere"
  return undefined
}

const embedWithProvider = async (
  embedder: Embedder,
  text: string,
  providerLabel: string,
  opts: ResolveIndexEmbedderOptions,
): Promise<readonly number[]> => {
  const t0 = nowOrDate(opts.nowMs)
  const caps = await embedder.capabilities()
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > caps.maxInputBytes) {
    throw new EmbeddingSpaceError(
      "input-too-large",
      `embed input ${bytes} bytes exceeds ${caps.maxInputBytes} for ${caps.modelTag}`,
    )
  }
  try {
    const r = await embedder.embed(text)
    const vec = r.ok ? r.value.vectors[0] : undefined
    if (!r.ok || vec === undefined || vec.length === 0) {
      const reason = r.ok ? "empty-vector" : r.error.kind
      throw new EmbeddingSpaceError("provider-failed", `search index embedder failed: ${reason}`)
    }
    if (vec.length !== caps.dim) {
      throw new EmbeddingSpaceError(
        "mismatch",
        `embedder returned dim ${vec.length}, expected ${caps.dim}`,
      )
    }
    safeObserve(opts.metrics, "search.index.embed.latency_ms", nowOrDate(opts.nowMs) - t0, {
      provider: providerLabel,
      mode: "primary",
    })
    return vec
  } catch (e) {
    if (e instanceof EmbeddingSpaceError) throw e
    throw new EmbeddingSpaceError(
      "provider-failed",
      `search index embedder threw (${(e as Error).message})`,
    )
  }
}

/**
 * Resolve the embed function from env.
 *
 *   - No / unknown `QUANTA_EMBED_PROVIDER` ⇒ hash namespace (intentional).
 *   - A recognised provider ⇒ typed failure on error; no hash/headless mix.
 */
export const resolveIndexEmbedder = (
  env: Record<string, string | undefined>,
  factory: EmbedderFactory = createEmbedderFromEnv,
  opts: ResolveIndexEmbedderOptions = {},
): ResolvedIndexEmbedder => {
  const promoted = promoteProviderFromKey(env)
  const factoryEnv: EmbedderEnv =
    promoted === undefined
      ? (env as EmbedderEnv)
      : { ...(env as EmbedderEnv), QUANTA_EMBED_PROVIDER: promoted }
  const embedder = factory(factoryEnv)
  if (embedder === null) return buildLegacyHashEmbedder()
  const providerLabel = factoryEnv.QUANTA_EMBED_PROVIDER ?? HASH_EMBED_MODEL_TAG
  const capabilities = async (): Promise<EmbedderCapabilities> => embedder.capabilities()
  return {
    capabilities,
    providerLabel,
    space: async () => embeddingSpaceFromCaps(await capabilities()),
    embed: async (text: string): Promise<readonly number[]> =>
      embedWithProvider(embedder, text, providerLabel, opts),
  }
}

export const selectIndexEmbedder = (
  env: Record<string, string | undefined>,
  factory: EmbedderFactory = createEmbedderFromEnv,
): IndexEmbed => resolveIndexEmbedder(env, factory).embed

/** `QUANTA_INDEX_PERSIST=on` toggles the sqlite-backed delta store. */
export const isPersistOn = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, "QUANTA_INDEX_PERSIST")

const chunkId = (c: IndexerFileChunk): string => `${c.path}:${c.startLine}-${c.endLine}`

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
    const rows = this.db
      .query<{ path: string }>(`SELECT DISTINCT path FROM ${MANIFEST_TABLE}`)
      .all()
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
  env: Record<string, string | undefined>,
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

const resolveRequestedStore = (
  env: Record<string, string | undefined>,
): RequestedStoreSelection => {
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

type StoreDeps = Parameters<typeof createStoreFromEnv>[1]
type ResolvedStoreDeps = { readonly deps: StoreDeps; readonly dbHandle?: SqliteDb }

const resolveSqliteStoreDeps = (
  env: Record<string, string | undefined>,
  opts: BuildSemanticBackendOptions,
): ResolvedStoreDeps => {
  const dbHandle = opts.db ?? openLocalIndexDb(env, "store")
  return {
    deps: dbHandle === null ? {} : { sqlite: { db: dbHandle, tableName: PERSIST_TABLE } },
    ...(dbHandle !== null ? { dbHandle } : {}),
  }
}

const resolveLanceStoreDeps = (
  env: Record<string, string | undefined>,
  opts: BuildSemanticBackendOptions,
): StoreDeps => {
  const baseURL = env.QUANTA_LANCE_BASE_URL
  const table = env.QUANTA_LANCE_TABLE
  if (baseURL === undefined || table === undefined) return {}
  const maxDim = parseMaxDim(env.QUANTA_LANCE_MAX_DIM)
  return {
    lance: {
      baseURL,
      table,
      ...(env.QUANTA_LANCE_API_KEY !== undefined ? { apiKey: env.QUANTA_LANCE_API_KEY } : {}),
      ...(maxDim !== undefined ? { maxDim } : {}),
      ...(opts.storeDeps?.lance ?? {}),
    },
  }
}

const resolveQdrantStoreDeps = (
  env: Record<string, string | undefined>,
  opts: BuildSemanticBackendOptions,
): StoreDeps => {
  const collection = env.QUANTA_QDRANT_COLLECTION
  if (collection === undefined) return {}
  const maxDim = parseMaxDim(env.QUANTA_QDRANT_MAX_DIM)
  return {
    qdrant: {
      collection,
      ...(env.QUANTA_QDRANT_BASE_URL !== undefined ? { baseURL: env.QUANTA_QDRANT_BASE_URL } : {}),
      ...(env.QUANTA_QDRANT_API_KEY !== undefined ? { apiKey: env.QUANTA_QDRANT_API_KEY } : {}),
      ...(maxDim !== undefined ? { maxDim } : {}),
      ...(opts.storeDeps?.qdrant ?? {}),
    },
  }
}

const resolveStoreDeps = (
  env: Record<string, string | undefined>,
  provider: "in-memory" | "sqlite" | "lance" | "qdrant",
  opts: BuildSemanticBackendOptions,
): ResolvedStoreDeps => {
  if (provider === "sqlite") return resolveSqliteStoreDeps(env, opts)
  if (provider === "lance") return { deps: resolveLanceStoreDeps(env, opts) }
  if (provider === "qdrant") return { deps: resolveQdrantStoreDeps(env, opts) }
  return { deps: {} }
}

const resolveManifestStore = (
  env: Record<string, string | undefined>,
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
  env: Record<string, string | undefined>,
  selection: RequestedStoreSelection,
  resolvedEmbedder: ResolvedIndexEmbedder,
  opts: BuildSemanticBackendOptions,
): Promise<RuntimeBuild> => {
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
  if (resolved.dbHandle !== undefined) {
    const space = await resolvedEmbedder.space()
    const bind = bindPersistedEmbeddingSpace(resolved.dbHandle, PERSIST_TABLE, space)
    if (bind.kind !== "ok") {
      logger.warn(`search index embedding space ${bind.kind}: ${bind.reason}`)
      return { kind: "space-refused", reason: bind.reason }
    }
  }
  return {
    store,
    storeLabel: provider,
    manifest: resolveManifestStore(env, provider, opts, resolved.dbHandle),
  }
}

const mapStoredHits = (
  hits: readonly {
    readonly id: string
    readonly score: number
    readonly metadata?: Readonly<Record<string, string | number | boolean>>
  }[],
): SearchHit[] =>
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

const deleteStoredIds = async (
  runtime: VectorStoreRuntime,
  ids: readonly string[],
): Promise<boolean> => {
  const deleted = await runtime.store.delete(ids)
  if (deleted.ok) return true
  logger.warn(`search index ${runtime.storeLabel} delete failed: ${deleted.error.kind}`)
  return false
}

const reconcileDeletedPath = async (runtime: VectorStoreRuntime, path: string): Promise<void> => {
  const stale = await runtime.manifest.idsForPath(path)
  if (stale.length > 0 && !(await deleteStoredIds(runtime, stale))) return
  await runtime.manifest.deletePath(path)
}

const reconcileChangedPath = async (
  runtime: VectorStoreRuntime,
  path: string,
  nextIds: readonly string[],
): Promise<void> => {
  const previous = new Set(await runtime.manifest.idsForPath(path))
  const next = new Set(nextIds)
  const stale = [...previous].filter((id) => !next.has(id))
  if (stale.length > 0 && !(await deleteStoredIds(runtime, stale))) return
  await runtime.manifest.replacePath(path, nextIds)
}

const buildVectorStoreBackend = (
  embed: IndexEmbed,
  runtimePromise: Promise<VectorStoreRuntime | null>,
  metrics?: SearchIndexMetrics,
  nowMs?: () => number,
): SemanticBackend => {
  const readiness: Promise<SemanticReadiness> = runtimePromise.then((runtime) =>
    runtime === null
      ? { kind: "unavailable" as const, reason: "vector store unavailable", phase: "init" as const }
      : READY,
  )
  const ensureRuntime = async (): Promise<VectorStoreRuntime> => {
    await awaitReady(readiness)
    const runtime = await runtimePromise
    if (runtime === null) {
      throw new SemanticBackendUnavailableError("vector store unavailable", "init")
    }
    return runtime
  }
  return {
    state: "ready",
    readiness,
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const runtime = await ensureRuntime()
        const t0 = nowOrDate(nowMs)
        const r = await runtime.store.query(vec, k)
        safeObserve(metrics, "search.index.query.latency_ms", nowOrDate(nowMs) - t0, {
          store: runtime.storeLabel,
        })
        if (!r.ok) {
          throw new SemanticBackendUnavailableError(
            `search index ${runtime.storeLabel} query failed: ${r.error.kind}`,
            "operation",
          )
        }
        return mapStoredHits(r.value)
      },
    },
    upsert: {
      async upsert(chunk: IndexerFileChunk): Promise<void> {
        const runtime = await ensureRuntime()
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
          throw new SemanticBackendUnavailableError(
            `search index ${runtime.storeLabel} upsert failed: ${r.error.kind}`,
            "operation",
          )
        }
        const prev = await runtime.manifest.idsForPath(chunk.path)
        if (!prev.includes(id)) await runtime.manifest.replacePath(chunk.path, [...prev, id])
      },
      async delete(path: string): Promise<void> {
        const runtime = await ensureRuntime()
        const ids = await runtime.manifest.idsForPath(path)
        if (ids.length === 0) return
        const r = await runtime.store.delete(ids)
        if (!r.ok) {
          throw new SemanticBackendUnavailableError(
            `search index ${runtime.storeLabel} delete failed: ${r.error.kind}`,
            "operation",
          )
        }
        await runtime.manifest.deletePath(path)
      },
    },
    reconcileChanges: async (batch: SemanticReconcileBatch): Promise<void> => {
      const runtime = await ensureRuntime()
      for (const path of batch.deletedPaths) {
        await reconcileDeletedPath(runtime, path)
      }
      for (const [path, nextIds] of batch.changedPaths) {
        await reconcileChangedPath(runtime, path, nextIds)
      }
    },
  }
}

const newDisabledBackend = (reason: string): SemanticBackend => {
  const readiness = Promise.resolve({
    kind: "unavailable" as const,
    reason,
    phase: "init" as const,
  })
  const fail = async (): Promise<never> => {
    throw new SemanticBackendUnavailableError(reason, "init")
  }
  return {
    state: "failed",
    stateReason: reason,
    readiness,
    port: {
      query: fail,
    },
    upsert: {
      upsert: fail,
      delete: fail,
    },
  }
}

/**
 * Open the persist database. `QUANTA_INDEX_DB_PATH` names a file; absent ⇒
 * an in-process `:memory:` db (persist-shaped store, no on-disk file). Build
 * failures degrade to `null` so the caller can fall back to in-memory.
 */
export const buildSemanticBackend = (
  env: Record<string, string | undefined>,
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
    logger.error(
      `search index store ${reason}; semantic backend FAILED (explicit store, fail-closed).`,
    )
    return newDisabledBackend(reason)
  }
  const runtime = buildVectorStoreRuntime(env, selection, resolvedEmbedder, opts)
  const runtimeOrNull = runtime.then(unwrapRuntime)
  const fallback = newInMemoryBackend(embed, opts.metrics, opts.nowMs, "legacy-fallback")
  const vectorBacked = buildVectorStoreBackend(embed, runtimeOrNull, opts.metrics, opts.nowMs)
  const explicitDisabled = selection.kind === "explicit"
  const throwIfUnusable = async (): Promise<VectorStoreRuntime | "fallback"> => {
    const resolved = await runtime
    if (isSpaceRefused(resolved)) {
      throw new SemanticBackendUnavailableError(resolved.reason, "init")
    }
    if (resolved !== null) return resolved
    if (explicitDisabled) {
      throw new SemanticBackendUnavailableError(
        `explicit ${selection.provider} store unavailable`,
        "init",
      )
    }
    return "fallback"
  }
  const readiness: Promise<SemanticReadiness> = runtime.then((resolved) => {
    if (isSpaceRefused(resolved)) {
      return { kind: "unavailable" as const, reason: resolved.reason, phase: "init" as const }
    }
    if (resolved !== null) return READY
    if (explicitDisabled) {
      return {
        kind: "unavailable" as const,
        reason: `explicit ${selection.provider} store unavailable`,
        phase: "init" as const,
      }
    }
    return READY
  })
  return {
    state: "ready",
    readiness,
    port: {
      async query(vec, k) {
        const dest = await throwIfUnusable()
        return dest === "fallback" ? fallback.port.query(vec, k) : vectorBacked.port.query(vec, k)
      },
    },
    upsert: {
      async upsert(chunk) {
        const dest = await throwIfUnusable()
        return dest === "fallback"
          ? fallback.upsert.upsert(chunk)
          : vectorBacked.upsert.upsert(chunk)
      },
      async delete(path) {
        const dest = await throwIfUnusable()
        return dest === "fallback" ? fallback.upsert.delete(path) : vectorBacked.upsert.delete(path)
      },
    },
    reconcileChanges: async (batch) => {
      const dest = await throwIfUnusable()
      if (dest === "fallback") return
      await vectorBacked.reconcileChanges?.(batch)
    },
  }
}
