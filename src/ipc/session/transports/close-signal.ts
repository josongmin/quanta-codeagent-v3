import type { SessionTransportCloseInfo } from "../types"

/**
 * Once-latch fan-out backing `SessionTransport.onClose` (S4). One shared
 * implementation so every transport gets identical terminal semantics instead
 * of three hand-rolled variants drifting apart:
 *
 *  - `notify` latches the FIRST terminal info and fans it out once; every
 *    subsequent `notify` is swallowed (a socket that fires `error` then
 *    `close`, or an owner `close()` racing a child exit, must not double-fire);
 *  - a `subscribe` AFTER the latch fired invokes the handler immediately with
 *    the recorded info (late subscribers must not miss the death notice);
 *  - per-handler throws are swallowed — a misbehaving close subscriber must
 *    not poison sibling subscribers (same rule as the `onMessage` fan-outs).
 */
export interface SessionTransportCloseSignal {
  readonly closed: boolean
  subscribe(handler: (info: SessionTransportCloseInfo) => void): () => void
  notify(info: SessionTransportCloseInfo): void
}

export const createSessionTransportCloseSignal = (): SessionTransportCloseSignal => {
  const handlers = new Set<(info: SessionTransportCloseInfo) => void>()
  let terminal: SessionTransportCloseInfo | undefined

  return {
    get closed() {
      return terminal !== undefined
    },
    subscribe(handler) {
      if (terminal !== undefined) {
        const info = terminal
        try {
          handler(info)
        } catch {
          // Swallow — per-handler errors must not escape the subscribe call.
        }
        return () => {
          // Nothing to detach — the handler was invoked immediately, once.
        }
      }
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    notify(info) {
      if (terminal !== undefined) return
      terminal = info
      const snapshot = [...handlers]
      handlers.clear()
      for (const handler of snapshot) {
        try {
          handler(info)
        } catch {
          // Swallow per-handler errors to avoid poisoning sibling subscribers.
        }
      }
    },
  }
}
