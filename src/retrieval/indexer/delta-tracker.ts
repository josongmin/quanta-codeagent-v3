/**
 * Pure delta tracker (ADR-0277).
 *
 * Maintains a `Map<path, { mtime, sha }>` of every file the indexer has
 * seen. Pure data structure — no clock, no I/O. The diff classifier
 * splits a new snapshot into (added, modified, deleted, unchanged)
 * partitions using `mtime ≠ prev.mtime || sha ≠ prev.sha` as the
 * "modified" predicate.
 *
 * mtime alone is NOT enough (some editors restore mtime), so this diff
 * treats `mtime ≠ prev || sha ≠ prev` as modified — sha is the authority.
 * The read-skipping fast path lives OUTSIDE this class: `doScan` in
 * `default-scanner.ts` keeps a per-path stat-signature cache (mtimeMs+size
 * → sha) and skips read/hash/chunk when the signature is unchanged; any
 * signature change falls through to the full sha path diffed here.
 */

export interface FileStamp {
  readonly mtime: number
  readonly sha: string
}

export interface DeltaPartition {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
  readonly unchanged: readonly string[]
}

export class DeltaTracker {
  private readonly state = new Map<string, FileStamp>()

  /** Insert / overwrite the stamp for `path`. */
  put(path: string, stamp: FileStamp): void {
    this.state.set(path, stamp)
  }

  /** Look up the stamp for `path`. */
  get(path: string): FileStamp | undefined {
    return this.state.get(path)
  }

  /** Mark `path` as deleted. */
  delete(path: string): void {
    this.state.delete(path)
  }

  /** Number of tracked files. */
  size(): number {
    return this.state.size
  }

  /** Snapshot of every tracked path (for iteration). */
  paths(): readonly string[] {
    return Array.from(this.state.keys())
  }

  /** Reset to empty. */
  clear(): void {
    this.state.clear()
  }

  /** Given a fresh snapshot (paths the scanner just produced), classify
   *  each path as added / modified / deleted / unchanged. Pure — does
   *  NOT mutate the tracker. */
  diff(snapshot: ReadonlyMap<string, FileStamp>): DeltaPartition {
    const added: string[] = []
    const modified: string[] = []
    const unchanged: string[] = []
    for (const [path, fresh] of snapshot) {
      const prev = this.state.get(path)
      if (prev === undefined) {
        added.push(path)
      } else if (prev.mtime !== fresh.mtime || prev.sha !== fresh.sha) {
        modified.push(path)
      } else {
        unchanged.push(path)
      }
    }
    const deleted: string[] = []
    for (const path of this.state.keys()) {
      if (!snapshot.has(path)) deleted.push(path)
    }
    return { added, modified, deleted, unchanged }
  }
}
