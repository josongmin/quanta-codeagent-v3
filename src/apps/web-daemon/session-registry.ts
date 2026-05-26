/**
 * `@/apps/web-daemon/session-registry` — active session bookkeeping.
 *
 * Tracks the `RuntimeSession + attached transport` pair for each connected
 * WebSocket. The registry guarantees:
 *   1. Idempotent eviction — `evict(ws)` is safe to call from both the
 *      WS `close` callback and the daemon shutdown path.
 *   2. Bounded cleanup — `closeAll()` awaits every per-session shutdown so
 *      the daemon does not race the OS into killing in-flight work.
 *   3. No-throw on partial failure — a stuck `transport.close()` MUST NOT
 *      starve the rest of the eviction loop.
 */

import type { ConnectedSessionTransport, SessionTransport } from "@/ipc/session"
import type { RuntimeSession } from "@/sdk/runtime"

export interface RegisteredSession {
  readonly session: RuntimeSession
  readonly transport: SessionTransport
  readonly connected: ConnectedSessionTransport
}

export interface SessionRegistry {
  add(key: object, entry: RegisteredSession): void
  has(key: object): boolean
  size(): number
  evict(key: object): Promise<void>
  closeAll(): Promise<void>
}

const safeClose = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn()
  } catch {
    // Per `closeAll` contract: a single failing close MUST NOT abort the
    // sibling shutdowns. The daemon's caller logs at the outer layer.
    void label
  }
}

export const createSessionRegistry = (): SessionRegistry => {
  const entries = new Map<object, RegisteredSession>()

  const drop = async (entry: RegisteredSession): Promise<void> => {
    // Per-WS cleanup only — close the transport pair so the WebSocket
    // half of the bridge frees its buffers. `entry.session` is shared
    // across all WS clients (multi-client mode); closing it here would
    // kill the shared transcript whenever any one client disconnects.
    // The daemon's `stop()` path closes the runtime exactly once.
    await safeClose("connected", () => entry.connected.close())
    await safeClose("transport", () => entry.transport.close())
  }

  return {
    add(key, entry) {
      entries.set(key, entry)
    },
    has(key) {
      return entries.has(key)
    },
    size() {
      return entries.size
    },
    async evict(key) {
      const entry = entries.get(key)
      if (entry === undefined) return
      entries.delete(key)
      await drop(entry)
    },
    async closeAll() {
      const all = [...entries.values()]
      entries.clear()
      await Promise.all(all.map(drop))
    },
  }
}
