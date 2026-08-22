import type { RateLimitSnapshot } from "./parse"

/**
 * Per-route rate-limit snapshot store (last-write-wins). Pure in-memory
 * container — NO clock inside (the snapshot carries `observedAt`). An
 * `undefined` update is a NO-OP, so an unrecognized response (parser returned
 * `undefined`) does NOT clobber the last good snapshot.
 *
 * Phase 1 holds a single logical route; the surface is a closed port so a later
 * phase can key per provider+model without changing callers.
 */
export interface RateLimitSnapshotStore {
  /** Record the latest snapshot. `undefined` ⇒ no-op (keep prior value). */
  update(s: RateLimitSnapshot | undefined): void
  /** The latest non-undefined snapshot, or `undefined` if none seen. */
  current(): RateLimitSnapshot | undefined
}

export const createRateLimitSnapshotStore = (): RateLimitSnapshotStore => {
  let latest: RateLimitSnapshot | undefined
  return {
    update(s) {
      if (s !== undefined) latest = s
    },
    current() {
      return latest
    },
  }
}
