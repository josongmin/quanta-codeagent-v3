import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "../codec"
import type { SessionTransport, SessionTransportHandler } from "../types"
import { createSessionTransportCloseSignal } from "./close-signal"

/** Hard ceiling on a single un-terminated line's accumulated length. A peer
 *  that never sends a `\n` (malicious, wedged, or a half-written frame from a
 *  crashed writer) would otherwise drive `buffer` to grow without bound — a
 *  memory-exhaustion / stream-wedge DoS on the session channel. When the
 *  trailing partial exceeds this cap before a newline is seen, the transport
 *  tears itself down and drops the buffer rather than buffering forever.
 *
 *  This is a SAFETY backstop, not a tuning knob: 32 MiB mirrors the LSP
 *  reader's `MAX_FRAME_BYTES` (`@/lsp/adapters/jsonrpc`) and the sibling
 *  `@/ipc/transports/stdio` cap, far above any legitimate session frame while
 *  still bounding the worst case. The bound is on string length (UTF-16 code
 *  units), a conservative proxy for byte length for the framing's purpose. */
const MAX_FRAME_CHARS = 32 * 1024 * 1024

/** Read-side port — deliberately `data`-only. Reader LIFECYCLE events
 *  (`end` / `close` / `error`, i.e. EOF semantics) are intentionally NOT part
 *  of this port and NOT wired by the transport: keeping the port minimal keeps
 *  every existing fixture structurally assignable, and EOF semantics belong to
 *  ticket 02 (`serve --stdio`). Process-death liveness for spawn-owned
 *  children is covered by `./stdio-spawn` via child-exit instead. What IS
 *  notified here (S4): owner `close()`, a throwing writer (broken pipe), and
 *  the frame-cap wedge-guard teardown — all via `onClose`. */
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
  const closeSignal = createSessionTransportCloseSignal()
  let closed = false
  let buffer = ""

  // Single teardown path — detaches the read listener, clears handlers, drops
  // the buffer, latches the S4 close notification, and is idempotent (the
  // once-latch keeps the FIRST reason). Shared by `close()` (owner-initiated),
  // a throwing writer (broken pipe), and the frame-size DoS guard (a wedged
  // peer must be reaped the same way).
  const teardown = (reason: string): void => {
    if (!closed) {
      closed = true
      handlers.clear()
      if (typeof opts.reader.off === "function") {
        opts.reader.off("data", onData)
      } else if (typeof opts.reader.removeListener === "function") {
        opts.reader.removeListener("data", onData)
      }
      buffer = ""
    }
    closeSignal.notify({ reason })
  }

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
    // Frame-size DoS guard: the trailing partial (no newline yet) must never
    // grow without bound. A peer that wedges mid-frame tears the transport
    // down instead of exhausting the heap. Checked AFTER draining complete
    // lines so a burst of many small valid frames never trips it.
    if (buffer.length > MAX_FRAME_CHARS) teardown("frame_too_large")
  }

  opts.reader.on("data", onData)

  return {
    async send(message) {
      if (closed) return
      try {
        opts.writer.write(`${encodeSessionTransportMessage(message)}\n`)
      } catch (error) {
        // A throwing writer is a dead peer (EPIPE-class). Tear down and notify
        // the liveness channel, then rethrow so the caller-visible rejection
        // behavior is exactly what it was pre-S4.
        const detail = error instanceof Error ? error.message : String(error)
        teardown(`writer_error (${detail})`)
        throw error
      }
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
      teardown("local_close")
    },
  }
}
