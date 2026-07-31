/** Minimal, correct Content-Length framed JSON-RPC 2.0 codec for LSP stdio.
 *
 *  The single hardest correctness risk in an LSP client is the stream framing:
 *  a server may flush several messages in one chunk, or split a single message
 *  (even its header) across many chunks. {@link MessageReader} owns a byte
 *  buffer and only emits a message once the full `Content-Length` body bytes
 *  have arrived, so partial reads and coalesced messages are both handled. */

/** Raw JSON-RPC message shapes we care about. The LSP spec defines far more,
 *  but for a diagnostics round-trip we only distinguish responses (by `id`)
 *  from notifications (by `method`). Anything else is ignored by callers. */
export type JsonRpcMessage =
  | JsonRpcResponse
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

const HEADER_SEPARATOR = "\r\n\r\n"
const CONTENT_LENGTH_RE = /content-length:\s*(\d+)/i

/** Hard ceiling on a single framed message body. A buggy or hostile server can
 *  declare an arbitrarily large `Content-Length` (or never send the header
 *  separator), which would otherwise make {@link MessageReader} buffer
 *  unbounded bytes forever — a memory-exhaustion / stream-wedge DoS. Mirrors
 *  the MCP `MAX_RESULT_CHARS` (200k) cap in spirit; 32 MiB is far above any
 *  legitimate LSP response (whole-file symbol trees, large hovers) while still
 *  bounding the worst case. An over-cap frame is dropped, not buffered. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** Cap on header-block bytes accumulated before the `\r\n\r\n` separator. A
 *  server that streams an endless header (no separator) must not grow the
 *  buffer without bound. 64 KiB is generous for `Content-Length` + any extra
 *  headers an LSP server might send. */
const MAX_HEADER_BYTES = 64 * 1024

/** S15: strict JSON-RPC 2.0 envelope validator. Spec requires `jsonrpc:"2.0"`
 *  on every message; accepting any parseable JSON as a message let a buggy or
 *  hostile server inject id-spoofed responses or wedge the dispatcher. */
const isValidEnvelope = (m: unknown): m is JsonRpcMessage => {
  if (typeof m !== "object" || m === null) return false
  const o = m as Record<string, unknown>
  if (o.jsonrpc !== "2.0") return false
  const hasId = "id" in o
  const hasMethod = "method" in o
  if (!hasId && !hasMethod) return false
  if (hasId) {
    const id = o.id
    if (typeof id !== "string" && typeof id !== "number") return false
  }
  if (hasMethod && typeof o.method !== "string") return false
  return true
}

/** Encode a JSON value into a single Content-Length framed buffer. */
export const encodeMessage = (payload: unknown): Uint8Array => {
  const json = JSON.stringify(payload)
  const body = new TextEncoder().encode(json)
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}${HEADER_SEPARATOR}`)
  const framed = new Uint8Array(new ArrayBuffer(header.byteLength + body.byteLength))
  framed.set(header, 0)
  framed.set(body, header.byteLength)
  return framed
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(a.byteLength + b.byteLength))
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

const findHeaderEnd = (buf: Uint8Array): number => {
  // Search for the CRLFCRLF that terminates the header block.
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i
    }
  }
  return -1
}

/** Accumulates raw bytes and yields fully-received JSON-RPC messages. */
export class MessageReader {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
  private readonly decoder = new TextDecoder()
  /** Bytes still to be discarded from an over-cap frame's body. While > 0 the
   *  reader is in "resync" mode: it throws away exactly the declared body
   *  length so the stream stays frame-aligned for the next valid message
   *  instead of desyncing. */
  private discardRemaining = 0

  /** Feed a freshly-read chunk; returns every complete message now available
   *  (zero, one, or many — coalesced server flushes are split here). Bytes for
   *  a not-yet-complete message stay buffered for the next call. */
  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.buffer = concat(this.buffer, chunk)
    const out: JsonRpcMessage[] = []
    let next = this.tryParseOne()
    while (next) {
      out.push(next)
      next = this.tryParseOne()
    }
    return out
  }

  private tryParseOne(): JsonRpcMessage | null {
    // Drain any pending over-cap body bytes before looking for a new header,
    // so the stream realigns to the next frame rather than desyncing.
    if (this.discardRemaining > 0) {
      const drop = Math.min(this.discardRemaining, this.buffer.byteLength)
      this.buffer = this.buffer.subarray(drop)
      this.discardRemaining -= drop
      if (this.discardRemaining > 0) return null
    }

    const headerEnd = findHeaderEnd(this.buffer)
    if (headerEnd < 0) {
      // No separator yet. Guard against an unbounded header: a server that
      // never sends `\r\n\r\n` must not grow the buffer forever.
      if (this.buffer.byteLength > MAX_HEADER_BYTES) {
        this.buffer = this.buffer.subarray(this.buffer.byteLength)
      }
      return null
    }

    const headerText = this.decoder.decode(this.buffer.subarray(0, headerEnd))
    const match = CONTENT_LENGTH_RE.exec(headerText)
    if (!match || match[1] === undefined) {
      // Malformed header — drop it so a poisoned stream cannot wedge us.
      this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length)
      return null
    }

    const contentLength = Number(match[1])
    const bodyStart = headerEnd + HEADER_SEPARATOR.length

    // Frame-size DoS guard: an over-cap declared length is never buffered.
    // Skip the header now and discard the declared body as it streams in.
    if (contentLength > MAX_FRAME_BYTES) {
      const afterHeader = this.buffer.subarray(bodyStart)
      const drop = Math.min(contentLength, afterHeader.byteLength)
      this.buffer = afterHeader.subarray(drop)
      this.discardRemaining = contentLength - drop
      return null
    }

    if (this.buffer.byteLength < bodyStart + contentLength) return null

    const bodyBytes = this.buffer.subarray(bodyStart, bodyStart + contentLength)
    const bodyText = this.decoder.decode(bodyBytes)
    this.buffer = this.buffer.subarray(bodyStart + contentLength)

    try {
      const parsed = JSON.parse(bodyText) as unknown
      // S15: never cast to JsonRpcMessage without envelope validation.
      // Reject anything that doesn't carry `jsonrpc:"2.0"` + a usable id/method.
      return isValidEnvelope(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}
