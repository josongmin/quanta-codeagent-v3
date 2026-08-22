/**
 * `@/apps/web-daemon/server/persistence` — SQLite thread-persistence wiring.
 *
 * Extracted from `startWebDaemon` startup: appends every `SessionEvent` on the
 * shared session to `~/.quanta/web-daemon/threads.db` (override path via
 * `QUANTA_WEB_DB_DIR`). Disabled by `QUANTA_WEB_DB=off` (⇒ `threadStore: null`,
 * `unsubPersist: null`, byte-identical to the legacy no-persistence surface).
 */

import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateDisabled, logger } from "@/shared"
import { openThreadStore, type ThreadStore } from "../persistence-sqlite"

export interface ThreadPersistence {
  readonly threadStore: ThreadStore | null
  readonly unsubPersist: (() => void) | null
}

export const setupThreadPersistence = (sharedSession: RuntimeSession): ThreadPersistence => {
  const threadStore = gateDisabled(process.env, "QUANTA_WEB_DB") ? null : openThreadStore()
  if (threadStore === null) {
    return { threadStore: null, unsubPersist: null }
  }
  threadStore.upsertThread({ id: sharedSession.sessionId })
  const unsubPersist = sharedSession.subscribe((event) => {
    try {
      threadStore.appendEvent(sharedSession.sessionId, event)
    } catch (error) {
      logger.warn("web-daemon: sqlite append failed", {
        error: errMessage(error),
      })
    }
  })
  logger.info("web-daemon: thread persistence enabled", {
    sessionId: sharedSession.sessionId,
  })
  return { threadStore, unsubPersist }
}
