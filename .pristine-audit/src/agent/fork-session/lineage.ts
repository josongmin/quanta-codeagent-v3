/**
 * Lineage tracker (ADR-0201).
 *
 * `Map<sessionId, { parent, forkedAt }>` with:
 *   - cycle guard on `attach` (walks the parent chain; rejects on contact),
 *   - LRU eviction on cap (mirrors `ConversationCheckpointStore`),
 *   - read-only `chain` walk for tests / UI.
 *
 * This sits SEPARATE from `ConversationCheckpointStore.lineageOf` because the
 * store's `lineageOf` is a passive read of the store's own internal map (it
 * tracks WHAT was cloned). This tracker is the ACTIVE attach API the forker
 * mutates explicitly, and the place where the cycle guard lives.
 *
 * Plane-clean: imports `@/shared` for `Result` + sibling types only.
 */

import { err, ok, type Result } from "@/shared"
import type { ForkError } from "./types"

/** One node in the lineage map. */
export interface LineageEntry {
  /** Parent session id (`null` for a root). */
  readonly parent: string | null
  /** Epoch-ms timestamp at attach time. */
  readonly forkedAt: number
}

export interface Lineage {
  /** Record `child → parent` with `forkedAt = now`. Rejects with
   *  `lineage-cycle` when `child` is already an ancestor of `parent` (walking
   *  the parent chain from `parent` up to root must NOT touch `child`).
   *  Rejects with `duplicate-id` when `child` already has an entry (an id
   *  has exactly one parent). */
  attach(child: string, parent: string): Result<LineageEntry, ForkError>
  /** Look up a single entry. Missing id ⇒ `null` (treated as a root by
   *  callers that walk the chain). */
  get(id: string): LineageEntry | null
  /** Walk the parent chain newest → oldest, INCLUDING `id` itself as the head
   *  when it is known. An unknown id produces an empty array. */
  chain(id: string): ReadonlyArray<string>
  /** Diagnostic — current entry count (after any LRU eviction). */
  size(): number
  /** Remove every entry. */
  clear(): void
}

export interface LineageOpts {
  /** Cap on entries. Default 200 (same magnitude as the snapshot cap). */
  readonly maxEntries?: number
  /** Injected clock. Default `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_MAX_ENTRIES = 200

export const defaultLineage = (opts?: LineageOpts): Lineage => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const now = opts?.now ?? Date.now
  // Map iteration is insertion-order → oldest-first. We delete + re-set on
  // every successful `attach` so the touched entry moves to the newest slot
  // (LRU-by-write parity with ConversationCheckpointStore).
  const entries = new Map<string, LineageEntry>()

  const ancestorsOf = (id: string): Set<string> => {
    const out = new Set<string>()
    let cursor: string | null = id
    // Guard against a malformed pre-existing cycle (defensive — `attach`
    // refuses to ever create one) by capping the walk at the entry count.
    let hops = 0
    while (cursor !== null && hops <= entries.size) {
      const e = entries.get(cursor)
      if (e === undefined) break
      const next = e.parent
      if (next === null) break
      if (out.has(next)) break
      out.add(next)
      cursor = next
      hops += 1
    }
    return out
  }

  const evictIfOver = (): void => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
  }

  return {
    attach(child, parent) {
      if (entries.has(child)) {
        return err({
          code: "duplicate-id",
          message: `lineage entry already exists for '${child}'`,
        })
      }
      // Cycle check: walk parent's chain — child must NOT appear.
      if (child === parent) {
        return err({
          code: "lineage-cycle",
          message: `cycle: '${child}' cannot be its own parent`,
        })
      }
      const ancestors = ancestorsOf(parent)
      if (ancestors.has(child)) {
        return err({
          code: "lineage-cycle",
          message: `cycle: '${child}' is already an ancestor of '${parent}'`,
        })
      }
      const entry: LineageEntry = { parent, forkedAt: now() }
      entries.set(child, entry)
      evictIfOver()
      return ok(entry)
    },

    get(id) {
      const e = entries.get(id)
      return e === undefined ? null : e
    },

    chain(id) {
      if (!entries.has(id)) return []
      const out: string[] = [id]
      let cursor: string | null = id
      let hops = 0
      while (cursor !== null && hops <= entries.size) {
        const e = entries.get(cursor)
        if (e === undefined) break
        const next = e.parent
        if (next === null) break
        out.push(next)
        cursor = next
        hops += 1
      }
      return out
    },

    size() {
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}
