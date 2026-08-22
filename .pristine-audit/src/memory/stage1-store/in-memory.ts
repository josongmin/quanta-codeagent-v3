/**
 * ADR-0207 — Map-backed default `Stage1OutputsStore`.
 *
 * Sync, in-process, no I/O. Used by tests and as the dev default until
 * a caller opts into the jsonl-file adapter. Insertion order is the
 * iteration order for `list()` (per Map spec).
 *
 * Clock injection: `now: () => number` is mandatory so tests can pin
 * `lastUsage`. Production callers pass `Date.now`.
 *
 * Closed-port DIP: this impl is the contract reference for the port
 * — every assertion in `Stage1OutputsStore` JSDoc is validated here
 * first; the jsonl-file impl is a faithful superset (adds persistence).
 */

import type { Stage1ListFilter, Stage1OutputsStore, Stage1PruneOpts } from "./port"
import type { Stage1Entry } from "./types"

const freezeEntry = (e: Stage1Entry): Stage1Entry => Object.freeze({ ...e })

const matches = (e: Stage1Entry, f: Stage1ListFilter | undefined): boolean => {
  if (f === undefined) return true
  if (f.selectedForPhase2 !== undefined && e.selectedForPhase2 !== f.selectedForPhase2) {
    return false
  }
  if (f.minUsage !== undefined && e.usageCount < f.minUsage) return false
  return true
}

export interface InMemoryStage1StoreOpts {
  readonly now: () => number
}

export class InMemoryStage1Store implements Stage1OutputsStore {
  // eslint-disable-next-line no-restricted-syntax — internal mutable state
  private readonly entries = new Map<string, Stage1Entry>()
  private readonly now: () => number

  constructor(opts: InMemoryStage1StoreOpts) {
    this.now = opts.now
  }

  get(threadId: string): Stage1Entry | null {
    const found = this.entries.get(threadId)
    return found ?? null
  }

  put(entry: Stage1Entry): void {
    // Replace under threadId (PK semantics). Freeze on the way in so
    // the stored reference cannot be mutated through an outer alias.
    this.entries.set(entry.threadId, freezeEntry(entry))
  }

  touch(threadId: string): void {
    const cur = this.entries.get(threadId)
    if (!cur) return
    const next: Stage1Entry = freezeEntry({
      ...cur,
      usageCount: cur.usageCount + 1,
      lastUsage: this.now(),
    })
    this.entries.set(threadId, next)
  }

  markSelectedForPhase2(threadId: string, sourceUpdatedAt: number): void {
    const cur = this.entries.get(threadId)
    if (!cur) return
    // Conditional-spread to respect `exactOptionalPropertyTypes`: we
    // never assign `undefined` to the snapshot field. Replacing an
    // entry that already carries a snapshot is fine — the new value
    // overwrites the old.
    const next: Stage1Entry = freezeEntry({
      ...cur,
      selectedForPhase2: true,
      selectedForPhase2SourceUpdatedAt: sourceUpdatedAt,
    })
    this.entries.set(threadId, next)
  }

  list(filter?: Stage1ListFilter): readonly Stage1Entry[] {
    const out: Stage1Entry[] = []
    for (const e of this.entries.values()) {
      if (matches(e, filter)) out.push(e)
    }
    return Object.freeze(out)
  }

  prune(opts: Stage1PruneOpts): number {
    let evicted = 0
    const { olderThanMs, maxEntries } = opts
    if (olderThanMs === undefined && maxEntries === undefined) return 0

    if (olderThanMs !== undefined) {
      const cutoff = this.now() - olderThanMs
      for (const [id, e] of this.entries) {
        if (e.generatedAt < cutoff) {
          this.entries.delete(id)
          evicted++
        }
      }
    }

    if (maxEntries !== undefined && this.entries.size > maxEntries) {
      // LRU eviction: ascending `lastUsage` (oldest-used first).
      const sorted = [...this.entries.entries()].sort(([, a], [, b]) => a.lastUsage - b.lastUsage)
      const dropCount = this.entries.size - maxEntries
      for (let i = 0; i < dropCount; i++) {
        const row = sorted[i]
        if (!row) break
        this.entries.delete(row[0])
        evicted++
      }
    }

    return evicted
  }
}
