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
 * Hierarchical memory tier (RFC §6.3, long-term memory):
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
 * Fields added for long-term memory (`tier`, `importance`, `updatedAt`,
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
   * ADR-0554 — epoch ms the eviction sweep last halved `importance`. Absent on
   * legacy rows (⇒ eligible on the next sweep, as before). Dedicated field:
   * `updatedAt` cannot serve — adapters stamp it on every update and
   * reinforce() on every recall, so it would double-count access.
   */
  lastDecayedAt?: number
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
  // ── §10.6 routing meta (Codex `MEMORY.md` FORMAT) ──────────────────────
  // All OPTIONAL and INERT until a recall query opts into routing weighting
  // (see {@link MemoryQuery.routing}). Absent ⇒ ranking is byte-identical to
  // the legacy weighted-sum, so pre-existing rows/call-sites are unaffected.
  /**
   * Retrieval grouping — Codex `Task Group:` (cwd / project / workflow /
   * detail-task family; broad but distinguishable). Used to boost recall for
   * memories from the same task family as the current query.
   */
  taskGroup?: string
  /**
   * Scope boundary — Codex `applies_to: cwd=...`. The working directory (or
   * cwd family) this memory is scoped to, so future recall does not confuse
   * similar tasks from different checkouts. `cwd` is matched against the
   * query's routing cwd (exact ⇒ strong boost, family/prefix ⇒ weak boost).
   */
  appliesTo?: AppliesTo
  /**
   * Free-text guidance — Codex `reuse_rule=...`. When this memory is safe to
   * reuse vs when to treat it as checkout-specific / time-specific. Carried for
   * surfacing in recall blocks (advisory); does NOT participate in scoring.
   */
  reuseRule?: string
}

/** §10.6 — structured scope boundary (Codex `applies_to: cwd=...`). */
export interface AppliesTo {
  /** Primary working directory / cwd family / workflow scope this memory covers. */
  cwd?: string
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
/**
 * Carry `value` onto `out` under `key`, or DELETE the key when the projector
 * rejected the input (`undefined`).
 *
 * ONE unit because all five tolerant optional fields below share exactly this
 * shape: `exactOptionalPropertyTypes` forbids assigning `undefined`, so
 * "absent" must be spelled `delete`, and the `...e` spread may already have put
 * a garbage value under the key. Spelling that out per-field was the bulk of
 * `normalizeEntry`'s cognitive-complexity score.
 */
const carryOrDrop = (out: Record<string, unknown>, key: string, value: unknown): void => {
  if (value === undefined) delete out[key]
  else out[key] = value
}

/**
 * The TABLE of tolerantly-carried optional fields: `[key, projector]`, applied
 * in THIS order (the order is load-bearing — it fixes the key order of a
 * normalized entry whose input lacked the field, since a fresh key is appended
 * at assignment time).
 *
 * Each projector is total: it returns the accepted value, or `undefined` to
 * mean "drop the field". A corrupt persisted row / malformed save must never
 * throw or pollute scoring.
 */
const TOLERANT_FIELDS: ReadonlyArray<readonly [string, (e: MemoryEntry) => unknown]> = [
  // Drop a wrong-length / absent embedding entirely.
  ["embedding", (e) => (e.embedding?.length === EMBED_DIM ? e.embedding : undefined)],
  // ADR-0554 — carry `lastDecayedAt` only when it is a finite number; a corrupt
  // persisted value must degrade to "never decayed" (legacy semantics), not NaN.
  ["lastDecayedAt", (e) => (Number.isFinite(e.lastDecayedAt) ? e.lastDecayedAt : undefined)],
  // §10.6 routing meta — well-typed non-empty values only.
  ["taskGroup", (e) => nonEmptyString(e.taskGroup)],
  ["appliesTo", (e) => projectAppliesTo(e.appliesTo)],
  ["reuseRule", (e) => nonEmptyString(e.reuseRule)],
]

/** Accept a non-empty string, else `undefined`. Shared by the two §10.6 string
 *  fields so their acceptance rule cannot drift apart. */
const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** Accept `{ cwd }` only when `cwd` is a non-empty string; a fresh object is
 *  built so the normalized entry never aliases the caller's input. */
const projectAppliesTo = (v: MemoryEntry["appliesTo"]): { cwd: string } | undefined => {
  const cwd = typeof v === "object" && v !== null ? nonEmptyString(v.cwd) : undefined
  return cwd === undefined ? undefined : { cwd }
}

export const normalizeEntry = (e: MemoryEntry): NormalizedEntry => {
  const createdAt = Number.isFinite(e.createdAt) ? e.createdAt : 0
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
  const bag = out as unknown as Record<string, unknown>
  for (const [key, project] of TOLERANT_FIELDS) carryOrDrop(bag, key, project(e))
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
  /**
   * §10.6 recall routing context. **Opt-in** — when present, entries whose
   * routing meta ({@link MemoryEntry.taskGroup} / {@link MemoryEntry.appliesTo})
   * matches this context are scored UP (a soft refine, never a hard filter).
   * Absent ⇒ ranking is byte-identical to the legacy weighted-sum. The
   * composition root populates this only when `QUANTA_MEMORY_ROUTING` is on.
   */
  routing?: RoutingContext
}

/**
 * §10.6 — the current turn's routing context, compared against each entry's
 * routing meta during recall. Both fields optional; an empty `{}` yields zero
 * boost (byte-identical to no routing).
 */
export interface RoutingContext {
  /** Current task family — compared (case-insensitive, exact) to {@link MemoryEntry.taskGroup}. */
  taskGroup?: string
  /** Current working directory — compared to {@link MemoryEntry.appliesTo} cwd
   *  (exact ⇒ strong boost; one is a path-prefix of the other ⇒ family boost). */
  cwd?: string
}

/** Default {@link MemoryQuery.limit}. */
export const DEFAULT_RECALL_LIMIT = 20
