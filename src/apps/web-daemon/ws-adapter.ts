/**
 * `@/apps/web-daemon/ws-adapter` — Bun ServerWebSocket → SessionWebSocketLike.
 *
 * Bun's `ServerWebSocket` exposes `send(data)` / `close(code, reason)` but
 * NO `addEventListener` / `removeEventListener` — incoming frames are
 * delivered via the `websocket.message(ws, message)` callback registered on
 * `Bun.serve`. The adapter routes those server-side callbacks into the
 * `addEventListener("message", ...)` shape that `wrapWebSocketLikeAsSessionTransport`
 * expects, so the existing IPC slice works unchanged.
 *
 * One adapter per connected socket. The server holds a `Map<ws, adapter>`
 * and dispatches `message` / `close` callbacks into the right adapter; the
 * adapter then fans the frame out to all subscribed listeners.
 */

import type { SessionWebSocketLike } from "@/ipc/session"

/**
 * Minimal subset of Bun's `ServerWebSocket` we depend on. Typing the surface
 * (rather than importing `bun-types`'s `ServerWebSocket<T>` directly) keeps
 * the adapter testable from in-memory fakes — every test below uses this
 * interface verbatim.
 */
export interface BunServerWebSocketLike {
  send(data: string | Uint8Array): number
  close(code?: number, reason?: string): void
}

type MessageHandler = (event: { data: unknown }) => void

/**
 * Bun-WS adapter. Exposes:
 *   - `socket`: the `SessionWebSocketLike` to pass into
 *     `wrapWebSocketLikeAsSessionTransport`.
 *   - `pushMessage(raw)`: server-side push — the Bun.serve `message`
 *     callback calls this with the inbound frame.
 *   - `handleClose()`: server-side close — Bun.serve `close` callback calls
 *     this so subscribers stop receiving frames and the underlying socket
 *     is not double-closed.
 */
export interface BunWebSocketAdapter {
  readonly socket: SessionWebSocketLike
  pushMessage(raw: string | Uint8Array | ArrayBuffer): void
  handleClose(): void
}

const toFrameString = (raw: string | Uint8Array | ArrayBuffer): string | undefined => {
  if (typeof raw === "string") return raw
  if (raw instanceof Uint8Array) {
    // Bun delivers binary frames as Uint8Array. v1 is text-frame only;
    // decode UTF-8 best-effort so a client that uses `.send(<binary>)` to
    // ship JSON still works. Non-UTF8 bytes throw inside TextDecoder
    // (`fatal: true`) — we treat that as an undecodable frame and drop it.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw)
    } catch {
      return undefined
    }
  }
  if (raw instanceof ArrayBuffer) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(raw))
    } catch {
      return undefined
    }
  }
  return undefined
}

export const createBunWebSocketAdapter = (ws: BunServerWebSocketLike): BunWebSocketAdapter => {
  const listeners = new Set<MessageHandler>()
  /**
   * Pre-listener buffer. The Bun.serve `open` callback registers the message
   * listener via `await buildRegisteredSession(...)` — an async sequence
   * that may not complete before the client's first frame arrives. Without
   * this buffer, the `connect` handshake frame is silently dropped by
   * `pushMessage` (fan-out finds an empty listener set), and the daemon
   * appears mute. Frames received before the first listener is added land
   * here; they are flushed in subscription order when `addEventListener`
   * registers a handler.
   */
  const pendingFrames: string[] = []
  let closed = false

  const socket: SessionWebSocketLike = {
    send(data) {
      if (closed) return
      ws.send(data)
    },
    close(code, reason) {
      if (closed) return
      closed = true
      listeners.clear()
      pendingFrames.length = 0
      try {
        ws.close(code, reason)
      } catch {
        // Bun throws if the socket is already-closed on some upgrade paths.
      }
    },
    addEventListener(type, handler) {
      if (type !== "message" || closed) return
      const wasEmpty = listeners.size === 0
      listeners.add(handler)
      if (wasEmpty && pendingFrames.length > 0) {
        // Drain in arrival order. Snapshot + clear first so re-entrant
        // dispatch (handler that adds more listeners) doesn't double-flush.
        const drain = pendingFrames.splice(0, pendingFrames.length)
        for (const text of drain) {
          try {
            handler({ data: text })
          } catch {
            // swallow per fan-out rule
          }
        }
      }
    },
    removeEventListener(type, handler) {
      if (type !== "message") return
      listeners.delete(handler)
    },
  }

  return {
    socket,
    pushMessage(raw) {
      if (closed) return
      const text = toFrameString(raw)
      if (text === undefined) return
      if (listeners.size === 0) {
        // No listener yet — buffer until `addEventListener` lands.
        pendingFrames.push(text)
        return
      }
      // Snapshot before fan-out: a listener that unsubscribes mid-iteration
      // (e.g. transport.close()) must not perturb the loop.
      for (const handler of [...listeners]) {
        try {
          handler({ data: text })
        } catch {
          // A misbehaving subscriber MUST NOT poison sibling subscribers
          // (matches the swallow rule in @/ipc/event-bridge#fanOut).
        }
      }
    },
    handleClose() {
      if (closed) return
      closed = true
      listeners.clear()
      pendingFrames.length = 0
    },
  }
}
