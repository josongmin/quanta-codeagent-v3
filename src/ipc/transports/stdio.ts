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

/** Hard ceiling on a single un-terminated line's accumulated length. A peer
 *  that never sends a `\n` (malicious, wedged, or a half-written frame from a
 *  crashed writer) would otherwise drive `buffer` to grow without bound — a
 *  memory-exhaustion / stream-wedge DoS on the primary cross-process channel
 *  (CLI ↔ daemon). When the trailing partial exceeds this cap before a newline
 *  is seen, the transport tears itself down (`teardown("error", ...)`) and
 *  drops the buffer rather than buffering forever.
 *
 *  This is a SAFETY backstop, not a tuning knob: 32 MiB mirrors the LSP
 *  reader's `MAX_FRAME_BYTES` (`@/lsp/adapters/jsonrpc`) and is far above any
 *  legitimate IPC envelope (`WireEnvelope`s are small observation events) while
 *  still bounding the worst case. The bound is on string length (UTF-16 code
 *  units), a conservative proxy for byte length for the framing's purpose. */
const MAX_FRAME_CHARS = 32 * 1024 * 1024

/** Terminal lifecycle events on the read side (audit L9 M18b). A Node
 *  `Readable` emits `'end'` (clean EOF), `'close'` (fd released), and `'error'`
 *  (broken pipe / dead partner). We subscribe to all three so a dead peer is
 *  OBSERVED and the transport tears itself down — previously only `'data'` was
 *  wired, so a broken pipe silently dropped frames and left a half-open peer in
 *  the bridge's bookkeeping. */
type ReaderLifecycleEvent = "end" | "close" | "error"

/** Read-side port — a Node Readable narrowed to the methods we use. The port
 *  type pins ONLY the `'data'` contract so existing minimal fixtures (which
 *  emit only `'data'`) stay structurally assignable; lifecycle subscription is
 *  feature-detected at runtime against the real Node `EventEmitter` surface
 *  (a real `Readable` always has it). */
export interface StdioReader {
  on(event: "data", handler: (chunk: Buffer | string) => void): unknown
  off?(event: "data", handler: (chunk: Buffer | string) => void): unknown
  removeListener?(event: "data", handler: (chunk: Buffer | string) => void): unknown
}

/** The lifecycle-aware view we narrow to at runtime when the reader supports
 *  it (every real Node `Readable` does). */
interface LifecycleReader {
  on(event: ReaderLifecycleEvent, handler: (arg?: unknown) => void): unknown
  off?(event: ReaderLifecycleEvent, handler: (arg?: unknown) => void): unknown
  removeListener?(event: ReaderLifecycleEvent, handler: (arg?: unknown) => void): unknown
}

/** Write-side port — a Node Writable narrowed to the methods we use. */
export interface StdioWriter {
  write(chunk: string): boolean | unknown
}

export interface CreateStdioTransportOpts {
  readonly reader: StdioReader
  readonly writer: StdioWriter
  /** Terminal-event sink (audit L9 M18b). Invoked exactly ONCE when the read
   *  side ends / closes / errors (or when `close()` is called by the owner), so
   *  the bridge can REAP a half-open peer instead of leaving it wired. The
   *  `reason` distinguishes a clean EOF from a broken pipe. Optional — owners
   *  that don't reap can omit it. */
  readonly onClose?: (reason: "end" | "close" | "error" | "local", detail?: unknown) => void
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
    // Frame-size DoS guard: the trailing partial (no newline yet) must never
    // grow without bound. A peer that wedges mid-frame tears the transport
    // down instead of exhausting the daemon's heap. Checked AFTER draining
    // complete lines so a burst of many small valid frames never trips it.
    if (buffer.length > MAX_FRAME_CHARS) {
      void teardown("error", new Error("frame too large"))
    }
  }

  // Runtime view for lifecycle subscription. A real Node `Readable` always has
  // `on`/`off`; minimal `'data'`-only fixtures simply won't emit the lifecycle
  // events (so the wiring is inert for them, not wrong).
  const lifecycle = opts.reader as unknown as LifecycleReader

  // Detach helper — tolerate `off` / `removeListener` / neither (fixtures vary).
  const detachData = (): void => {
    if (typeof opts.reader.off === "function") opts.reader.off("data", onData)
    else if (typeof opts.reader.removeListener === "function")
      opts.reader.removeListener("data", onData)
  }
  const detachLifecycle = (
    event: ReaderLifecycleEvent,
    handler: (arg?: unknown) => void,
  ): void => {
    if (typeof lifecycle.off === "function") lifecycle.off(event, handler)
    else if (typeof lifecycle.removeListener === "function")
      lifecycle.removeListener(event, handler)
  }

  // Lifecycle handlers (audit L9 M18b). Any terminal read-side event tears the
  // transport down and notifies the owner so a dead partner is reaped instead
  // of leaving a half-open peer wired with frames silently dropped.
  const onEnd = (): void => {
    void teardown("end")
  }
  const onClose = (): void => {
    void teardown("close")
  }
  const onError = (detail?: unknown): void => {
    void teardown("error", detail)
  }

  const teardown = async (
    reason: "end" | "close" | "error" | "local",
    detail?: unknown,
  ): Promise<void> => {
    if (closed) return
    closed = true
    handlers.clear()
    detachData()
    detachLifecycle("end", onEnd)
    detachLifecycle("close", onClose)
    detachLifecycle("error", onError)
    buffer = ""
    opts.onClose?.(reason, detail)
  }

  opts.reader.on("data", onData)
  // 'error' on a Readable with no listener throws — wiring one is mandatory for
  // a broken pipe not to crash the process. `on` is always present on a real
  // Readable; the cast is the runtime lifecycle view.
  if (typeof lifecycle.on === "function") {
    lifecycle.on("end", onEnd)
    lifecycle.on("close", onClose)
    lifecycle.on("error", onError)
  }

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
      await teardown("local")
    },
  }
}
