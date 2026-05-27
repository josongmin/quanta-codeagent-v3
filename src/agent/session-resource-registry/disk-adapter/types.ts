/**
 * ADR-0348 — Disk-persistent session-resource registry (types).
 *
 * Extends ADR-0345's in-memory registry with an optional disk-persistence
 * layer so process crashes / restarts can recover prior session resources
 * (typed history events + system-prompt cache entries) without losing the
 * accumulated state.
 *
 * # Scope
 *
 * - PER-SESSION JSONL FILES under `storageDir/<sessionId>/events.jsonl` +
 *   `storageDir/<sessionId>/prompt-cache.jsonl`. Newline-delimited JSON;
 *   one event / cache entry per line.
 * - DEFAULT-OFF — `createDiskSessionResourceRegistry` is an explicit
 *   opt-in factory. The in-memory adapter remains the default.
 * - SINGLE-WRITER assumption — composition roots holding the registry
 *   serialize their writes per session. Multi-process locking is OUT
 *   OF SCOPE (see ADR-0348 §Non-goals).
 *
 * # Non-goals
 *
 * - sqlite backend (separate ADR if ever needed — see Codex `logs_2.sqlite`
 *   retention pattern for inspiration)
 * - cross-machine replication
 * - multi-process file locking / concurrent-writer arbitration
 * - schema migration across persistence format versions (the file format
 *   is internal — readers tolerate unknown lines via NO-THROW deserialize)
 *
 * # File-format contract
 *
 * `events.jsonl` lines:
 *   `{"kind":"context_update","field":"cwd","prev":"/a","next":"/b","at":1,"turnId":"t1"}`
 *   one `TypedHistoryEvent` per line (ADR-0320 closed union).
 *
 * `prompt-cache.jsonl` lines:
 *   `{"key":"sess-1","text":"...","contentHash":"sha256:...","builtAt":12345}`
 *   one cache entry per line.
 *
 * `meta.json` — single-object snapshot for `lastTouched`:
 *   `{"sessionId":"sess-1","lastTouched":12345}`
 *
 * No header line. No trailer. Truncation is acceptable mid-line —
 * the deserializer drops the partial line via NO-THROW and continues.
 */

import type { SystemPromptCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"
import type { AcquireSessionLockOpts } from "./file-lock"

/**
 * Construction-time config for the disk-backed registry. `ttlMs` /
 * `maxSessionBytes` / `now` are optional; the defaults follow Codex
 * `logs_2.sqlite` retention discipline (memory `codex-logs-retention-pattern`)
 * but more conservative.
 */
export interface DiskRegistryConfig {
  /** Root directory for per-session jsonl files. Each session lands at
   *  `<storageDir>/<sessionId>/{events,prompt-cache}.jsonl`. The slice
   *  creates the directory tree lazily on first write. */
  readonly storageDir: string
  /**
   * Idle TTL in milliseconds. Files whose meta.json `lastTouched` lies
   * more than `ttlMs` in the past are swept on the next `getOrCreate`
   * / explicit `sweepDiskRegistry` call.
   *
   * Default: 14 days (1_209_600_000 ms). Conservative vs Codex's
   * ~10-day cap: long enough that a weekend + a long task chain still
   * resumes; short enough that abandoned sessions don't accumulate
   * indefinitely.
   */
  readonly ttlMs?: number
  /**
   * Per-session max byte budget across `events.jsonl` + `prompt-cache.jsonl`.
   * When exceeded, the oldest entries are truncated until under cap.
   *
   * Default: 50 MB (50_000_000). Same order as Codex's per-session
   * cap (`memory/codex-logs-retention-pattern` — 14 GB total over
   * thousands of sessions ≈ tens of MB per session) but tighter on
   * a single-session ceiling.
   */
  readonly maxSessionBytes?: number
  /** Clock seam. Default `Date.now`. */
  readonly now?: () => number
  /**
   * ADR-0356 — Multi-process lockfile knobs. When set (even partially)
   * the disk-store uses the provided values; otherwise the defaults
   * from {@link file-lock} (5 s timeout / 100 ms retry / 30 s stale).
   *
   * The lock itself is ALWAYS engaged — these options only tune the
   * acquisition policy. Failure to acquire degrades to in-memory only
   * (the disk-mirror writes are suppressed for that session) so the
   * default-OFF byte-identical contract holds: a single-process
   * deployment never observes contention and behaves exactly as
   * before the ADR.
   */
  readonly lock?: AcquireSessionLockOpts
}

/** One persisted cache entry as serialized on disk. The on-disk shape
 *  intentionally does NOT carry the branded `SystemPromptCacheKey`
 *  brand — JSON has no notion of brands. The deserializer re-applies
 *  `asCacheKey` to widen on load. */
export interface PersistedCacheEntry {
  readonly key: SystemPromptCacheKey
  readonly text: string
  readonly contentHash: string
  readonly builtAt: number
}

/**
 * Persisted snapshot of one session. Returned by the deserialize helper
 * + consumed by the disk-store's "rehydrate from disk" path. The shape
 * mirrors `SessionResources` (ADR-0345) extended with metadata for
 * lifecycle bookkeeping (`lastTouched`).
 */
export interface PersistedSessionResources {
  readonly sessionId: string
  readonly events: readonly TypedHistoryEvent[]
  readonly cacheEntries: readonly PersistedCacheEntry[]
  readonly lastTouched: number
}

/**
 * One line of `events.jsonl` — verbatim `TypedHistoryEvent` JSON.
 */
export type EventLine = TypedHistoryEvent

/**
 * One line of `prompt-cache.jsonl` — the on-disk projection of one
 * `CachedPrompt`. The brand is dropped on the wire (see
 * {@link PersistedCacheEntry}).
 */
export interface CacheLine {
  readonly key: string
  readonly text: string
  readonly contentHash: string
  readonly builtAt: number
}

/**
 * Default TTL: 14 days. See {@link DiskRegistryConfig.ttlMs}.
 */
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Default per-session byte cap: 50 MB. See
 * {@link DiskRegistryConfig.maxSessionBytes}.
 */
export const DEFAULT_MAX_SESSION_BYTES = 50_000_000
