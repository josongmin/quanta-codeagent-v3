// Memory slice domain types.
//
// @/llm-isolation workaround (RFC §3.1, biome.json src/memory/** override):
// the memory slice is forbidden from importing @/llm, yet WorkingMemory must
// hold the same message objects the agent layer passes around. Importing the
// concrete `Message` type would violate slice isolation. Instead we declare a
// minimal *structural* shape (`StoredMessage`) that the real llm `Message`
// (`{ role: "user" | "assistant"; content: ContentBlock[] }`) is assignable to,
// and make WorkingMemory generic over it (defaulting to StoredMessage). The
// agent layer can instantiate `WorkingMemory<Message>` for full typing without
// memory ever depending on @/llm. Structural typing keeps this import-legal and
// still ergonomic.

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
export type MemoryKind = "fact" | "decision" | "observation"

/** A single durable memory record. */
export interface MemoryEntry {
  id: string
  kind: MemoryKind
  text: string
  tags: string[]
  /** Epoch milliseconds the entry was created. */
  createdAt: number
  /** Optional originating session id. */
  sessionId?: string
}

/**
 * Derived recency tier for an entry, computed from its age.
 *
 * Thresholds (age = now - createdAt, in ms), boundaries are inclusive of the
 * lower (fresher) tier — i.e. an age exactly equal to a threshold stays in the
 * fresher bucket:
 *
 * - `fresh`    : age \<= 1h            (FRESH_MAX_MS)
 * - `recent`   : 1h \< age \<= 24h     (RECENT_MAX_MS)
 * - `stale`    : 24h \< age \<= 30d    (STALE_MAX_MS)
 * - `archived` : age \> 30d
 *
 * Negative or NaN ages (createdAt in the future, e.g. clock skew, or
 * undefined arithmetic) are treated as 0 and therefore bucket as `fresh`.
 * A positive infinite age buckets as `archived`.
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
  const age = ageMs
  if (age <= FRESH_MAX_MS) return "fresh"
  if (age <= RECENT_MAX_MS) return "recent"
  if (age <= STALE_MAX_MS) return "stale"
  return "archived"
}

/** Query passed to {@link PersistentStorePort.recall}. */
export interface MemoryQuery {
  /** Case-insensitive substring matched against entry text. */
  text?: string
  /** Entries must overlap at least one of these tags (if provided). */
  tags?: string[]
  /** Restrict to these kinds (if provided). */
  kinds?: MemoryKind[]
  /** Max entries to return. Defaults to {@link DEFAULT_RECALL_LIMIT}. */
  limit?: number
  /** Restrict to entries whose freshness bucket is in this set (if provided). */
  freshness?: FreshnessBucket[]
}

/** Default {@link MemoryQuery.limit}. */
export const DEFAULT_RECALL_LIMIT = 20
