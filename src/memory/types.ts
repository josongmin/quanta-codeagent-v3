// Memory slice domain types.
//
// @/llm-isolation workaround (RFC §3.1, biome.json src/memory/** override):
// the memory slice is forbidden from importing @/llm, yet two things must
// interoperate with it:
//
//  1. WorkingMemory must hold the same message objects the agent layer passes
//     around. Importing the concrete `Message` type would violate slice
//     isolation, so we declare a minimal *structural* shape (`StoredMessage`)
//     that the real llm `Message` is assignable to, and make WorkingMemory
//     generic over it.
//
//  2. Semantic recall needs embeddings, which only a provider (llm slice) can
//     produce. The memory slice therefore owns an injected {@link EmbedderPort}
//     interface; the concrete OpenAI implementation lives in @/agent (the only
//     cross-slice importer). Structural typing keeps both import-legal.

/**
 * Minimal structural message shape. The llm slice's `Message`
 * (`{ role: "user" | "assistant"; content: ContentBlock[] }`) is assignable to
 * this, so `WorkingMemory<Message>` works without importing @/llm.
 */
export interface StoredMessage {
  role: string
  content: unknown
}

/** Kind of long-term memory record. */
export type MemoryKind = "fact" | "decision" | "observation" | "preference"

/** All valid {@link MemoryKind} values, for adapter validation / iteration. */
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision", "observation", "preference"]

/**
 * Hierarchical memory tier (RFC §6.3, SOTA++ memory):
 * - `episodic`  : raw per-session events / summaries, time-indexed, evicted fast.
 * - `semantic`  : distilled, deduplicated, durable knowledge (the long-term core).
 *
 * `working` memory is *not* a tier here — it is the in-session message buffer
 * ({@link import("./working").WorkingMemory}), never persisted to the store.
 */
export type MemoryTier = "episodic" | "semantic"

/** All valid {@link MemoryTier} values. */
export const MEMORY_TIERS: readonly MemoryTier[] = ["episodic", "semantic"]

/**
 * Embedding dimensionality. Matches OpenAI `text-embedding-3-small` (1536).
 * Stored vectors of a different length are treated as "no embedding" by the
 * ranking layer rather than throwing (model/version drift tolerance).
 */
export const EMBED_DIM = 1536

/**
 * A single durable memory record.
 *
 * Fields added for SOTA++ memory (`tier`, `importance`, `updatedAt`,
 * `accessCount`, `lastAccessedAt`, `embedding`, `supersededBy`) are all
 * **optional** so pre-existing call sites and persisted rows remain valid.
 * {@link normalizeEntry} applies documented runtime defaults at the store
 * boundary, so consumers downstream can rely on them being present.
 */
export interface MemoryEntry {
  id: string
  kind: MemoryKind
  /** Defaults to `"semantic"` via {@link normalizeEntry}. */
  tier?: MemoryTier
  text: string
  tags: string[]
  /**
   * Relevance/value weight in `[0, 1]`. Drives ranking and eviction.
   * Defaults to `0.5`. Clamped to the range by {@link normalizeEntry}.
   */
  importance?: number
  /** Epoch ms the entry was created. */
  createdAt: number
  /** Epoch ms of the last write (merge/supersede/self-edit). Defaults to `createdAt`. */
  updatedAt?: number
  /** Times this entry was returned by recall. Defaults to `0`. Used for reinforcement. */
  accessCount?: number
  /** Epoch ms it was last recalled, if ever. */
  lastAccessedAt?: number
  /**
   * Semantic embedding (length {@link EMBED_DIM}). Absent ⇒ entry participates
   * in lexical/tag/freshness ranking only. A wrong-length vector is ignored.
   */
  embedding?: number[]
  /**
   * If set, this entry was consolidated into / replaced by the entry with this
   * id. Excluded from recall unless {@link MemoryQuery.includeSuperseded}.
   */
  supersededBy?: string
  /** Optional originating session id. */
  sessionId?: string
}

/**
 * A {@link MemoryEntry} after {@link normalizeEntry}: every optional field is
 * resolved to its default. Ranking / eviction / dedup operate on this shape.
 */
export interface NormalizedEntry extends MemoryEntry {
  tier: MemoryTier
  importance: number
  updatedAt: number
  accessCount: number
}

/** Clamp helper (also maps NaN → `lo`). */
const clamp = (n: number, lo: number, hi: number): number =>
  Number.isNaN(n) ? lo : n < lo ? lo : n > hi ? hi : n

