/**
 * `@/ipc/transports/in-memory` — test fixture + same-process bridge.
 *
 * Two flavors:
 *   1. `createInMemoryTransport()` — solo: send queues into the local
 *      receive handler. Useful for unit tests of `createEventBridge`.
 *   2. `createInMemoryHub() + hub.attach()` — multi-peer: many transports
 *      attach to a hub; every `send` is fanned out to every OTHER peer
 *      (not the sender). Mirrors how stdio/uds/ws work between processes.
 *
 * Both implementations are synchronous under the hood (microtask-queued)
 * so tests can `await` a single publish and observe deterministic state.
 * No real I/O — safe to import in pure unit tests.
 */

import type { BridgeTransport, WireEnvelope } from "../event-bridge"

/* ------------------------------------------------------------------ */
/* Solo transport — single-peer loopback queue.                         */
/* ------------------------------------------------------------------ */

/**
 * Solo transport: `send` immediately invokes registered `onMessage`
 * handlers. The bridge's own loopback fan-out runs BEFORE the transport
 * send, so a solo transport DOES double-deliver to local subscribers (each
 * publish lands twice). Tests that need single-delivery should use a hub.
 */
export const createInMemoryTransport = (): BridgeTransport => {
  const handlers = new Set<(envelope: WireEnvelope) => void>()
  let closed = false
  return {
    async send(envelope) {
      if (closed) return
      for (const h of [...handlers]) {
        h(envelope)
      }
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      closed = true
      handlers.clear()
    },
  }
}

/* ------------------------------------------------------------------ */
/* Hub — multi-peer fan-out.                                            */
/* ------------------------------------------------------------------ */

/**
 * An in-memory hub broadcasts every `send` from one attached transport to
 * every OTHER attached transport's receive handler — closely mimicking
 * the cross-process stdio/uds wire without spawning a real process. Useful
 * for unit tests of the publish/subscribe ROUND-TRIP across two bridges.
 *
 * A transport returned by `hub.attach()` is fully `BridgeTransport`-shaped:
 * detach happens on `close()` and is idempotent.
 */
export interface InMemoryHub {
  attach(): BridgeTransport
  /** Number of currently-attached transports. */
  readonly size: number
  /** Close every attached transport; idempotent. */
  closeAll(): Promise<void>
}

interface AttachedPeer {
  readonly handlers: Set<(envelope: WireEnvelope) => void>
  closed: boolean
}

export const createInMemoryHub = (): InMemoryHub => {
  const peers = new Set<AttachedPeer>()

  const hub: InMemoryHub = {
    get size() {
      return peers.size
    },
    attach(): BridgeTransport {
      const me: AttachedPeer = { handlers: new Set(), closed: false }
      peers.add(me)
      return {
        async send(envelope) {
          if (me.closed) return
          // Fan out to every OTHER peer — never to self. (The bridge's own
          // loopback handles self-delivery.) Snapshot before iterating so a
          // peer that closes during dispatch doesn't perturb the iteration.
          for (const peer of [...peers]) {
            if (peer === me || peer.closed) continue
            for (const h of [...peer.handlers]) {
              h(envelope)
            }
          }
        },
        onMessage(handler) {
          me.handlers.add(handler)
          return () => {
            me.handlers.delete(handler)
          }
        },
        async close() {
          if (me.closed) return
          me.closed = true
          me.handlers.clear()
          peers.delete(me)
        },
      }
    },
    async closeAll() {
      for (const peer of [...peers]) {
        peer.closed = true
        peer.handlers.clear()
      }
      peers.clear()
    },
  }

  return hub
}
