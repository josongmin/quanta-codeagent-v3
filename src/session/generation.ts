/**
 * In-process session generation + tombstone (SEP7-D-05).
 *
 * Snapshot files are the durable source of truth. After delete, a late
 * autosave must not resurrect the id. A legitimate recreate passes
 * `{ create: true }` which clears the tombstone and bumps generation.
 *
 * Cross-process fencing is not claimed — receipt-exclude.
 */

const generations = new Map<string, number>()
const tombstones = new Set<string>()

export class StaleSessionGenerationError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`refusing stale save for session ${sessionId} after delete`)
    this.name = "StaleSessionGenerationError"
    this.sessionId = sessionId
  }
}

export const sessionGenerationOf = (id: string): number => generations.get(id) ?? 0

export const isSessionTombstoned = (id: string): boolean => tombstones.has(id)

export const markSessionDeleted = (id: string): void => {
  tombstones.add(id)
  generations.set(id, sessionGenerationOf(id) + 1)
}

export const admitSessionSave = (id: string, captured: number, create: boolean): void => {
  if (tombstones.has(id) && !create) {
    throw new StaleSessionGenerationError(id)
  }
  if (create) {
    tombstones.delete(id)
    generations.set(id, sessionGenerationOf(id) + 1)
    return
  }
  if (sessionGenerationOf(id) !== captured) {
    throw new StaleSessionGenerationError(id)
  }
}

/** Test-only: drop in-process generation state between cases. */
export const __resetSessionGenerationForTest = (): void => {
  generations.clear()
  tombstones.clear()
}
