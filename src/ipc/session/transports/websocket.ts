import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "../codec"
import type { SessionTransport, SessionTransportHandler } from "../types"
import { createSessionTransportCloseSignal } from "./close-signal"

/**
 * Required socket surface. Implementations MAY additionally dispatch `close`
 * and `error` events by name (every real WHATWG/Bun `WebSocket` does) — the
 * wrap subscribes to them for the S4 liveness channel via the runtime
 * lifecycle view below. The extension is deliberately NOT part of this
 * required interface so every existing message-only fake stays structurally
 * assignable; a fake that routes events MUST guard on the event name (all
 * in-tree fakes and the web-daemon `ws-adapter` already do), which makes the
 * lifecycle registration a harmless no-op against message-only sockets.
 */
export interface SessionWebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void
  removeEventListener?(type: "message", handler: (event: { data: unknown }) => void): void
}

/** Runtime lifecycle view (S4) — the OPTIONAL close/error capability of a
 *  `SessionWebSocketLike`. Mirrors the `LifecycleReader` pattern of
 *  `@/ipc/transports/stdio`: the required port stays minimal, the richer
 *  surface is reached through a runtime cast and stays inert when the socket
 *  never emits these events. */
interface SessionWebSocketLifecycleView {
  addEventListener(type: "close" | "error", handler: (event?: unknown) => void): void
  removeEventListener?(type: "close" | "error", handler: (event?: unknown) => void): void
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

/** Render a WHATWG `CloseEvent`-ish payload into a diagnostic reason slug. */
const describeSocketClose = (event: unknown): string => {
  if (typeof event === "object" && event !== null) {
    const { code, reason } = event as { code?: unknown; reason?: unknown }
    const parts: string[] = []
    if (typeof code === "number") parts.push(`code=${code}`)
    if (typeof reason === "string" && reason.length > 0) parts.push(`reason=${reason}`)
    if (parts.length > 0) return `socket_close (${parts.join(" ")})`
  }
  return "socket_close"
}

/** Render an error event/Error into a diagnostic reason slug. */
const describeSocketError = (event: unknown): string => {
  if (event instanceof Error && event.message.length > 0) return `socket_error (${event.message})`
  if (typeof event === "object" && event !== null) {
    const message = (event as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return `socket_error (${message})`
  }
  return "socket_error"
}

export const wrapWebSocketLikeAsSessionTransport = (
  socket: SessionWebSocketLike,
): SessionTransport => {
  const handlers = new Set<SessionTransportHandler>()
  const closeSignal = createSessionTransportCloseSignal()
  let closed = false

  const onMessage = (event: { data: unknown }): void => {
    if (closed) return
    dispatch(handlers, event.data)
  }

  const lifecycle = socket as unknown as SessionWebSocketLifecycleView

  // Single detach path — message + lifecycle listeners together, tolerant of
  // sockets without `removeEventListener` (the listeners stay registered but
  // every entry point is `closed`-guarded / once-latched, so they are inert).
  const detachListeners = (): void => {
    if (typeof socket.removeEventListener === "function") {
      socket.removeEventListener("message", onMessage)
    }
    if (typeof lifecycle.removeEventListener === "function") {
      lifecycle.removeEventListener("close", onSocketClose)
      lifecycle.removeEventListener("error", onSocketError)
    }
  }

  // Involuntary terminal transition (peer death): the socket fired close/error.
  // Marks the transport dead, drops subscribers/listeners, and latches the
  // reason — the first terminal event wins, an error-then-close sequence (the
  // typical real WS death) notifies exactly once.
  const onTerminalSocketEvent = (reason: string): void => {
    if (!closed) {
      closed = true
      handlers.clear()
      detachListeners()
    }
    closeSignal.notify({ reason })
  }

  const onSocketClose = (event?: unknown): void => {
    onTerminalSocketEvent(describeSocketClose(event))
  }
  const onSocketError = (event?: unknown): void => {
    onTerminalSocketEvent(describeSocketError(event))
  }

  socket.addEventListener("message", onMessage)
  // S4 liveness: hear about peer death. Registration is a no-op against
  // message-only sockets (their addEventListener guards on the event name).
  lifecycle.addEventListener("close", onSocketClose)
  lifecycle.addEventListener("error", onSocketError)

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
    onClose(handler) {
      return closeSignal.subscribe(handler)
    },
    async close() {
      if (closed) return
      closed = true
      handlers.clear()
      detachListeners()
      try {
        socket.close()
      } catch {
        // Some implementations throw on close-after-close.
      }
      closeSignal.notify({ reason: "local_close" })
    },
  }
}
