/**
 * ADR-0207 — `Stage1OutputsStore` closed port.
 *
 * Sync, in-process. Mirrors Codex `stage1_outputs` table semantics:
 * one entry per `threadId` (PK), with usage tracking (`touch`),
 * Phase 2 selection (`markSelectedForPhase2`), filtered enumeration
 * (`list`), and LRU/age pruning (`prune`).
 *
 * Implementations live in `./in-memory.ts` and `./jsonl-file.ts`.
 * A future sqlite-backed impl satisfies the same port without
 * reaching into either default. No caller imports the impl
 * directly — the composition root constructs and hands back the
 * port type.
 *
 * Contract details (cross-impl):
 *  - `get(unknown threadId)` returns `null` (NOT throw).
 *  - `touch` / `markSelectedForPhase2` on an unknown threadId is a
 *    silent no-op (entry was pruned out from under the caller;
 *    the contract is fire-and-forget on the mutate side).
 *  - `put` REPLACES on duplicate `threadId`.
 *  - All returned entries (and arrays) are FROZEN — mutation
 *    attempts throw in strict mode.
 *  - `prune` returns the number of entries evicted.
 *  - At least one of `olderThanMs` or `maxEntries` MUST be set on
 *    `prune`; passing neither is a no-op returning 0.
 */

import type { Stage1Entry } from "./types"

export interface Stage1ListFilter {
  /** Only return entries where `selectedForPhase2 === filter.selectedForPhase2`. */
  readonly selectedForPhase2?: boolean
  /** Only return entries where `usageCount >= filter.minUsage`. */
  readonly minUsage?: number
}

export interface Stage1PruneOpts {
  /** Evict entries whose `now - generatedAt > olderThanMs`. */
  readonly olderThanMs?: number
  /** After age-prune (if any), evict by ascending `lastUsage` until
   *  remaining count <= `maxEntries`. */
  readonly maxEntries?: number
}

export interface Stage1OutputsStore {
  /** Returns the (frozen) entry for `threadId`, or `null` if absent. */
  get(threadId: string): Stage1Entry | null
  /** Insert or replace under `entry.threadId`. */
  put(entry: Stage1Entry): void
  /** Increment `usageCount` by 1 and stamp `lastUsage` to clock.
   *  Silent no-op when `threadId` is unknown. */
  touch(threadId: string): void
  /** Set `selectedForPhase2 = true` and snapshot the live
   *  `sourceUpdatedAt` so Phase 2 can invalidate on source mutation.
   *  Silent no-op when `threadId` is unknown. */
  markSelectedForPhase2(threadId: string, sourceUpdatedAt: number): void
  /** Frozen array of (frozen) entries matching the optional filter.
   *  Iteration order is insertion order (Map semantics). */
  list(filter?: Stage1ListFilter): readonly Stage1Entry[]
  /** Returns the number of entries evicted. */
  prune(opts: Stage1PruneOpts): number
}
