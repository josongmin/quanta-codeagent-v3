/**
 * `@/ipc/transports/websocket` — WebSocket transport (SKELETON).
 *
 * Status: **interface + dummy adapter only**. A real WebSocket server/client
 * implementation requires a library dependency (`ws` / browser `WebSocket`)
 * which is deliberately deferred to a follow-up PR. This file ships the
 * contract so the Web surface entry can target a stable port today and
 * swap implementations later.
 *
 * Wire framing: one JSON-encoded `WireEnvelope` per WebSocket message
 * (NOT line-delimited — WebSocket is already message-framed). Binary
 * payloads / fragmentation are out of scope for v1.
 *
 * The slice ships a `wrapWebSocketLikeAsTransport()` adapter that wraps any
 * `WebSocketLike` (subset of the browser/`ws` API surface we use) as a
 * `BridgeTransport`. The surface entry constructs the socket (with auth /
 * URL / TLS handled out-of-band) and passes the instance in.
 */

import type { BridgeTransport, WireEnvelope } from "../event-bridge"
import { isWireEnvelope } from "../event-bridge"

/**
 * Minimal structural subset of the `WebSocket` API we depend on. Both the
 * browser global and the `ws` Node library expose this surface — keeping
 * the slice library-agnostic.
 *
 * `addEventListener`'s handler arg is typed as a `MessageEventLike` so we
 * do not pull in DOM lib types. The `data` field is `unknown` because the
 * browser API emits `string | Blob | ArrayBuffer | ArrayBufferView`; the
 * adapter coerces to string before parsing.
 */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void
  removeEventListener?(type: "message", handler: (event: { data: unknown }) => void): void
}

/**
 * Wrap any `WebSocketLike` as a `BridgeTransport`. Inbound non-string data
 * (Blob / ArrayBuffer) is dropped — v1 is text-frame only.
 */
export const wrapWebSocketLikeAsTransport = (socket: WebSocketLike): BridgeTransport => {
  const handlers = new Set<(envelope: WireEnvelope) => void>()
  let closed = false

  const onMessage = (event: { data: unknown }): void => {
    if (closed) return
    if (typeof event.data !== "string") return // binary frames not supported in v1
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (!isWireEnvelope(parsed)) return
    for (const h of [...handlers]) {
      try {
        h(parsed)
      } catch {
        // Swallow — see fanOut comment in event-bridge.ts.
      }
    }
  }

  socket.addEventListener("message", onMessage)

  return {
    async send(envelope) {
      if (closed) return
      socket.send(JSON.stringify(envelope))
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    async close() {
      if (closed) return
      closed = true
      handlers.clear()
      if (typeof socket.removeEventListener === "function") {
        socket.removeEventListener("message", onMessage)
      }
      try {
        socket.close()
      } catch {
        // Swallow — already-closed sockets throw on some impls.
      }
    },
  }
}

/**
 * Placeholder factory for a server-side WebSocket transport. A real
 * implementation will open a listener and accept the first inbound
 * connection (or N connections multiplexed). Intentionally throws so a
 * caller that wires this prematurely fails loud, not silent.
 */
export const createWebSocketServerTransport = (): BridgeTransport => {
  throw new Error(
    "websocket server transport: skeleton-only in this PR. " +
      "Use wrapWebSocketLikeAsTransport(socket) with an existing socket, " +
      "or wait for the follow-up PR that wires `ws` (or the platform global).",
  )
}
