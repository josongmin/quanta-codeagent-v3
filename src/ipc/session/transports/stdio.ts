import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "../codec"
import type { SessionTransport, SessionTransportHandler } from "../types"

export interface StdioReader {
  on(event: "data", handler: (chunk: Buffer | string) => void): unknown
  off?(event: "data", handler: (chunk: Buffer | string) => void): unknown
  removeListener?(event: "data", handler: (chunk: Buffer | string) => void): unknown
}

export interface StdioWriter {
  write(chunk: string): boolean | unknown
}

export interface CreateSessionStdioTransportOpts {
  readonly reader: StdioReader
  readonly writer: StdioWriter
}

const dispatch = (handlers: Set<SessionTransportHandler>, raw: string): void => {
  const message = tryDecodeSessionTransportMessage(raw)
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

export const createSessionStdioTransport = (
  opts: CreateSessionStdioTransportOpts,
): SessionTransport => {
  const handlers = new Set<SessionTransportHandler>()
  let closed = false
  let buffer = ""

  const onData = (chunk: Buffer | string): void => {
    if (closed) return
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      dispatch(handlers, line)
      nl = buffer.indexOf("\n")
    }
  }

  opts.reader.on("data", onData)

  return {
    async send(message) {
      if (closed) return
      opts.writer.write(`${encodeSessionTransportMessage(message)}\n`)
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
      if (typeof opts.reader.off === "function") {
        opts.reader.off("data", onData)
      } else if (typeof opts.reader.removeListener === "function") {
        opts.reader.removeListener("data", onData)
      }
      buffer = ""
    },
  }
}
