/**
 * Parent-link metadata store (ADR-0226).
 *
 * Sibling to `Lineage` (ADR-0201): where `Lineage` tracks the abstract
 * child→parent chain over snapshot IDs, this slice tracks the richer
 * ForkSession-level parent metadata: parent session id, branch name,
 * branch point checkpoint id, forked-at timestamp. The CLI `/fork` +
 * the `ForkSessionPort.listBranches` / `resolveParent` read here.
 *
 * Design contract:
 *   - In-memory ONLY — durable persistence is a follow-up (mirrors
 *     `ConversationCheckpointStore`'s scope).
 *   - CAPPED LRU (touched on `record` / `getByChild`) so a long-running
 *     daemon never grows unbounded. Default cap 500 entries.
 *   - listBranches(parent) returns children NEWEST-FIRST (matches the
 *     `ConversationCheckpointStore.list()` shape).
 *   - exactOptionalPropertyTypes — `branchName` is OMITTED, never
 *     `undefined`, on a `ParentLink` entry.
 *   - No-throw on the public surface (every misuse returns `null` /
 *     empty / `false`).
 *
 * Plane-clean: imports `@/shared` only.
 */

/** One parent-link entry. `branchName` is optional — the caller
 *  may fork without naming the branch (e.g. silent multi-fork). */
export interface ParentLink {
  /** Child session id (the new session minted by the fork). */
  readonly childSessionId: string
  /** Parent session id (the session the fork was taken from). */
  readonly parentSessionId: string
  /** Conversation checkpoint id the fork branched FROM. Equal to
   *  `parentSessionId` today (one checkpoint == one session), but kept
   *  distinct so a future per-session multi-checkpoint layer doesn't
   *  break the shape. */
  readonly branchPoint: string
  /** Epoch-ms timestamp at fork time. */
  readonly forkedAt: number
  /** Optional human label. Omitted (NOT `undefined`) when absent so
   *  `exactOptionalPropertyTypes` stays clean. */
  readonly branchName?: string
}

export interface ParentLinkStore {
  /** Record a new link. REPLACES any prior entry for `childSessionId`
   *  (a child has exactly one parent — re-recording reflects an updated
   *  branch label). Triggers LRU eviction on cap. */
  record(link: ParentLink): void
  /** Look up a child's link. Returns `null` when unknown. */
  getByChild(childSessionId: string): ParentLink | null
  /** Enumerate every direct child of `parentSessionId`. Returns
   *  NEWEST-FIRST by `forkedAt`. Empty array when no children. */
  listChildren(parentSessionId: string): ReadonlyArray<ParentLink>
  /** Walk parent chain via `getByChild`. INCLUDES `childSessionId` as
   *  the head when known. Unknown id ⇒ empty array. Capped at the
   *  current entry count to defend against a malformed cycle. */
  ancestry(childSessionId: string): ReadonlyArray<string>
  /** Diagnostic — current entry count. */
  size(): number
  /** Wipe everything. */
  clear(): void
}

export interface ParentLinkStoreOpts {
  /** Max retained entries. Default 500 (an order of magnitude over
   *  `ConversationCheckpointStore`'s 50 — branch labels cost less than
   *  message arrays). */
  readonly maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 500

/** Validate a caller-supplied `ParentLink` for the minimum fields needed
 *  to store it. Returns `true` when every required field is non-empty +
 *  the timestamp is a finite number. Defensive — caller-bug paths return
 *  `false` and the store treats them as no-ops (no throw on the public
 *  surface). */
const isValidLink = (link: ParentLink): boolean => {
  if (typeof link.childSessionId !== "string" || link.childSessionId.length === 0) return false
  if (typeof link.parentSessionId !== "string" || link.parentSessionId.length === 0) return false
  if (typeof link.branchPoint !== "string" || link.branchPoint.length === 0) return false
  if (typeof link.forkedAt !== "number" || !Number.isFinite(link.forkedAt)) return false
  return true
}

/** Re-shape the link onto a fresh object so the stored entry is frozen-safe
 *  and the caller's mutable object cannot leak back in. Honors
 *  exactOptionalPropertyTypes — `branchName` is OMITTED when absent. */
const cloneLink = (link: ParentLink): ParentLink =>
  link.branchName !== undefined
    ? {
        childSessionId: link.childSessionId,
        parentSessionId: link.parentSessionId,
        branchPoint: link.branchPoint,
        forkedAt: link.forkedAt,
        branchName: link.branchName,
      }
    : {
        childSessionId: link.childSessionId,
        parentSessionId: link.parentSessionId,
        branchPoint: link.branchPoint,
        forkedAt: link.forkedAt,
      }

export const defaultParentLinkStore = (opts?: ParentLinkStoreOpts): ParentLinkStore => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  // Map preserves insertion order → oldest-first. We delete + re-insert
  // on touch so LRU-by-write parity matches `ConversationCheckpointStore`.
  const byChild = new Map<string, ParentLink>()

  const evictIfOver = (): void => {
    while (byChild.size > maxEntries) {
      const oldestKey = byChild.keys().next().value
      if (oldestKey === undefined) break
      byChild.delete(oldestKey)
    }
  }

  return {
    record(link) {
      if (!isValidLink(link)) return
      // Re-insertion moves the entry to the "newest" slot (LRU-by-write).
      if (byChild.has(link.childSessionId)) byChild.delete(link.childSessionId)
      byChild.set(link.childSessionId, cloneLink(link))
      evictIfOver()
    },

    getByChild(childSessionId) {
      const e = byChild.get(childSessionId)
      return e === undefined ? null : e
    },

    listChildren(parentSessionId) {
      if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return []
      const out: ParentLink[] = []
      // Iterate all entries — O(n) is fine at 500-entry cap and avoids a
      // duplicate index that would complicate eviction.
      for (const link of byChild.values()) {
        if (link.parentSessionId === parentSessionId) out.push(link)
      }
      // Newest first (highest forkedAt). Stable sort over the iteration
      // order preserves insertion-order tie-breaks.
      out.sort((a, b) => b.forkedAt - a.forkedAt)
      return out
    },

    ancestry(childSessionId) {
      if (!byChild.has(childSessionId)) return []
      const out: string[] = [childSessionId]
      const seen = new Set<string>([childSessionId])
      let cursor: string | null = childSessionId
      let hops = 0
      while (cursor !== null && hops <= byChild.size) {
        const link = byChild.get(cursor)
        if (link === undefined) break
        const next: string = link.parentSessionId
        if (seen.has(next)) break // cycle defense
        out.push(next)
        seen.add(next)
        cursor = next
        hops += 1
      }
      return out
    },

    size() {
      return byChild.size
    },

    clear() {
      byChild.clear()
    },
  }
}
