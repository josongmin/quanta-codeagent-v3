/**
 * ADR-0345 — `SessionResourceRegistry` closed port.
 *
 * Process-local, in-memory map of `sessionId → { store, cache }` so that
 * re-assembling an `AgentConfig` for the SAME `sessionId` (e.g. session
 * restart, control-op resume, repeated `assembleAgentConfig` calls)
 * REUSES the same `TypedHistoryEventStore` + `SystemPromptCachePort`
 * instances instead of allocating fresh ones.
 *
 * Today every call to `installCodexR2Wires(cfg, { sessionId,
 * store: createInMemoryTypedHistoryEventStore(),
 * systemPromptCache: createInMemorySystemPromptCache(), ... })` creates
 * brand-new in-memory containers. A composition root that revisits a
 * sessionId therefore observes zero prior typed-history events and zero
 * system-prompt cache hits — both regress observability and cache
 * economics for restart / resume flows.
 *
 * # Scope
 *
 * In-memory only (process-local). This ADR does NOT cover:
 *   - cross-process / cross-host sharing (Redis-class — out of scope)
 *   - disk persistence (sqlite/jsonl — separate ADR; see Codex
 *     `logs_2.sqlite` retention pattern)
 *   - distributed locks / concurrent writers
 *
 * # Closed-port contract
 *
 *   1. `getOrCreate(sessionId)` — pure idempotent reader+writer. First
 *      call mints a fresh `{ store, cache }` pair via the registry's
 *      internal factories and caches it under `sessionId`. Every
 *      subsequent call with the SAME `sessionId` returns the SAME
 *      `SessionResources` reference (the core invariant). NO-THROW: a
 *      pathological factory failure is swallowed and a freshly-minted
 *      empty pair is returned (degraded but functional).
 *   2. `peek(sessionId)` — read-only lookup. Hit ⇒ same reference as
 *      the last `getOrCreate`; miss ⇒ `null`. Does NOT create. Does
 *      NOT update `lastTouched` (deliberate — see "LRU policy" below).
 *      Read-only. NO-THROW.
 *   3. `evict(sessionId)` — drops one entry. Idempotent (unknown id ⇒
 *      no-op). NO-THROW.
 *   4. `size()` — current tracked entry count after pending TTL
 *      sweeps. Pure reader. NO-THROW.
 *   5. `clear()` — drops every entry. Used by test reset / shutdown.
 *      NO-THROW.
 *
 * # LRU policy
 *
 * When `maxEntries` is set, every `getOrCreate` checks `size > maxEntries`
 * AFTER the (possible) insertion and evicts the entry with the OLDEST
 * `lastTouched` until `size === maxEntries`. `lastTouched` advances on
 * `getOrCreate` only — `peek` is deliberately read-only so that
 * observability surfaces ("is this id warm?") cannot influence the
 * LRU ordering. The Codex telemetry stack uses the same "read-only
 * peek" discipline for cache stats; we follow.
 *
 * # TTL policy
 *
 * When `idleTtlMs` is set, every `getOrCreate` and `peek` first sweeps
 * the registry for entries whose `(now - lastTouched) >= idleTtlMs` and
 * evicts them. TTL pruning runs BEFORE the (potential) insertion in
 * `getOrCreate`, so a fresh insert never trips its own TTL. TTL also
 * runs before the LRU check, so combining the two caps both age and
 * working-set size.
 *
 * # Concurrency
 *
 * Single-threaded model (Node event loop). All four operations are
 * synchronous; two `getOrCreate` calls cannot interleave within one
 * microtask. Worker-pool scenarios are out of scope.
 */

import type { SystemPromptCachePort } from "@/llm/system-prompt-cache"
import type { TypedHistoryEventStore } from "@/memory/typed-event"

/**
 * The two reusable per-session containers. Each is the same shape as
 * what `installCodexR2Wires` already accepts — composition roots that
 * adopt the registry can swap in
 * `registry.getOrCreate(sessionId).{store,cache}` with no further
 * changes to the install helper or its deps bag.
 */
