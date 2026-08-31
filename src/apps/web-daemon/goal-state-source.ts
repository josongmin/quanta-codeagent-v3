import {
  encodeGoalStateFrame,
  type GoalReadoutData,
  type GoalStateMessage,
} from "@/protocol/readout"

export interface GoalStateSource {
  latest(): GoalStateMessage | null
  subscribe(handler: (message: GoalStateMessage) => void): () => void
  refresh(): Promise<boolean>
  stop(): void
}

/**
 * Default-ON Goal projection cache. The authority/readout encoder remains the
 * source of truth; this object only deduplicates and replays the latest typed
 * projection to sockets. Refreshes serialize so an older async freshness read
 * can never overwrite a newer one.
 */
export const createGoalStateSource = (args: {
  readonly read: () => Promise<GoalReadoutData>
  readonly now?: () => number
}): GoalStateSource => {
  const subscribers = new Set<(message: GoalStateMessage) => void>()
  const now = args.now ?? Date.now
  let current: GoalStateMessage | null = null
  let currentKey = ""
  let stopped = false
  let refreshing: Promise<boolean> | null = null
  let refreshAgain = false

  const runRefresh = async (): Promise<boolean> => {
    let changed = false
    do {
      refreshAgain = false
      const state = await args.read()
      if (stopped) return changed
      const key = JSON.stringify(state)
      if (key === currentKey) continue
      currentKey = key
      current = { kind: "goal.state", emittedAt: now(), state }
      changed = true
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(current)
        } catch {
          // A failed socket/panel is not projection authority.
        }
      }
    } while (refreshAgain)
    return changed
  }

  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false)
    if (refreshing !== null) {
      refreshAgain = true
      return refreshing
    }
    refreshing = runRefresh().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  return {
    latest: () => current,
    subscribe: (handler) => {
      subscribers.add(handler)
      if (current !== null) {
        try {
          handler(current)
        } catch {
          // Late replay is best-effort for this subscriber only.
        }
      }
      return () => subscribers.delete(handler)
    },
    refresh,
    stop: () => {
      stopped = true
      subscribers.clear()
    },
  }
}

export const attachGoalStateSink = (
  send: (frame: string) => void,
  source: GoalStateSource | undefined,
): (() => void) | null => {
  if (source === undefined) return null
  return source.subscribe((message) => {
    try {
      send(encodeGoalStateFrame(message))
    } catch {
      // Dead sockets do not destabilize the daemon.
    }
  })
}
