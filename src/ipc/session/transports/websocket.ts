import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "../codec"
import type { SessionTransport, SessionTransportHandler } from "../types"

export interface SessionWebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void
  removeEventListener?(type: "message", handler: (event: { data: unknown }) => void): void
}

const dispatch = (handlers: Set<SessionTransportHandler>, payload: unknown): void => {
  if (typeof payload !== "string") return
  const message = tryDecodeSessionTransportMessage(payload)
  if (message === undefined) return
  for (const handler of [...handlers]) {
    try {
      const result = handler(message)
      if (result instanceof Promise) {
        void result.catch(() => undefined)
      }
    } catch {
      // Swallow per-handler errors to avoid poisoning sibling subscribers.
    }
  }
}

export const wrapWebSocketLikeAsSessionTransport = (
  socket: SessionWebSocketLike,
): SessionTransport => {
  const handlers = new Set<SessionTransportHandler>()
  let closed = false

  const onMessage = (event: { data: unknown }): void => {
    if (closed) return
    dispatch(handlers, event.data)
  }

  socket.addEventListener("message", onMessage)

  return {
    async send(message) {
      if (closed) return
      socket.send(encodeSessionTransportMessage(message))
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
        // Some implementations throw on close-after-close.
      }
    },
  }
}
