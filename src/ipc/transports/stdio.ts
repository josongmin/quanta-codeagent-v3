/**
 * `@/ipc/transports/stdio` — line-delimited JSON over a Node-stream pair.
 *
 * Wire format: one `WireEnvelope` per line, JSON-encoded, terminated by
 * `\n`. Lines that do not parse to a valid `WireEnvelope` are dropped
 * silently — a misbehaving peer must not crash the bridge. The slice is
 * surface-agnostic: the factory takes Node-stream-shaped PORTS
 * (`StdioReader` / `StdioWriter`) rather than reading `process.stdin` /
 * `process.stdout` directly. The CLI surface entry wires the real Node
 * streams in; tests inject pipe fixtures.
 *
 * Rationale: `@/ipc` is the surface that legitimately owns stdio framing
 * (CLI ↔ daemon), but the framing logic itself is surface-agnostic and
 * reusable by Tauri's sidecar / a remote-control daemon / etc.
 */

import type { BridgeTransport, WireEnvelope } from "../event-bridge"
import { isWireEnvelope } from "../event-bridge"

/** Read-side port — a Node Readable narrowed to the methods we use. */
export interface StdioReader {
  on(event: "data", handler: (chunk: Buffer | string) => void): unknown
  off?(event: "data", handler: (chunk: Buffer | string) => void): unknown
  removeListener?(event: "data", handler: (chunk: Buffer | string) => void): unknown
}

/** Write-side port — a Node Writable narrowed to the methods we use. */
export interface StdioWriter {
  write(chunk: string): boolean | unknown
}

export interface CreateStdioTransportOpts {
  readonly reader: StdioReader
  readonly writer: StdioWriter
}

/**
 * Build a `BridgeTransport` over a reader/writer pair. The transport
 * line-buffers incoming bytes and parses each terminated line as JSON; an
 * envelope that fails `isWireEnvelope` is dropped. `send` JSON-stringifies
 * the envelope and appends a single `\n`.
 *
 * Backpressure: writes are fire-and-forget. A Node `Writable` returns
 * `false` from `write` to signal backpressure but we don't await drain
 * here — bridge publishes are observation events, not bulk transfer. A
 * future PR can add a drain port if the daemon needs it.
 */
/** Try to parse one line into a `WireEnvelope`. Returns `undefined` on
 *  malformed JSON or shape mismatch — caller drops. */
const tryDecodeLine = (line: string): WireEnvelope | undefined => {
  if (line.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isWireEnvelope(parsed) ? parsed : undefined
}

/** Fan an envelope out to every handler in `set`, swallowing per-handler
 *  errors (a misbehaving subscriber must not poison peers). */
const dispatchToHandlers = (
  envelope: WireEnvelope,
  set: Set<(envelope: WireEnvelope) => void>,
): void => {
  for (const h of [...set]) {
    try {
      h(envelope)
    } catch {
      // Swallow — see fanOut comment in event-bridge.ts.
    }
  }
}

export const createStdioTransport = (opts: CreateStdioTransportOpts): BridgeTransport => {
  const handlers = new Set<(envelope: WireEnvelope) => void>()
  let closed = false
  let buffer = ""

  const onData = (chunk: Buffer | string): void => {
    if (closed) return
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    // Slice off complete lines; keep the trailing partial.
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const envelope = tryDecodeLine(line)
      if (envelope !== undefined) dispatchToHandlers(envelope, handlers)
      nl = buffer.indexOf("\n")
    }
  }

  opts.reader.on("data", onData)

  return {
    async send(envelope) {
      if (closed) return
      const line = `${JSON.stringify(envelope)}\n`
      opts.writer.write(line)
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
      // Best-effort detach — both `off` and `removeListener` are valid
      // Node Readable APIs; we tolerate either or none (test fixtures
      // sometimes omit both).
      if (typeof opts.reader.off === "function") {
        opts.reader.off("data", onData)
      } else if (typeof opts.reader.removeListener === "function") {
        opts.reader.removeListener("data", onData)
      }
      buffer = ""
    },
  }
}
