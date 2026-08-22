/**
 * ADR-0326 — System prompt cache (closed port).
 *
 * Codex pins the equivalent invariant in code: `turn.rs:923` reads
 * `let base_instructions = sess.get_base_instructions().await` on every
 * sampling request, but the session-level value is populated once at
 * session start (`session.rs ~555`) and never mutated mid-session — so
 * each call after the first is a cache hit. Quanta's `buildSystemPrompt`
 * (`src/agent/prompt.ts:40-70`) is a pure sync arrow returning `string`,
 * so a sync port is the right shape; a future async `buildSystemPrompt`
 * would warrant a separate port + ADR (the wire-up surface differs).
 *
 * # Closed-port contract
 *
 *  1. **`getOrBuild`**: hit ⇒ return cached {@link CachedPrompt}, factory
 *     NOT called, `hits` counter bumped. Miss ⇒ call `factory()`, store
 *     the produced text + its hash + `builtAt`, return, `misses`
 *     bumped. If `factory` throws, NO entry is stored, NO counter
 *     moves, the throw propagates verbatim.
 *  2. **`peek`**: hit ⇒ return cached `CachedPrompt`; miss ⇒ `null`.
 *     Read-only — never invokes the factory, never mutates state, never
 *     bumps counters. Used by observability surfaces that want to see
 *     "is this key already warm?" without paying a build.
 *  3. **`invalidate`**: drop ONE entry by key. Idempotent (unknown key
 *     ⇒ no-op, counter unchanged). Each NON-no-op call bumps
 *     `invalidations`. `reason` is surfaced to observability — never
 *     used to gate the drop itself.
 *  4. **`clearAll`**: drop EVERY entry. Each dropped entry bumps
 *     `invalidations` (so the counter mirrors the actual drop count, not
 *     just "clearAll was called"). Calling `clearAll` on an empty cache
 *     is a no-op, counter unchanged.
 *  5. **`stats`**: returns a snapshot of the counters AT THE TIME OF
 *     THE CALL. The result is a plain frozen-shape `readonly` interface;
 *     to see fresh values, call `stats()` again. NO subscriptions, NO
 *     mutation surface here.
 *
 * # Concurrency
 *
 * Single-threaded model (Node event loop). The port surface is
 * synchronous, so two `getOrBuild` calls cannot interleave within one
 * microtask. A multi-threaded / worker-pool scenario is OUT OF SCOPE
 * for this slice — see ADR-0326 §Non-goals.
 *
 * # Slice fence
 *
 * This file imports ONLY from sibling files inside this slice (`types.ts`).
 * No `@/agent`, no `@/llm` cross-slice imports. The implementation
 * adapter (`in-memory-cache.ts`) imports `./hash.ts` (which itself only
 * imports `node:crypto`). Plane-clean by construction.
 */

import type { CachedPrompt, CacheStats, InvalidationReason, SystemPromptCacheKey } from "./types"

/**
 * The closed port. See file-header docblock for the full contract.
 */
export interface SystemPromptCachePort {
  /** Returns cached prompt for key. If absent, calls `factory()`,
   *  caches, returns. NO-THROW unless `factory` itself throws (in which
   *  case state is unchanged). */
  getOrBuild(key: SystemPromptCacheKey, factory: () => string): CachedPrompt
  /** Returns cached prompt or `null`. Read-only — never calls factory. */
  peek(key: SystemPromptCacheKey): CachedPrompt | null
  /** Invalidate one entry. Idempotent (unknown key ⇒ no-op). */
  invalidate(key: SystemPromptCacheKey, reason: InvalidationReason): void
  /** Drop all entries. Session boundary or test reset. */
  clearAll(reason: InvalidationReason): void
  /** Stats snapshot for observability. */
  stats(): CacheStats
}