/**
 * Apply documented defaults to an entry. Idempotent and pure. Called by every
 * adapter on the `save` / `recall` boundary so the rest of the slice (and
 * @/agent) can treat the optional fields as always-present.
 *
 * Defaults: `tier="semantic"`, `importance=0.5` (clamped to [0,1]),
 * `updatedAt=createdAt`, `accessCount=0` (clamped ≥0, integer). An `embedding`
 * whose length ≠ {@link EMBED_DIM} is dropped.
 */
export const normalizeEntry = (e: MemoryEntry): NormalizedEntry => {
  const createdAt = Number.isFinite(e.createdAt) ? e.createdAt : 0
  const embedding = e.embedding && e.embedding.length === EMBED_DIM ? e.embedding : undefined
  const out: NormalizedEntry = {
    ...e,
    kind: MEMORY_KINDS.includes(e.kind) ? e.kind : "observation",
    tier: e.tier && MEMORY_TIERS.includes(e.tier) ? e.tier : "semantic",
    tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [],
    importance: clamp(e.importance ?? 0.5, 0, 1),
    createdAt,
    updatedAt: Number.isFinite(e.updatedAt) ? (e.updatedAt as number) : createdAt,
    accessCount: Math.max(0, Math.floor(e.accessCount ?? 0)) || 0,
  }
  // Drop a wrong-length / absent embedding entirely (exactOptionalPropertyTypes:
  // an explicit `embedding: undefined` is not assignable to `embedding?:`).
  if (embedding) out.embedding = embedding
  else delete out.embedding
  return out
}

/**
 * Injected embedding provider (memory must not import @/llm — see file header).
 * The concrete implementation lives in @/agent.
 */
export interface EmbedderPort {
  /**
   * Embed each input string. Resolves to one vector per input, in order, each
   * of length {@link EMBED_DIM}. Implementations should batch internally and
   * may throw on transport failure (callers degrade to lexical recall).
   */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Derived recency tier for an entry, computed from its age.
 *
 * Thresholds (age = now - createdAt, in ms); boundaries are inclusive of the
 * fresher tier:
 *
 * - `fresh`    : age \<= 1h            (FRESH_MAX_MS)
 * - `recent`   : 1h \< age \<= 24h     (RECENT_MAX_MS)
 * - `stale`    : 24h \< age \<= 30d    (STALE_MAX_MS)
 * - `archived` : age \> 30d
 *
 * Negative/NaN ages (clock skew) clamp to 0 (`fresh`); +Infinity → `archived`.
 */
export type FreshnessBucket = "fresh" | "recent" | "stale" | "archived"

/** age \<= this → `fresh` (1 hour). */
export const FRESH_MAX_MS = 60 * 60 * 1000
/** age \<= this → `recent` (24 hours). */
export const RECENT_MAX_MS = 24 * 60 * 60 * 1000
/** age \<= this → `stale` (30 days). */
export const STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Pure mapping of an age (ms) to its {@link FreshnessBucket}.
 * NaN / negative ages clamp to 0 (`fresh`); +Infinity → `archived`.
 */
export const bucketOf = (ageMs: number): FreshnessBucket => {
  if (Number.isNaN(ageMs) || ageMs <= 0) return "fresh"
  if (ageMs <= FRESH_MAX_MS) return "fresh"
  if (ageMs <= RECENT_MAX_MS) return "recent"
  if (ageMs <= STALE_MAX_MS) return "stale"
  return "archived"
}

/** Query passed to {@link import("./ports").PersistentStorePort.recall}. */
export interface MemoryQuery {
  /** Case-insensitive substring scored against entry text (no longer a hard filter). */
  text?: string
  /**
   * Semantic query vector (length {@link EMBED_DIM}). When present and an entry
   * has an embedding, cosine similarity dominates the score. This is what makes
   * recall robust to paraphrase.
   */
  embedding?: number[]
  /** Entries must overlap at least one of these tags (if provided). */
  tags?: string[]
  /** Restrict to these kinds (if provided). */
  kinds?: MemoryKind[]
  /** Restrict to these tiers (if provided). */
  tiers?: MemoryTier[]
  /** Max entries to return. Defaults to {@link DEFAULT_RECALL_LIMIT}. */
  limit?: number
  /** Restrict to entries whose freshness bucket is in this set (if provided). */
  freshness?: FreshnessBucket[]
  /** Drop entries with `importance` below this (if provided). */
  minImportance?: number
  /** Include `supersededBy`-marked entries (default `false`). */
  includeSuperseded?: boolean
}

/** Default {@link MemoryQuery.limit}. */
export const DEFAULT_RECALL_LIMIT = 20