export interface SessionResources {
  readonly store: TypedHistoryEventStore
  readonly cache: SystemPromptCachePort
}

/**
 * The closed port. See file-header for full per-method contract.
 */
export interface SessionResourceRegistry {
  /** Get-or-create resources for `sessionId`. Idempotent — second call
   *  with the same id returns the SAME `SessionResources` reference
   *  (the core invariant). NO-THROW. */
  getOrCreate(sessionId: string): SessionResources

  /** Peek without create. Hit ⇒ stored reference, miss ⇒ `null`.
   *  Does NOT update `lastTouched`. NO-THROW. */
  peek(sessionId: string): SessionResources | null

  /** Explicit eviction. Idempotent (unknown id ⇒ no-op). NO-THROW. */
  evict(sessionId: string): void

  /** Total tracked sessions (after pending TTL sweeps). */
  size(): number

  /** Drop all. Test reset / shutdown. NO-THROW. */
  clear(): void

  /**
   * ADR-0386 — read-only enumerate of currently tracked session ids.
   *
   * Returns a snapshot array of every session id the in-process backend
   * is currently tracking. The semantics intentionally mirror `size()`:
   *   - For the in-memory backend (ADR-0345) this is `Map.keys()`.
   *   - For the disk backend (ADR-0348) this is the in-process Map
   *     (NOT a filesystem walk — `size()` deliberately does not paginate
   *     the storage dir either; cross-process visibility is out of scope).
   *   - For the sqlite backend (ADR-0361) this is the in-process Map
   *     (NOT a `SELECT session_id FROM sessions`; same reasoning).
   *
   * Order is implementation-defined. Callers MUST treat the order as
   * unstable. The returned array is a snapshot — subsequent registry
   * mutations do NOT mutate it. The reference is typed `readonly` to
   * prevent accidental in-place mutation, but the underlying array is a
   * fresh allocation, not the backing Map's internal storage.
   *
   * NO-THROW: any backend failure ⇒ `[]`. Pathological backends MAY
   * return an empty array even when `size()` reports a non-zero count;
   * callers should not assume `size() === listSessionIds().length` at
   * MAY because of an intervening TTL sweep race (single-thread Node
   * event loop ⇒ this cannot happen within a microtask, but a future
   * worker-pool adapter could surface the gap).
   *
   * R3-audit-note (TTL semantics — backend drift):
   *   - The in-memory adapter (ADR-0345) sweeps `idleTtlMs`-expired
   *     entries before returning, so the list reflects only currently
   *     live ids.
   *   - The disk (ADR-0348) and sqlite (ADR-0361) adapters do NOT
   *     honour `idleTtlMs` on this method — they return the in-process
   *     Map contents directly (eviction happens via the retention
   *     sweep, not via lazy per-call TTL). This is intentional: bulk
   *     callers (e.g. `/session-registry evict --pattern`) walk only
   *     the in-process entries; expired-but-unswept persisted entries
   *     are invisible by construction. ADR-0386 §"Why in-process keys
   *     only" documents the trade-off.
   */
  listSessionIds(): readonly string[]
}

/**
 * Construction-time config. `maxEntries`/`idleTtlMs` are independent —
 * either, both, or neither may be set. `now` is the clock seam for
 * deterministic tests (default `Date.now`).
 */
export interface RegistryConfig {
  /** Optional capacity cap. When set, LRU eviction kicks in. Absent ⇒
   *  unbounded (process-local memory growth — caller responsibility). */
  readonly maxEntries?: number
  /** Optional TTL ms — entries idle longer than this are evicted on
   *  the next `getOrCreate` / `peek` sweep. Absent ⇒ no TTL. */
  readonly idleTtlMs?: number
  /** Clock seam. Default `Date.now`. */
  readonly now?: () => number
}
